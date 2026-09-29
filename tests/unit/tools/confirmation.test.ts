import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmationBroker, type ConfirmationRequest } from '@allaya/tools';

const input = (
  over: Partial<Omit<ConfirmationRequest, 'id' | 'createdAt' | 'expiresAt'>> = {},
) => ({
  callId: 'call_1',
  tool: 'delete_files',
  risk: 'HIGH' as const,
  summary: 'Delete 3 files from Downloads',
  subjects: ['delete_files' as const],
  channels: ['ui', 'voice', 'text'] as const,
  ...over,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('confirmation broker', () => {
  it('holds an action until the user answers, then resolves with the answer', async () => {
    const broker = new ConfirmationBroker();
    const requested: ConfirmationRequest[] = [];
    broker.events.on('requested', (r) => requested.push(r));

    const answer = broker.request(input());
    expect(requested).toHaveLength(1);
    expect(broker.pending()).toEqual([
      expect.objectContaining({ tool: 'delete_files', summary: 'Delete 3 files from Downloads' }),
    ]);
    expect(broker.respond(requested[0]!.id, 'approved', 'ui')).toEqual({ ok: true });
    await expect(answer).resolves.toBe('approved');
    expect(broker.pending()).toEqual([]);
  });

  it('a rejection resolves as rejected', async () => {
    const broker = new ConfirmationBroker();
    const answer = broker.request(input());
    broker.respond(broker.pending()[0]!.id, 'rejected', 'ui');
    await expect(answer).resolves.toBe('rejected');
  });

  it('silence is a "no": the question expires', async () => {
    const broker = new ConfirmationBroker({ timeoutMs: 5000 });
    const resolved: string[] = [];
    broker.events.on('resolved', (e) => resolved.push(e.decision));
    const answer = broker.request(input());
    await vi.advanceTimersByTimeAsync(4999);
    expect(broker.pending()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    await expect(answer).resolves.toBe('expired');
    expect(resolved).toEqual(['expired']);
    expect(broker.pending()).toEqual([]);
  });

  it('an approval that arrives after expiry is refused and changes nothing', async () => {
    const broker = new ConfirmationBroker({ timeoutMs: 1000 });
    const answer = broker.request(input());
    const id = broker.pending()[0]!.id;
    await vi.advanceTimersByTimeAsync(1500);
    await expect(answer).resolves.toBe('expired');
    expect(broker.respond(id, 'approved', 'ui')).toEqual({ ok: false, reason: 'unknown' });
  });

  it('the first answer wins; a second is refused', async () => {
    const broker = new ConfirmationBroker();
    const answer = broker.request(input());
    const id = broker.pending()[0]!.id;
    expect(broker.respond(id, 'rejected', 'ui')).toEqual({ ok: true });
    expect(broker.respond(id, 'approved', 'ui')).toEqual({ ok: false, reason: 'unknown' });
    await expect(answer).resolves.toBe('rejected');
  });

  it('cancelling (STOP) resolves the question as cancelled and removes it', async () => {
    const broker = new ConfirmationBroker();
    const controller = new AbortController();
    const answer = broker.request(input(), controller.signal);
    controller.abort();
    await expect(answer).resolves.toBe('cancelled');
    expect(broker.pending()).toEqual([]);
  });

  it('an already-cancelled request never even reaches the user', async () => {
    const broker = new ConfirmationBroker();
    const requested = vi.fn();
    broker.events.on('requested', requested);
    const controller = new AbortController();
    controller.abort();
    await expect(broker.request(input(), controller.signal)).resolves.toBe('cancelled');
    expect(requested).not.toHaveBeenCalled();
  });

  it('accepts approval only from channels the policy allows — CRITICAL needs the screen', async () => {
    const broker = new ConfirmationBroker();
    const answer = broker.request(input({ risk: 'CRITICAL', channels: ['ui'] }));
    const id = broker.pending()[0]!.id;
    expect(broker.respond(id, 'approved', 'voice')).toEqual({
      ok: false,
      reason: 'channel_not_allowed',
    });
    expect(broker.respond(id, 'approved', 'text')).toEqual({
      ok: false,
      reason: 'channel_not_allowed',
    });
    expect(broker.pending()).toHaveLength(1); // still waiting
    expect(broker.respond(id, 'approved', 'ui')).toEqual({ ok: true });
    await expect(answer).resolves.toBe('approved');
  });

  it('a rejection is accepted from any channel (saying "no" is always safe)', async () => {
    const broker = new ConfirmationBroker();
    const answer = broker.request(input({ risk: 'CRITICAL', channels: ['ui'] }));
    expect(broker.respond(broker.pending()[0]!.id, 'rejected', 'voice')).toEqual({ ok: true });
    await expect(answer).resolves.toBe('rejected');
  });

  it('cannot be answered for an id that never existed', () => {
    const broker = new ConfirmationBroker();
    expect(broker.respond('confirm_nope', 'approved', 'ui')).toEqual({
      ok: false,
      reason: 'unknown',
    });
    expect(broker.respond('__proto__', 'approved', 'ui')).toEqual({ ok: false, reason: 'unknown' });
  });

  it('cancelAll cancels every open question', async () => {
    const broker = new ConfirmationBroker();
    const a = broker.request(input({ callId: 'a' }));
    const b = broker.request(input({ callId: 'b' }));
    expect(broker.cancelAll()).toBe(2);
    await expect(Promise.all([a, b])).resolves.toEqual(['cancelled', 'cancelled']);
  });

  it('gives every question a unique id and an expiry time', () => {
    const broker = new ConfirmationBroker({ timeoutMs: 60_000, now: () => 1000 });
    void broker.request(input({ callId: 'a' }));
    void broker.request(input({ callId: 'b' }));
    const [a, b] = broker.pending();
    expect(a!.id).not.toBe(b!.id);
    expect(a).toMatchObject({ createdAt: 1000, expiresAt: 61_000 });
  });
});
