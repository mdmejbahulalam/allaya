import {
  SENSITIVE_ACTIONS,
  type PermissionMode,
  type PermissionSubject,
  type RiskLevel,
} from '@allaya/types';

/**
 * What a user has not configured falls back to these. Cautious by default: everything that can change state asks,
 * the camera and administrator commands are off. (`ask` never interrupts LOW-risk observation — see below.)
 */
export const DEFAULT_PERMISSION_MODES: Readonly<Record<PermissionSubject, PermissionMode>> = {
  computer_control: 'ask',
  file_access: 'ask',
  browser_automation: 'ask',
  application_launch: 'ask',
  clipboard: 'ask',
  microphone: 'ask',
  camera: 'never',
  network: 'ask',
  delete_files: 'ask',
  send_email: 'ask',
  install_software: 'ask',
  administrator_commands: 'never',
  external_communication: 'ask',
};

export type ConfirmationChannel = 'ui' | 'voice' | 'text';

export type PolicyDecision =
  | { action: 'allow'; permission: 'allowed' | 'not_required' }
  | {
      action: 'confirm';
      reason: 'critical' | 'high_risk' | 'ask_mode';
      channels: ConfirmationChannel[];
    }
  | { action: 'deny'; subject: PermissionSubject };

export interface PolicyInput {
  risk: RiskLevel;
  subjects: readonly PermissionSubject[];
  modeFor: (subject: PermissionSubject) => PermissionMode;
}

const SENSITIVE = new Set<PermissionSubject>(SENSITIVE_ACTIONS);

/**
 * The permission and risk policy, as one pure function so that it can be tested exhaustively.
 *
 *  1. `never` on any required subject denies the action, whatever its risk.
 *  2. CRITICAL always needs a fresh confirmation, and only an on-screen click can give it — a mis-heard or
 *     mis-typed "yes" must not authorise the most dangerous actions. "Always allow" cannot weaken this.
 *  3. HIGH needs confirmation unless every subject is `always_allow` — and sensitive actions (deleting files,
 *     sending email, installing software…) are never exempt.
 *  4. MEDIUM needs confirmation when any subject is set to `ask`.
 *  5. LOW (observation, harmless navigation) never interrupts the user unless a subject is `never`.
 */
export function evaluatePolicy({ risk, subjects, modeFor }: PolicyInput): PolicyDecision {
  for (const subject of subjects) {
    if (modeFor(subject) === 'never') return { action: 'deny', subject };
  }
  if (risk === 'CRITICAL') return { action: 'confirm', reason: 'critical', channels: ['ui'] };

  const modes = subjects.map((subject) => modeFor(subject));
  const allAlwaysAllow = modes.every((mode) => mode === 'always_allow');
  const anySensitive = subjects.some((subject) => SENSITIVE.has(subject));

  if (risk === 'HIGH') {
    return allAlwaysAllow && !anySensitive && subjects.length > 0
      ? { action: 'allow', permission: 'allowed' }
      : { action: 'confirm', reason: 'high_risk', channels: ['ui', 'voice', 'text'] };
  }
  if (risk === 'MEDIUM') {
    return modes.some((mode) => mode === 'ask')
      ? { action: 'confirm', reason: 'ask_mode', channels: ['ui', 'voice', 'text'] }
      : { action: 'allow', permission: subjects.length === 0 ? 'not_required' : 'allowed' };
  }
  return { action: 'allow', permission: subjects.length === 0 ? 'not_required' : 'allowed' };
}
