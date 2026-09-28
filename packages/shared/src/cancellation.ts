import { AllayaError } from './errors';

/**
 * Cooperative cancellation. The emergency stop cancels a token; every long-running
 * operation checks it (or listens to `signal`) so it stops as quickly as practical.
 */
export class CancellationSource {
  private readonly controller = new AbortController();
  private reasonText: string | undefined;

  get signal(): AbortSignal {
    return this.controller.signal;
  }
  get isCancelled(): boolean {
    return this.controller.signal.aborted;
  }
  get reason(): string | undefined {
    return this.reasonText;
  }

  cancel(reason = 'cancelled'): void {
    if (this.controller.signal.aborted) return;
    this.reasonText = reason;
    this.controller.abort(new AllayaError(reason, { code: 'CANCELLED' }));
  }

  /** Throws a CANCELLED error when cancellation was requested. */
  throwIfCancelled(): void {
    throwIfAborted(this.controller.signal);
  }

  /** A child source that is cancelled when this one is (but not vice versa). */
  child(): CancellationSource {
    const child = new CancellationSource();
    if (this.isCancelled) child.cancel(this.reasonText);
    else this.signal.addEventListener('abort', () => child.cancel(this.reasonText), { once: true });
    return child;
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new AllayaError(
      typeof signal.reason?.message === 'string' ? signal.reason.message : 'cancelled',
      {
        code: 'CANCELLED',
      },
    );
  }
}
