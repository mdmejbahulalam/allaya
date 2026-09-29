import { AGENT_PHASES, TERMINAL_TASK_STATES, type AgentPhase, type TaskState } from '@allaya/types';
import { AllayaError } from '@allaya/shared';

/**
 * The task lifecycle as data. Every change of state goes through `assertTransition`, so an impossible one (a
 * finished task starting again, a paused task jumping to "completed") is a bug that throws, not a silent state.
 *
 *   CREATED → ANALYZING → (PLANNING → PERMISSION_CHECK → READY →) EXECUTING → VERIFYING → COMPLETED
 *                           ↘ WAITING_FOR_USER (approval / question / a declined action)
 *   EXECUTING → ERROR → RECOVERY → RETRY → EXECUTING          (or → FAILED once retries are used up)
 *   any working state ⇄ PAUSED;   any non-final state → CANCELLED / FAILED
 */
const TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  CREATED: ['ANALYZING', 'PAUSED', 'CANCELLED', 'FAILED'],
  ANALYZING: ['PLANNING', 'EXECUTING', 'WAITING_FOR_USER', 'PAUSED', 'CANCELLED', 'FAILED'],
  PLANNING: ['PERMISSION_CHECK', 'WAITING_FOR_USER', 'PAUSED', 'CANCELLED', 'FAILED'],
  PERMISSION_CHECK: ['READY', 'WAITING_FOR_USER', 'PAUSED', 'CANCELLED', 'FAILED'],
  READY: ['EXECUTING', 'PAUSED', 'CANCELLED', 'FAILED'],
  EXECUTING: ['VERIFYING', 'ERROR', 'WAITING_FOR_USER', 'PAUSED', 'CANCELLED', 'FAILED'],
  VERIFYING: ['COMPLETED', 'EXECUTING', 'ERROR', 'PAUSED', 'CANCELLED', 'FAILED'],
  ERROR: ['RECOVERY', 'PAUSED', 'FAILED', 'CANCELLED'],
  RECOVERY: ['RETRY', 'WAITING_FOR_USER', 'PAUSED', 'FAILED', 'CANCELLED'],
  RETRY: ['EXECUTING', 'PAUSED', 'FAILED', 'CANCELLED'],
  WAITING_FOR_USER: ['PLANNING', 'READY', 'EXECUTING', 'PAUSED', 'CANCELLED', 'FAILED'],
  // A paused task resumes to the state it was paused in (see `resumeTarget`); it is listed generously here and the
  // orchestrator checks the exact target.
  PAUSED: [
    'CREATED',
    'ANALYZING',
    'PLANNING',
    'PERMISSION_CHECK',
    'READY',
    'EXECUTING',
    'VERIFYING',
    'RETRY',
    'WAITING_FOR_USER',
    'CANCELLED',
    'FAILED',
  ],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export const isTerminal = (state: TaskState): boolean => TERMINAL_TASK_STATES.includes(state);

export const canTransition = (from: TaskState, to: TaskState): boolean =>
  TRANSITIONS[from].includes(to);

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) {
    throw new AllayaError(`A task cannot go from ${from} to ${to}`, {
      code: 'CONFLICT',
      details: { from, to },
    });
  }
}

/** A task can be paused wherever the machine has a PAUSED edge (never once it is final). */
export const canPause = (state: TaskState): boolean => canTransition(state, 'PAUSED');

/** A paused task goes back to the state it was paused in — never to a final state. */
export function resumeTarget(pausedFrom: TaskState | undefined): TaskState {
  return pausedFrom === undefined || pausedFrom === 'PAUSED' || isTerminal(pausedFrom)
    ? 'CREATED'
    : pausedFrom;
}

/** What the user is looking at: the coarse phase of the agent (drives the status pill). */
export function phaseOf(state: TaskState): AgentPhase {
  switch (state) {
    case 'CREATED':
      return 'IDLE';
    case 'ANALYZING':
      return 'UNDERSTANDING';
    case 'PLANNING':
      return 'PLANNING';
    case 'PERMISSION_CHECK':
    case 'WAITING_FOR_USER':
      return 'WAITING_FOR_PERMISSION';
    case 'READY':
    case 'EXECUTING':
    case 'RETRY':
    case 'ERROR':
    case 'RECOVERY':
      return 'EXECUTING';
    case 'VERIFYING':
      return 'VERIFYING';
    case 'COMPLETED':
      return 'COMPLETED';
    case 'FAILED':
      return 'FAILED';
    case 'CANCELLED':
      return 'CANCELLED';
    case 'PAUSED':
      return 'PAUSED';
  }
}

export const ALL_PHASES = AGENT_PHASES;
export const ALL_STATES = Object.keys(TRANSITIONS) as TaskState[];
