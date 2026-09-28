import type { z } from '@allaya/validation';
import { AllayaError, toSerializedError, type Logger, nullLogger } from '@allaya/shared';
import {
  ipcEnvelopeSchema,
  ipcInvokeContract,
  isInvokeChannel,
  type IpcResult,
} from '@allaya/validation';
import type { HandlerRegistry } from './registry';

export interface SenderInfo {
  /** Electron `webContents.id` of the caller. */
  id: number;
  /** URL of the frame that issued the call. */
  frameUrl: string;
  isMainFrame: boolean;
}

export interface DispatcherOptions {
  registry: HandlerRegistry;
  /** Returns true only for our own renderer windows/URLs. */
  isTrustedSender: (sender: SenderInfo) => boolean;
  logger?: Logger;
  /** Validate handler output against the contract (always on in dev/test). */
  validateResponses?: boolean;
  /** Optional cross-cutting guard (rate limiting, audit). Throw to reject. */
  guard?: (channel: string, sender: SenderInfo) => void;
  /** Called after every dispatch for auditing/diagnostics. Must not throw. */
  onDispatched?: (info: { channel: string; ok: boolean; durationMs: number }) => void;
}

function safeIssues(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.slice(0, 8).map((issue) => ({
    path: issue.path.join('.'),
    // Zod messages describe the schema, never echo the offending value.
    message: issue.message,
  }));
}

/**
 * The single entry point for renderer → main calls. Everything crossing the trust
 * boundary is treated as hostile: sender is verified, the envelope and payload are
 * schema-validated, unknown channels are rejected, and errors are normalised so the
 * renderer never sees stack traces or internal detail.
 */
export class IpcDispatcher {
  private readonly logger: Logger;
  constructor(private readonly options: DispatcherOptions) {
    this.logger = options.logger ?? nullLogger;
  }

  async dispatch(raw: unknown, sender: SenderInfo): Promise<IpcResult<unknown>> {
    const started = performance.now();
    let channelForLog = '?';
    const finish = (result: IpcResult<unknown>): IpcResult<unknown> => {
      try {
        this.options.onDispatched?.({
          channel: channelForLog,
          ok: result.ok,
          durationMs: performance.now() - started,
        });
      } catch {
        /* ignore observer errors */
      }
      return result;
    };
    const fail = (error: unknown): IpcResult<unknown> =>
      finish({ ok: false, error: toSerializedError(error) });

    if (!this.options.isTrustedSender(sender) || !sender.isMainFrame) {
      this.logger.warn('IPC call from untrusted sender rejected', { senderId: sender.id });
      return fail(new AllayaError('Untrusted sender', { code: 'UNAUTHORIZED_SENDER' }));
    }

    const envelope = ipcEnvelopeSchema.safeParse(raw);
    if (!envelope.success) {
      return fail(new AllayaError('Malformed IPC envelope', { code: 'INVALID_IPC_PAYLOAD' }));
    }
    const { channel, payload } = envelope.data;
    channelForLog = channel.slice(0, 64);

    if (!isInvokeChannel(channel)) {
      return fail(new AllayaError('Unknown IPC channel', { code: 'UNKNOWN_CHANNEL' }));
    }

    try {
      this.options.guard?.(channel, sender);

      const spec = ipcInvokeContract[channel];
      const parsed = spec.request.safeParse(payload);
      if (!parsed.success) {
        return fail(
          new AllayaError('Invalid request payload', {
            code: 'INVALID_IPC_PAYLOAD',
            details: { channel, issues: safeIssues(parsed.error) },
          }),
        );
      }

      const handler = this.options.registry.get(channel);
      if (!handler) {
        return fail(new AllayaError('No handler registered', { code: 'INTERNAL' }));
      }

      const output = await handler(parsed.data, { senderId: sender.id });

      if (this.options.validateResponses) {
        const checked = spec.response.safeParse(output);
        if (!checked.success) {
          this.logger.error('Handler returned an invalid response', {
            channel,
            issues: safeIssues(checked.error),
          });
          return fail(new AllayaError('Internal response validation failed', { code: 'INTERNAL' }));
        }
        return finish({ ok: true, data: checked.data });
      }
      return finish({ ok: true, data: output });
    } catch (error) {
      const serialized = toSerializedError(error);
      // Unknown failures are logged in full but reported generically.
      if (serialized.code === 'UNKNOWN') {
        this.logger.error('Unhandled error in IPC handler', {
          channel,
          error: error instanceof Error ? error.message : String(error),
        });
        return finish({
          ok: false,
          error: { code: 'INTERNAL', message: 'Something went wrong', retryable: false },
        });
      }
      return finish({ ok: false, error: serialized });
    }
  }
}
