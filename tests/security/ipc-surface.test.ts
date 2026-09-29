import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ipcEventContract, ipcInvokeContract, type InvokeChannel } from '@allaya/validation';
import {
  createTestBackend,
  trustedSender,
  TRUSTED_URL,
  type TestBackend,
} from '../helpers/backend';

/**
 * The whole renderer → main surface, checked channel by channel and automatically: a channel added later is covered
 * the moment it is added, and cannot slip in unreviewed.
 */
let backend: TestBackend;
beforeAll(() => {
  backend = createTestBackend();
});
afterAll(() => backend.dispose());

const channels = Object.keys(ipcInvokeContract) as InvokeChannel[];
const failure = (r: unknown) => (r as { ok: false; error: { code: string } }).error;
const ok = (r: unknown) => (r as { ok: boolean }).ok;

describe('every channel', () => {
  it('is namespaced, and there is a sensible number of them', () => {
    expect(channels.length).toBeGreaterThan(60);
    for (const channel of channels) expect(channel, channel).toMatch(/^[a-z]+:[a-zA-Z]+$/);
    for (const channel of Object.keys(ipcEventContract))
      expect(channel).toMatch(/^[a-z]+:[a-zA-Z]+$/);
  });

  it('refuses a page that is not the app — before looking at anything else', async () => {
    const strangers = [
      { id: 9, frameUrl: 'https://evil.example/', isMainFrame: true },
      { id: 9, frameUrl: 'file:///C:/evil.html', isMainFrame: true },
      { id: 9, frameUrl: 'allaya-app://evil/index.html', isMainFrame: true },
      { id: 9, frameUrl: '', isMainFrame: true },
      { id: 9, frameUrl: 'about:blank', isMainFrame: true },
    ];
    for (const channel of channels) {
      for (const stranger of strangers) {
        const result = await backend.call(channel, {}, stranger);
        expect(ok(result), `${channel} from ${stranger.frameUrl}`).toBe(false);
        expect(failure(result).code, `${channel} from ${stranger.frameUrl}`).toBe(
          'UNAUTHORIZED_SENDER',
        );
      }
    }
  });

  it('refuses the app’s own address when it comes from a sub-frame', async () => {
    const frame = { id: 1, frameUrl: TRUSTED_URL, isMainFrame: false };
    for (const channel of channels) {
      expect(failure(await backend.call(channel, {}, frame)).code, channel).toBe(
        'UNAUTHORIZED_SENDER',
      );
    }
  });

  it('refuses payloads of the wrong kind — text, numbers, arrays, booleans — whatever the channel', async () => {
    const garbage: unknown[] = ['text', 42, [], [1, 2], true, false];
    for (const channel of channels) {
      for (const payload of garbage) {
        const result = await backend.call(channel, payload, trustedSender);
        expect(ok(result), `${channel} accepted ${JSON.stringify(payload)}`).toBe(false);
        expect(failure(result).code, `${channel} ${JSON.stringify(payload)}`).toBe(
          'INVALID_IPC_PAYLOAD',
        );
      }
    }
  });

  it('never passes an unknown field on: a channel that takes an object refuses it or strips it', () => {
    for (const channel of channels) {
      const schema = ipcInvokeContract[channel].request as unknown as {
        _zod?: { def?: { type?: string } };
        safeParse(value: unknown): { success: boolean; data?: unknown };
      };
      if (schema._zod?.def?.type !== 'object') continue;
      const sample = { __extra_field_that_should_not_exist__: 1 };
      const parsed = schema.safeParse(sample);
      if (parsed.success) {
        expect(parsed.data, channel).not.toHaveProperty('__extra_field_that_should_not_exist__');
      }
    }
  });

  it('is not tricked by prototype pollution in the payload', async () => {
    const polluted = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}}}',
    );
    for (const channel of channels) {
      await backend.call(channel, polluted, trustedSender);
    }
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(({} as { x?: number }).x).toBeUndefined();
  });

  it('cannot be reached by a name that is not on the list', async () => {
    for (const name of [
      'fs:readFile',
      'shell:exec',
      'app:quit',
      '__proto__',
      'constructor',
      '',
      'settings:set ',
    ]) {
      const result = await backend.call(name, {}, trustedSender);
      expect(ok(result), name).toBe(false);
      expect(['UNKNOWN_CHANNEL', 'INVALID_IPC_PAYLOAD'], name).toContain(failure(result).code);
    }
  });
});

describe('what a channel may ask for', () => {
  /**
   * Fields that carry a location, an address or something to run. Each channel that takes one has been reviewed:
   * files go through the file policy (allowed folders, protected paths, undo), the browser window through the URL
   * policy (blocked domains, private addresses). A new channel with such a field fails here until it is reviewed
   * and added on purpose.
   */
  const RISKY_FIELD =
    /^(path|paths|url|urls|command|cmd|script|code|html|exec|shell|filePath|executable|args)$/i;
  const REVIEWED = new Set([
    'files:list',
    'files:open',
    'files:reveal',
    'files:createFolder',
    'files:rename',
    'files:delete',
    'browser:openWindow',
  ]);

  it('no channel takes a path, address, command or script unless it has been reviewed', () => {
    const found: string[] = [];
    for (const channel of channels) {
      const request = ipcInvokeContract[channel].request as unknown as {
        _zod?: { def?: { type?: string; shape?: Record<string, unknown> } };
      };
      const shape = request._zod?.def?.shape;
      if (!shape) continue;
      if (Object.keys(shape).some((key) => RISKY_FIELD.test(key))) found.push(channel);
    }
    expect(found.sort()).toEqual([...REVIEWED].sort());
  });

  it('nothing lets the renderer run a command, evaluate code or name an arbitrary executable', () => {
    for (const channel of channels) {
      expect(channel, channel).not.toMatch(/exec|shell|eval|spawn|script|command/i);
    }
  });
});
