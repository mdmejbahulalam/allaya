import { AllayaError } from './errors';

/** Resolves after `ms`, or rejects with CANCELLED as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AllayaError('cancelled', { code: 'CANCELLED' }));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AllayaError('cancelled', { code: 'CANCELLED' }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label = 'operation',
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(
        new AllayaError(`${label} timed out after ${ms}ms`, { code: 'TIMEOUT', retryable: true }),
      ),
    ms,
  );
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => {
            const reason: unknown = controller.signal.reason;
            reject(
              reason instanceof Error
                ? reason
                : new AllayaError(String(reason), { code: 'CANCELLED' }),
            );
          },
          { once: true },
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', onParentAbort);
  }
}

/** Serializes async work; used to keep DB-adjacent read-modify-write sequences atomic. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
