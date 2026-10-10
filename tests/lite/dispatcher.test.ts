import { describe, expect, it } from 'vitest';
import { AllayaError } from '@allaya/shared';
import { Dispatcher, Handlers, type Sender } from '@lite/main/ipc/dispatcher';
import { INVOKE_CHANNELS } from '@lite/shared/ipc';

const ours: Sender = { id: 1, frameUrl: 'allaya-lite://app/index.html', isMainFrame: true };

const make = (
  setup: (h: Handlers) => void,
  isTrusted = (s: Sender) => s.frameUrl.startsWith('allaya-lite://'),
) => {
  const handlers = new Handlers();
  setup(handlers);
  return new Dispatcher({ handlers, isTrusted });
};
const code = (result: unknown) => (result as { error: { code: string; message: string } }).error;

describe('the door from the screen into the engine', () => {
  it('answers a valid call from our own window', async () => {
    const d = make((h) =>
      h.register('app:info', () => ({ version: '1', platform: 'x', locale: 'en', e2e: false })),
    );
    expect(await d.dispatch({ channel: 'app:info' }, ours)).toEqual({
      ok: true,
      data: { version: '1', platform: 'x', locale: 'en', e2e: false },
    });
  });

  it('refuses a call from a page that is not ours, or from a frame inside ours', async () => {
    const d = make((h) =>
      h.register('app:info', () => {
        throw new Error('must not run');
      }),
    );
    expect(
      code(
        await d.dispatch({ channel: 'app:info' }, { ...ours, frameUrl: 'https://evil.example/' }),
      ).code,
    ).toBe('UNAUTHORIZED_SENDER');
    expect(
      code(await d.dispatch({ channel: 'app:info' }, { ...ours, isMainFrame: false })).code,
    ).toBe('UNAUTHORIZED_SENDER');
  });

  it('refuses a malformed envelope, an unknown channel and an invalid payload — without echoing the value', async () => {
    const d = make((h) => h.register('chats:remove', () => ({ ok: true as const })));
    expect(code(await d.dispatch('nonsense', ours)).code).toBe('INVALID_IPC_PAYLOAD');
    expect(code(await d.dispatch({ channel: 'fs:readEverything' }, ours)).code).toBe(
      'UNKNOWN_CHANNEL',
    );
    const bad = await d.dispatch(
      { channel: 'chats:remove', payload: { id: 'SECRET-VALUE'.repeat(30) } },
      ours,
    );
    expect(code(bad).code).toBe('INVALID_IPC_PAYLOAD');
    expect(JSON.stringify(bad)).not.toContain('SECRET-VALUE');
  });

  it('reports a known failure plainly, and an unexpected one without its detail', async () => {
    const d = make((h) =>
      h
        .register('chats:remove', () => {
          throw new AllayaError('That chat does not exist', { code: 'NOT_FOUND' });
        })
        .register('chats:list', () => {
          throw new Error('SQLITE: /home/me/secret.db is locked');
        }),
    );
    expect(
      code(await d.dispatch({ channel: 'chats:remove', payload: { id: 'a' } }, ours)),
    ).toMatchObject({ code: 'NOT_FOUND', message: 'That chat does not exist' });
    const unexpected = await d.dispatch({ channel: 'chats:list' }, ours);
    expect(code(unexpected)).toMatchObject({ code: 'INTERNAL', message: 'Something went wrong' });
    expect(JSON.stringify(unexpected)).not.toContain('secret.db');
  });

  it('never lets a handler send back something the contract does not allow', async () => {
    const d = make((h) => h.register('app:info', () => ({ version: 1 }) as never));
    expect(code(await d.dispatch({ channel: 'app:info' }, ours)).code).toBe('INTERNAL');
  });

  it('knows every channel needs a handler, and a channel cannot have two', () => {
    const h = new Handlers();
    expect(() => h.assertComplete()).toThrow(/No handler for/);
    h.register('app:info', () => ({ version: '', platform: '', locale: '', e2e: false }));
    expect(() =>
      h.register('app:info', () => ({ version: '', platform: '', locale: '', e2e: false })),
    ).toThrow(/Two handlers/);
    expect(INVOKE_CHANNELS.length).toBeGreaterThan(15);
  });
});
