import { describe, expect, it } from 'vitest';
import {
  ALL_PHASES,
  ALL_STATES,
  assertTransition,
  canPause,
  canTransition,
  isTerminal,
  phaseOf,
  resumeTarget,
} from '@allaya/agent';
import { TASK_STATES, TERMINAL_TASK_STATES } from '@allaya/types';

describe('task state machine', () => {
  it('knows every state and nothing else', () => {
    expect([...ALL_STATES].sort()).toEqual([...TASK_STATES].sort());
  });

  it('never leaves a final state', () => {
    for (const from of TERMINAL_TASK_STATES) {
      expect(isTerminal(from)).toBe(true);
      for (const to of TASK_STATES) expect(canTransition(from, to)).toBe(false);
    }
  });

  it('lets every other state be cancelled or failed', () => {
    for (const from of TASK_STATES.filter((s) => !isTerminal(s))) {
      expect(canTransition(from, 'CANCELLED')).toBe(true);
      expect(canTransition(from, 'FAILED')).toBe(true);
    }
  });

  it('follows the documented happy path, and only that way to COMPLETED', () => {
    const path = [
      'CREATED',
      'ANALYZING',
      'PLANNING',
      'PERMISSION_CHECK',
      'READY',
      'EXECUTING',
      'VERIFYING',
      'COMPLETED',
    ] as const;
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
    }
    const into = TASK_STATES.filter((from) => canTransition(from, 'COMPLETED'));
    expect(into).toEqual(['VERIFYING']);
  });

  it('routes a failed step through error → recovery → retry → executing', () => {
    expect(canTransition('EXECUTING', 'ERROR')).toBe(true);
    expect(canTransition('ERROR', 'RECOVERY')).toBe(true);
    expect(canTransition('RECOVERY', 'RETRY')).toBe(true);
    expect(canTransition('RETRY', 'EXECUTING')).toBe(true);
    // No shortcut around recovery, and nothing starts executing from an error.
    expect(canTransition('ERROR', 'EXECUTING')).toBe(false);
    expect(canTransition('EXECUTING', 'RETRY')).toBe(false);
  });

  it('cannot skip planning checks or start without analysis', () => {
    expect(canTransition('CREATED', 'EXECUTING')).toBe(false);
    expect(canTransition('PLANNING', 'EXECUTING')).toBe(false);
    expect(canTransition('PLANNING', 'READY')).toBe(false);
    expect(canTransition('WAITING_FOR_USER', 'COMPLETED')).toBe(false);
    expect(canTransition('PAUSED', 'COMPLETED')).toBe(false);
  });

  it('throws a CONFLICT error for an impossible move', () => {
    expect(() => assertTransition('COMPLETED', 'EXECUTING')).toThrow(/cannot go from COMPLETED/);
    expect(() => assertTransition('EXECUTING', 'VERIFYING')).not.toThrow();
  });

  it('pauses only what is not final', () => {
    for (const state of TASK_STATES)
      expect(canPause(state)).toBe(!isTerminal(state) && state !== 'PAUSED');
  });

  it('resumes to where the task was, never to a final or paused state', () => {
    expect(resumeTarget('EXECUTING')).toBe('EXECUTING');
    expect(resumeTarget('PLANNING')).toBe('PLANNING');
    expect(resumeTarget(undefined)).toBe('CREATED');
    expect(resumeTarget('COMPLETED')).toBe('CREATED');
    expect(resumeTarget('PAUSED')).toBe('CREATED');
  });

  it('maps every state to a known phase', () => {
    for (const state of TASK_STATES) expect(ALL_PHASES).toContain(phaseOf(state));
    expect(phaseOf('WAITING_FOR_USER')).toBe('WAITING_FOR_PERMISSION');
    expect(phaseOf('RECOVERY')).toBe('EXECUTING');
  });
});
