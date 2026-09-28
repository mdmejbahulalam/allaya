import { afterEach, describe, expect, it } from 'vitest';
import { INVOKE_CHANNELS, settingsDefaults } from '@allaya/validation';
import { AllayaError } from '@allaya/shared';
import { HandlerRegistry } from '@main/ipc/registry';
import { IpcDispatcher } from '@main/ipc/dispatcher';
import { createTestBackend, trustedSender, type TestBackend } from '../helpers/backend';

let backend: TestBackend;
afterEach(() => backend?.dispose());

describe('IPC dispatcher: trust boundary', () => {
  it('has a handler for every channel declared in the contract', () => {
    backend = createTestBackend();
    expect(backend.container.registry.missing()).toEqual([]);
    expect(INVOKE_CHANNELS.length).toBeGreaterThan(0);
  });

  it('rejects calls from an untrusted origin or a sub-frame', async () => {
    backend = createTestBackend();
    const evil = { id: 2, frameUrl: 'https://evil.example/index.html', isMainFrame: true };
    expect(await backend.call('app:getInfo', undefined, evil)).toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED_SENDER' },
    });
    const subframe = { ...trustedSender, isMainFrame: false };
    expect(await backend.call('app:getInfo', undefined, subframe)).toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED_SENDER' },
    });
  });

  it.each([null, undefined, 42, 'x', [], {}, { channel: 1 }, { channel: '' }, { channel: 'x'.repeat(500) }])(
    'rejects malformed envelope %j',
    async (raw) => {
      backend = createTestBackend();
      const result = await backend.dispatcher.dispatch(raw, trustedSender);
      expect(result.ok).toBe(false);
    },
  );

  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'fs:readFile', 'shell:exec', 'app:getInfo '])(
    'treats %j as an unknown channel (no prototype-chain lookups)',
    async (channel) => {
      backend = createTestBackend();
      expect(await backend.call(channel)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_CHANNEL' } });
    },
  );

  it('validates payloads per channel and does not echo offending values', async () => {
    backend = createTestBackend();
    const result = await backend.call('settings:set', { key: 'appearance.theme', value: 'sk-ant-api03-leakyleakyleaky' });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_IPC_PAYLOAD' } });
    expect(JSON.stringify(result)).not.toContain('leakyleaky');
  });

  it('cannot write settings keys that are not in the registry', async () => {
    backend = createTestBackend();
    for (const key of ['__proto__', 'constructor', 'appearance.theme.extra', 'api.key']) {
      const result = await backend.call('settings:set', { key, value: 'x' });
      expect(result.ok, key).toBe(false);
    }
    expect(backend.container.settings.getAll()).toEqual(settingsDefaults);
  });

  it('never leaks internal error details from a crashing handler', async () => {
    const registry = new HandlerRegistry();
    registry.register('app:getInfo', () => {
      throw new Error('ENOENT: C:\\Users\\babul\\secrets.txt sk-ant-api03-abcdefghijklmnop');
    });
    const dispatcher = new IpcDispatcher({ registry, isTrustedSender: () => true, validateResponses: true });
    const result = await dispatcher.dispatch({ channel: 'app:getInfo' }, trustedSender);
    expect(result).toEqual({ ok: false, error: { code: 'INTERNAL', message: 'Something went wrong', retryable: false } });
  });

  it('passes typed AllayaErrors through with their code', async () => {
    const registry = new HandlerRegistry();
    registry.register('app:getInfo', () => {
      throw new AllayaError('Denied', { code: 'PERMISSION_DENIED' });
    });
    const dispatcher = new IpcDispatcher({ registry, isTrustedSender: () => true });
    expect(await dispatcher.dispatch({ channel: 'app:getInfo' }, trustedSender)).toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_DENIED' },
    });
  });

  it('rejects a handler response that violates the contract when strict', async () => {
    const registry = new HandlerRegistry();
    registry.register('app:getInfo', () => ({ name: 1 }) as never);
    const dispatcher = new IpcDispatcher({ registry, isTrustedSender: () => true, validateResponses: true });
    expect(await dispatcher.dispatch({ channel: 'app:getInfo' }, trustedSender)).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL' },
    });
  });

  it('refuses duplicate handler registration', () => {
    const registry = new HandlerRegistry();
    registry.register('app:getInfo', () => ({}) as never);
    expect(() => registry.register('app:getInfo', () => ({}) as never)).toThrow(/Duplicate/);
  });
});

describe('settings over IPC', () => {
  it('round-trips a valid setting, persists it, and publishes a change event', async () => {
    backend = createTestBackend();
    const result = await backend.call('settings:set', { key: 'appearance.theme', value: 'light' });
    expect(result).toMatchObject({ ok: true, data: { 'appearance.theme': 'light' } });

    const all = await backend.call('settings:getAll');
    expect(all).toMatchObject({ ok: true, data: { 'appearance.theme': 'light', 'appearance.accent': '#7C5CFF' } });
    expect(backend.events.events.map((e) => e.channel)).toContain('settings:changed');

    const reset = await backend.call('settings:reset', { key: 'appearance.theme' });
    expect(reset).toMatchObject({ ok: true, data: { 'appearance.theme': 'dark' } });
  });

  it('falls back to the default when a stored value no longer validates', async () => {
    backend = createTestBackend();
    backend.container.database.raw
      .prepare("INSERT INTO settings (key, value_json) VALUES ('appearance.theme', '\"neon\"')")
      .run();
    expect(backend.container.settings.get('appearance.theme')).toBe('dark');
  });

  it('exposes app info', async () => {
    backend = createTestBackend();
    expect(await backend.call('app:getInfo')).toMatchObject({ ok: true, data: { name: 'Allaya' } });
  });
});
