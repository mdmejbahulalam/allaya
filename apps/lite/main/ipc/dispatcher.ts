import { AllayaError, nullLogger, toSerializedError, type Logger } from '@allaya/shared';
import type { z } from 'zod';
import {
  envelopeSchema,
  INVOKE_CHANNELS,
  invokeContract,
  isInvokeChannel,
  type InvokeChannel,
  type IpcResult,
} from '../../shared/ipc';

type Output<C extends InvokeChannel> = z.input<(typeof invokeContract)[C]['response']>;
export type Handler<C extends InvokeChannel> = (
  request: z.output<(typeof invokeContract)[C]['request']>,
) => Promise<Output<C>> | Output<C>;

/** The handler for each channel. Startup checks that none is missing. */
export class Handlers {
  private readonly map = new Map<InvokeChannel, Handler<InvokeChannel>>();

  register<C extends InvokeChannel>(channel: C, handler: Handler<C>): this {
    if (this.map.has(channel)) throw new Error(`Two handlers for ${channel}`);
    this.map.set(channel, handler);
    return this;
  }
  get(channel: InvokeChannel): Handler<InvokeChannel> | undefined {
    return this.map.get(channel);
  }
  assertComplete(): void {
    const missing = INVOKE_CHANNELS.filter((c) => !this.map.has(c));
    if (missing.length > 0) throw new Error(`No handler for: ${missing.join(', ')}`);
  }
}

export interface Sender {
  id: number;
  frameUrl: string;
  isMainFrame: boolean;
}

/**
 * The one door from the screen into the engine. The caller must be our own window; the envelope and the payload are
 * checked against the contract; and a failure leaves as a plain code and message — never a stack trace.
 */
export class Dispatcher {
  private readonly logger: Logger;
  constructor(
    private readonly options: {
      handlers: Handlers;
      isTrusted: (sender: Sender) => boolean;
      logger?: Logger;
    },
  ) {
    this.logger = options.logger ?? nullLogger;
  }

  async dispatch(raw: unknown, sender: Sender): Promise<IpcResult<unknown>> {
    const fail = (error: unknown): IpcResult<unknown> => ({
      ok: false,
      error: toSerializedError(error),
    });
    if (!sender.isMainFrame || !this.options.isTrusted(sender)) {
      this.logger.warn('A call from an untrusted sender was refused');
      return fail(new AllayaError('Untrusted sender', { code: 'UNAUTHORIZED_SENDER' }));
    }
    const envelope = envelopeSchema.safeParse(raw);
    if (!envelope.success) {
      return fail(new AllayaError('Malformed request', { code: 'INVALID_IPC_PAYLOAD' }));
    }
    const { channel, payload } = envelope.data;
    if (!isInvokeChannel(channel)) {
      return fail(new AllayaError('Unknown channel', { code: 'UNKNOWN_CHANNEL' }));
    }
    const spec = invokeContract[channel];
    const parsed = spec.request.safeParse(payload);
    if (!parsed.success) {
      return fail(
        new AllayaError('Invalid request', {
          code: 'INVALID_IPC_PAYLOAD',
          details: { channel, issues: parsed.error.issues.slice(0, 5).map((i) => i.message) },
        }),
      );
    }
    const handler = this.options.handlers.get(channel);
    if (!handler) return fail(new AllayaError('Nothing handles that', { code: 'INTERNAL' }));
    try {
      const output = await handler(parsed.data);
      const checked = spec.response.safeParse(output);
      if (!checked.success) {
        this.logger.error('A handler returned something the contract does not allow', { channel });
        return fail(new AllayaError('Something went wrong', { code: 'INTERNAL' }));
      }
      return { ok: true, data: checked.data };
    } catch (error) {
      const serialized = toSerializedError(error);
      if (serialized.code === 'UNKNOWN') {
        this.logger.error('Unexpected error in a handler', {
          channel,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          ok: false,
          error: { code: 'INTERNAL', message: 'Something went wrong', retryable: false },
        };
      }
      return { ok: false, error: serialized };
    }
  }
}
