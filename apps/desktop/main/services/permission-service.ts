import type { PermissionRepository } from '@allaya/database';
import { AllayaError, newId } from '@allaya/shared';
import { DEFAULT_PERMISSION_MODES } from '@allaya/tools';
import {
  PERMISSION_MODES,
  PERMISSION_SUBJECTS,
  SENSITIVE_ACTIONS,
  type PermissionMode,
  type PermissionSubject,
} from '@allaya/types';
import type { PermissionEntry } from '@allaya/validation';

const SENSITIVE = new Set<PermissionSubject>(SENSITIVE_ACTIONS);
const isMode = (value: string): value is PermissionMode =>
  (PERMISSION_MODES as readonly string[]).includes(value);

/**
 * What the user has allowed. The policy engine reads it on every action; the Permissions screen edits it.
 * Unset subjects fall back to cautious defaults, and a stored value that no longer validates is ignored.
 */
export class PermissionService {
  constructor(private readonly repo: PermissionRepository) {}

  modeFor(subject: PermissionSubject): PermissionMode {
    const stored = this.repo.getScope().get(subject);
    return stored && isMode(stored) ? stored : DEFAULT_PERMISSION_MODES[subject];
  }

  list(): PermissionEntry[] {
    const stored = this.repo.getScope();
    return PERMISSION_SUBJECTS.map((subject) => {
      const value = stored.get(subject);
      return {
        subject,
        mode: value && isMode(value) ? value : DEFAULT_PERMISSION_MODES[subject],
        defaultMode: DEFAULT_PERMISSION_MODES[subject],
        sensitive: SENSITIVE.has(subject),
      };
    });
  }

  set(subject: PermissionSubject, mode: PermissionMode): PermissionEntry[] {
    // Deleting files, sending email, installing software and admin commands must be asked about every time.
    if (SENSITIVE.has(subject) && mode === 'always_allow') {
      throw new AllayaError(`"${subject}" can't be set to always allow`, { code: 'INVALID_INPUT' });
    }
    this.repo.set(newId('perm'), subject, mode);
    return this.list();
  }
}
