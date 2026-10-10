import { AllayaError, maskSecret } from '@allaya/shared';
import type { Cipher } from '@allaya/security';
import type { Db } from './db';

/**
 * Keys and tokens, encrypted by the operating system (Windows: DPAPI) before they touch the disk. If the system cannot
 * encrypt, saving is refused: there is no quiet fallback to plain text. The screen only ever sees the short hint.
 */
export class SecretStore {
  constructor(
    private readonly db: Db,
    private readonly cipher: Cipher,
  ) {}

  set(name: string, value: string): string {
    if (!this.cipher.isAvailable()) {
      throw new AllayaError('Secure storage is not available on this system', {
        code: 'CREDENTIAL_STORAGE_UNAVAILABLE',
      });
    }
    const hint = maskSecret(value);
    this.db
      .prepare(
        `insert into secrets (name, enc, hint) values (?, ?, ?)
         on conflict(name) do update set enc = excluded.enc, hint = excluded.hint`,
      )
      .run(name, this.cipher.encrypt(value), hint);
    return hint;
  }

  /** The secret, or undefined when there is none or it can no longer be read (a profile moved to another user). */
  get(name: string): string | undefined {
    const row = this.db.prepare('select enc from secrets where name = ?').get(name) as
      { enc: string } | undefined;
    if (!row) return undefined;
    try {
      return this.cipher.decrypt(row.enc);
    } catch {
      return undefined;
    }
  }

  has(name: string): boolean {
    return this.db.prepare('select 1 from secrets where name = ?').get(name) !== undefined;
  }

  hint(name: string): string | undefined {
    return (
      this.db.prepare('select hint from secrets where name = ?').get(name) as
        { hint: string } | undefined
    )?.hint;
  }

  remove(name: string): void {
    this.db.prepare('delete from secrets where name = ?').run(name);
  }
}
