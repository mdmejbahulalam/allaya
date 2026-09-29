import { eq, and } from 'drizzle-orm';
import type { AllayaDb } from '../connection';
import { permissions } from '../schema';

/** Raw persistence of per-subject permission modes. Validation lives in the permission service. */
export class PermissionRepository {
  constructor(
    private readonly db: AllayaDb,
    private readonly now: () => number = Date.now,
  ) {}

  /** `subject → mode` for one scope. */
  getScope(scope = 'global'): Map<string, string> {
    const rows = this.db.select().from(permissions).where(eq(permissions.scope, scope)).all();
    return new Map(rows.map((row) => [row.subject, row.mode]));
  }

  set(id: string, subject: string, mode: string, scope = 'global'): void {
    const updatedAt = this.now();
    this.db
      .insert(permissions)
      .values({ id, subject, mode, scope, updatedAt })
      .onConflictDoUpdate({
        target: [permissions.subject, permissions.scope],
        set: { mode, updatedAt },
      })
      .run();
  }

  reset(subject: string, scope = 'global'): void {
    this.db
      .delete(permissions)
      .where(and(eq(permissions.subject, subject), eq(permissions.scope, scope)))
      .run();
  }
}
