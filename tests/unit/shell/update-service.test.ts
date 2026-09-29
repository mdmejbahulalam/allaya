import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nullLogger } from '@allaya/shared';
import type { UpdateStatus } from '@allaya/validation';
import { UpdateService, type UpdaterPort } from '../../../apps/desktop/main/shell/update-service';

function rig(
  over: {
    offer?: { version: string } | undefined;
    auto?: boolean;
    busy?: boolean;
    checkError?: Error;
    downloadError?: Error;
    noPort?: boolean;
  } = {},
) {
  const state = {
    auto: over.auto ?? true,
    busy: over.busy ?? false,
    checks: 0,
    downloads: 0,
    installs: 0,
    seen: [] as UpdateStatus[],
    offer: 'offer' in over ? over.offer : { version: '2.0.0' },
  };
  const port: UpdaterPort = {
    check: async () => {
      state.checks += 1;
      if (over.checkError) throw over.checkError;
      return state.offer;
    },
    download: async (onProgress) => {
      state.downloads += 1;
      if (over.downloadError) throw over.downloadError;
      onProgress(30.4);
      onProgress(100);
    },
    install: () => {
      state.installs += 1;
    },
  };
  const service = new UpdateService({
    ...(over.noPort ? {} : { port }),
    auto: () => state.auto,
    busy: () => state.busy,
    logger: nullLogger,
    onChange: (s) => state.seen.push(s),
    now: () => 5_000,
  });
  return { service, state };
}

describe('keeping Allaya up to date', () => {
  it('reports "unsupported" where there is no update feed, and never checks', async () => {
    const { service, state } = rig({ noPort: true });
    expect(service.status()).toEqual({ state: 'unsupported' });
    expect(await service.checkNow()).toEqual({ state: 'unsupported' });
    service.start();
    expect(state.checks).toBe(0);
    expect(() => service.install()).toThrow(/no update ready/);
  });

  it('says it is up to date when there is nothing newer', async () => {
    const { service } = rig({ offer: undefined });
    expect(await service.checkNow()).toEqual({ state: 'up_to_date', checkedAt: 5_000 });
  });

  it('with automatic updates on, downloads what it finds and then waits for the person', async () => {
    const { service, state } = rig();
    const done = await service.checkNow();
    expect(done).toEqual({ state: 'ready', version: '2.0.0' });
    expect(state.downloads).toBe(1);
    expect(state.installs).toBe(0);
    expect(state.seen.map((s) => s.state)).toEqual([
      'checking',
      'downloading',
      'downloading',
      'downloading',
      'ready',
    ]);
    // Progress is a whole number between 0 and 100.
    expect(
      state.seen
        .filter((s) => s.state === 'downloading')
        .map((s) => (s as { percent: number }).percent),
    ).toEqual([0, 30, 100]);
  });

  it('with automatic updates off, only says one is available until the person asks for it', async () => {
    const { service, state } = rig({ auto: false });
    expect(await service.checkNow()).toEqual({ state: 'available', version: '2.0.0' });
    expect(state.downloads).toBe(0);
    expect(await service.download()).toEqual({ state: 'ready', version: '2.0.0' });
    expect(state.downloads).toBe(1);
  });

  it('downloading does nothing unless an update is on offer', async () => {
    const { service, state } = rig({ offer: undefined });
    await service.download();
    expect(state.downloads).toBe(0);
  });

  it('installs only when one is ready and nothing is running — a restart would cut work off', async () => {
    const { service, state } = rig();
    expect(() => service.install()).toThrow(/no update ready/);
    await service.checkNow();
    state.busy = true;
    expect(() => service.install()).toThrow(/working/);
    expect(state.installs).toBe(0);
    state.busy = false;
    service.install();
    expect(state.installs).toBe(1);
  });

  it('a failed check or download is reported plainly, and tells a network problem from another', async () => {
    const net = rig({ checkError: new Error('getaddrinfo ENOTFOUND github.com') });
    expect(await net.service.checkNow()).toEqual({ state: 'error', reason: 'network' });
    const other = rig({ checkError: new Error('bad signature') });
    expect(await other.service.checkNow()).toEqual({ state: 'error', reason: 'unknown' });
    const download = rig({ downloadError: new Error('ECONNRESET') });
    expect(await download.service.checkNow()).toEqual({ state: 'error', reason: 'network' });
  });

  it('does not start a second check while one is running or an update is ready', async () => {
    const { service, state } = rig();
    await Promise.all([service.checkNow(), service.checkNow()]);
    expect(state.checks).toBe(1);
    await service.checkNow();
    expect(state.checks).toBe(1);
  });

  it('a failure in announcing a change never breaks the update', async () => {
    const service = new UpdateService({
      port: {
        check: async () => undefined,
        download: async () => undefined,
        install: () => undefined,
      },
      auto: () => true,
      busy: () => false,
      logger: nullLogger,
      onChange: () => {
        throw new Error('screen gone');
      },
    });
    await expect(service.checkNow()).resolves.toMatchObject({ state: 'up_to_date' });
  });
});

describe('the quiet background checks', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('look shortly after start and then every six hours — but only while the setting allows', async () => {
    const { service, state } = rig({ offer: undefined });
    service.start();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(state.checks).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(state.checks).toBe(1);
    state.auto = false;
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    expect(state.checks).toBe(1);
    state.auto = true;
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    expect(state.checks).toBe(2);
    service.stop();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(state.checks).toBe(2);
  });
});
