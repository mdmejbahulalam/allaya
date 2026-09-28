import type { z } from '@allaya/validation';
import { AllayaError } from '@allaya/shared';
import { INVOKE_CHANNELS, type ipcInvokeContract, type InvokeChannel } from '@allaya/validation';

export interface HandlerContext {
  /** Identifies the calling window (for per-window state and rate limiting). */
  senderId: number;
  signal?: AbortSignal;
}

export type Handler<C extends InvokeChannel> = (
  request: z.output<(typeof ipcInvokeContract)[C]['request']>,
  context: HandlerContext,
) =>
  | Promise<z.input<(typeof ipcInvokeContract)[C]['response']>>
  | z.input<(typeof ipcInvokeContract)[C]['response']>;

/** Typed handler table. Domain modules register their channels; startup asserts none are missing. */
export class HandlerRegistry {
  private readonly handlers = new Map<InvokeChannel, Handler<InvokeChannel>>();

  register<C extends InvokeChannel>(channel: C, handler: Handler<C>): this {
    if (this.handlers.has(channel)) {
      throw new AllayaError(`Duplicate IPC handler for ${channel}`, { code: 'INTERNAL' });
    }
    this.handlers.set(channel, handler);
    return this;
  }

  get(channel: InvokeChannel): Handler<InvokeChannel> | undefined {
    return this.handlers.get(channel);
  }

  missing(): InvokeChannel[] {
    return INVOKE_CHANNELS.filter((channel) => !this.handlers.has(channel));
  }

  assertComplete(): void {
    const missing = this.missing();
    if (missing.length > 0) {
      throw new AllayaError(`IPC channels without handlers: ${missing.join(', ')}`, {
        code: 'INTERNAL',
      });
    }
  }
}
