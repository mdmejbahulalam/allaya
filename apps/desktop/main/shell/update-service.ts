import { AllayaError, type Logger } from '@allaya/shared';
import type { UpdateStatus } from '@allaya/validation';

/** What an update feed must offer (electron-updater fits behind a thin adapter). */
export interface UpdaterPort {
  /** The newer version on offer, or nothing when this is the latest. */
  check(): Promise<{ version: string } | undefined>;
  download(onProgress: (percent: number) => void): Promise<void>;
  /** Quits and starts the installer. */
  install(): void;
}

export interface UpdateServiceDeps {
  /** Absent where there is no update feed (development, tests, a portable copy). */
  port?: UpdaterPort | undefined;
  /** The person's "look for updates and download them automatically" switch. */
  auto: () => boolean;
  /** Something is running (a reply, a task): an install would cut it off. */
  busy: () => boolean;
  logger: Logger;
  onChange: (status: UpdateStatus) => void;
  now?: () => number;
}

const FIRST_CHECK_MS = 30_000;
const CHECK_EVERY_MS = 6 * 60 * 60_000;

const looksLikeNetwork = (error: unknown): boolean =>
  /ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|net::|network|offline/i.test(String(error));

/**
 * Keeps Allaya up to date without ever surprising the person. It looks now and then (if allowed), downloads (if
 * allowed), and then waits: installing restarts Allaya, so it happens only when the person asks and only when nothing is
 * running. A new version is trusted only as far as the feed is: the updater checks the file's checksum, and (for a
 * signed Windows build) the publisher's signature.
 */
export class UpdateService {
  private current: UpdateStatus;
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private readonly now: () => number;

  constructor(private readonly deps: UpdateServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.current = deps.port ? { state: 'idle' } : { state: 'unsupported' };
  }

  status(): UpdateStatus {
    return this.current;
  }

  /** Begins the quiet background checks. */
  start(): void {
    if (!this.deps.port) return;
    const first = setTimeout(() => void this.background(), FIRST_CHECK_MS);
    const every = setInterval(() => void this.background(), CHECK_EVERY_MS);
    first.unref?.();
    every.unref?.();
    this.timers.push(first, every);
  }

  stop(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.timers = [];
  }

  /** The person asked to look now (works even with automatic checks off). */
  async checkNow(): Promise<UpdateStatus> {
    return this.check(true);
  }

  /** The person asked to download the version on offer. */
  async download(): Promise<UpdateStatus> {
    if (this.current.state !== 'available') return this.current;
    await this.fetch(this.current.version);
    return this.current;
  }

  /** The person asked to restart into the downloaded version. */
  install(): void {
    if (this.current.state !== 'ready' || !this.deps.port) {
      throw new AllayaError('There is no update ready to install', { code: 'CONFLICT' });
    }
    if (this.deps.busy()) {
      throw new AllayaError('Allaya is working; install when it is done', {
        code: 'CONFLICT',
        details: { reason: 'busy' },
      });
    }
    this.deps.port.install();
  }

  private async background(): Promise<void> {
    if (!this.deps.auto()) return;
    await this.check(false);
  }

  private async check(manual: boolean): Promise<UpdateStatus> {
    const { port, logger } = this.deps;
    if (!port) return this.current;
    if (['checking', 'downloading', 'ready'].includes(this.current.state)) return this.current;
    if (!manual && this.current.state === 'available') return this.current;
    this.set({ state: 'checking' });
    try {
      const offer = await port.check();
      if (!offer) {
        this.set({ state: 'up_to_date', checkedAt: this.now() });
      } else if (this.deps.auto()) {
        await this.fetch(offer.version);
      } else {
        this.set({ state: 'available', version: offer.version });
      }
    } catch (error) {
      logger.warn('Checking for updates failed', { error: String(error) });
      this.set({ state: 'error', reason: looksLikeNetwork(error) ? 'network' : 'unknown' });
    }
    return this.current;
  }

  private async fetch(version: string): Promise<void> {
    const { port, logger } = this.deps;
    if (!port) return;
    this.set({ state: 'downloading', version, percent: 0 });
    try {
      await port.download((percent) => {
        this.set({
          state: 'downloading',
          version,
          percent: Math.max(0, Math.min(100, Math.round(percent))),
        });
      });
      this.set({ state: 'ready', version });
    } catch (error) {
      logger.warn('Downloading the update failed', { error: String(error) });
      this.set({ state: 'error', reason: looksLikeNetwork(error) ? 'network' : 'unknown' });
    }
  }

  private set(status: UpdateStatus): void {
    this.current = status;
    try {
      this.deps.onChange(status);
    } catch (error) {
      this.deps.logger.warn('Could not announce an update change', { error: String(error) });
    }
  }
}
