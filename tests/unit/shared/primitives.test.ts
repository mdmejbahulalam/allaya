import { describe, expect, it, vi } from 'vitest';
import {
  AllayaError,
  CancellationSource,
  Mutex,
  StructuredLogger,
  MemorySink,
  TypedEventBus,
  sleep,
  toSerializedError,
  withTimeout,
} from '@allaya/shared';

describe('TypedEventBus', () => {
  it('delivers events, supports unsubscribe, and isolates throwing handlers', () => {
    const onError = vi.fn();
    const bus = new TypedEventBus<{ ping: number }>(onError);
    const seen: number[] = [];
    bus.on('ping', () => {
      throw new Error('boom');
    });
    const off = bus.on('ping', (n) => seen.push(n));
    bus.emit('ping', 1);
    off();
    bus.emit('ping', 2);
    expect(seen).toEqual([1]);
    expect(onError).toHaveBeenCalledTimes(2);
  });
});

describe('cancellation', () => {
  it('cancels sleep immediately with a CANCELLED error', async () => {
    const source = new CancellationSource();
    const pending = sleep(10_000, source.signal);
    source.cancel('emergency stop');
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('propagates parent cancellation to children only', () => {
    const parent = new CancellationSource();
    const child = parent.child();
    child.cancel();
    expect(parent.isCancelled).toBe(false);
    const child2 = parent.child();
    parent.cancel('stop');
    expect(child2.isCancelled).toBe(true);
    expect(() => child2.throwIfCancelled()).toThrow(AllayaError);
  });

  it('times out with a retryable TIMEOUT error', async () => {
    await expect(withTimeout(() => new Promise(() => {}), 20, 'probe')).rejects.toMatchObject({
      code: 'TIMEOUT',
      retryable: true,
    });
  });
});

describe('Mutex', () => {
  it('serializes overlapping work', async () => {
    const mutex = new Mutex();
    const order: string[] = [];
    await Promise.all([
      mutex.runExclusive(async () => {
        order.push('a:start');
        await sleep(15);
        order.push('a:end');
      }),
      mutex.runExclusive(async () => {
        order.push('b:start');
        order.push('b:end');
      }),
    ]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });
});

describe('errors and logging', () => {
  it('serializes errors without leaking stack traces', () => {
    const s = toSerializedError(
      new AllayaError('nope', { code: 'PERMISSION_DENIED', details: { tool: 'x' } }),
    );
    expect(s).toEqual({
      code: 'PERMISSION_DENIED',
      message: 'nope',
      retryable: false,
      details: { tool: 'x' },
    });
    expect(toSerializedError(new Error('plain')).code).toBe('UNKNOWN');
  });

  it('redacts secrets before they reach any log sink and honours the minimum level', () => {
    const sink = new MemorySink();
    const logger = new StructuredLogger([sink], 'test', 'INFO');
    logger.debug('hidden');
    logger.info('using key sk-ant-api03-abcdefghijklmnop', {
      apiKey: 'sk-ant-api03-zzzzzzzzzzzzzzz',
    });
    expect(sink.records).toHaveLength(1);
    const line = JSON.stringify(sink.records[0]);
    expect(line).not.toContain('abcdefghijklmnop');
    expect(line).not.toContain('zzzzzzzzzzzzzzz');
  });
});
