import { afterEach, describe, expect, it } from 'vitest';
import type { PermissionEntry } from '@allaya/validation';
import { createTestBackend, type TestBackend } from '../helpers/backend';

const backends: TestBackend[] = [];
afterEach(() => {
  for (const b of backends.splice(0)) b.dispose();
});
type Ok<T> = { ok: true; data: T };
const data = <T>(r: unknown) => (r as Ok<T>).data;
const boot = () => {
  const backend = createTestBackend();
  backends.push(backend);
  return backend;
};
const modes = (entries: PermissionEntry[]) =>
  Object.fromEntries(entries.map((e) => [e.subject, e.mode]));

describe('permissions can be put back to their cautious defaults', () => {
  it('resets every change at once, and the defaults stay cautious', async () => {
    const backend = boot();
    await backend.call('permissions:set', { subject: 'file_access', mode: 'always_allow' });
    await backend.call('permissions:set', { subject: 'clipboard', mode: 'never' });
    await backend.call('permissions:set', { subject: 'camera', mode: 'ask' });
    const changed = modes(data<PermissionEntry[]>(await backend.call('permissions:list')));
    expect(changed).toMatchObject({
      file_access: 'always_allow',
      clipboard: 'never',
      camera: 'ask',
    });

    const reset = data<PermissionEntry[]>(await backend.call('permissions:reset'));
    expect(modes(reset)).toMatchObject({
      file_access: 'ask',
      clipboard: 'ask',
      camera: 'never',
      administrator_commands: 'never',
      delete_files: 'ask',
    });
    for (const entry of reset) expect(entry.mode).toBe(entry.defaultMode);
    expect(backend.container.permissions.modeFor('file_access')).toBe('ask');
  });

  it('sensitive actions still cannot be set to always allow', async () => {
    const backend = boot();
    for (const subject of [
      'delete_files',
      'send_email',
      'install_software',
      'administrator_commands',
      'external_communication',
    ]) {
      const result = (await backend.call('permissions:set', { subject, mode: 'always_allow' })) as {
        ok: boolean;
      };
      expect(result.ok, subject).toBe(false);
    }
  });

  it('refuses a payload on reset', async () => {
    const backend = boot();
    expect(
      ((await backend.call('permissions:reset', { subject: 'file_access' })) as { ok: boolean }).ok,
    ).toBe(false);
  });
});

describe('the emergency stop key reports its state', () => {
  it('says it is unavailable when nothing has registered one (as in tests)', async () => {
    const backend = boot();
    expect(data(await backend.call('agent:getSafety'))).toEqual({
      emergencyStop: {
        accelerator: 'Ctrl+Shift+Escape',
        registered: false,
        reason: 'unavailable',
      },
    });
  });

  it('shows the key the person chose', async () => {
    const backend = boot();
    await backend.call('settings:set', { key: 'shortcuts.emergencyStop', value: 'Ctrl+Alt+K' });
    expect(
      data<{ emergencyStop: { accelerator: string } }>(await backend.call('agent:getSafety'))
        .emergencyStop.accelerator,
    ).toBe('Ctrl+Alt+K');
  });
});
