import { AllayaError } from '@allaya/shared';
import {
  MAX_FILES_PER_RUN,
  MAX_WORKFLOW_DEPTH,
  MAX_WORKFLOW_STEPS,
  z,
  type AutomationTrigger,
  type Workflow,
  type WorkflowCondition,
  type WorkflowProblem,
  type WorkflowStep,
} from '@allaya/validation';

/**
 * Workflows: several steps instead of one instruction.
 *
 * The saved definition is a tree; it is compiled to a short flat program (actions, jumps, loop counters,
 * approvals) whose whole state — where it is, what the last task said, how many times each loop has gone round —
 * is a small piece of data stored with the run. So a run can wait for a person for days, survive Allaya being
 * closed, and carry on exactly where it was, and nothing in it depends on a model: every decision (a condition, a
 * loop, an approval) is made here, from facts the app knows.
 */

// ── the program ─────────────────────────────────────────────────────────────
export type Op =
  | {
      op: 'action';
      id: string;
      label?: string | undefined;
      instruction: string;
      keepGoing: boolean;
      usePrevious: boolean;
      /** The loop slot of the file this step is about, when it is inside a "for each new file" loop. */
      fileSlot?: number | undefined;
    }
  | { op: 'branch'; cond: WorkflowCondition; elseTo: number }
  | { op: 'jump'; to: number }
  | { op: 'times_begin'; slot: number }
  | { op: 'times_end'; slot: number; times: number; back: number }
  | { op: 'files_begin'; slot: number; end: number }
  | { op: 'files_end'; slot: number; back: number }
  | { op: 'approval'; id: string; label?: string | undefined; message: string }
  | { op: 'stop' };

export class WorkflowError extends AllayaError {
  constructor(readonly problem: WorkflowProblem) {
    super('That workflow cannot be used', { code: 'INVALID_INPUT', details: { reason: problem } });
  }
}

export interface CompiledWorkflow {
  program: Op[];
  /** Loop counters needed. */
  slots: number;
  /** Steps in the tree, all levels. */
  steps: number;
}

/**
 * Turns the tree into a program, refusing what cannot work: too many steps or too deep, repeated ids, a condition on
 * "the previous step" before any step, a "for each file" loop where no folder starts the run, nothing to do.
 */
export function compileWorkflow(
  workflow: Workflow,
  trigger: AutomationTrigger = { kind: 'manual' },
): CompiledWorkflow {
  const program: Op[] = [];
  const ids = new Set<string>();
  let slots = 0;
  let steps = 0;
  let actions = 0;

  const emit = (list: readonly WorkflowStep[], depth: number, fileSlot: number | undefined) => {
    if (depth > MAX_WORKFLOW_DEPTH) throw new WorkflowError('too_deep');
    for (const step of list) {
      steps += 1;
      if (steps > MAX_WORKFLOW_STEPS) throw new WorkflowError('too_many_steps');
      if (ids.has(step.id)) throw new WorkflowError('duplicate_id');
      ids.add(step.id);

      switch (step.type) {
        case 'action':
          actions += 1;
          program.push({
            op: 'action',
            id: step.id,
            label: step.label,
            instruction: step.instruction,
            keepGoing: step.keepGoing === true,
            usePrevious: step.usePrevious === true,
            fileSlot,
          });
          break;
        case 'approval':
          program.push({ op: 'approval', id: step.id, label: step.label, message: step.message });
          break;
        case 'stop':
          program.push({ op: 'stop' });
          break;
        case 'condition': {
          if (step.then.length === 0 && step.else.length === 0) {
            throw new WorkflowError('empty_condition');
          }
          const usesPrevious = step.if.kind === 'previous' || step.if.kind === 'summary';
          if (usesPrevious && actions === 0) throw new WorkflowError('no_previous_step');
          const branch: Op = { op: 'branch', cond: step.if, elseTo: -1 };
          program.push(branch);
          emit(step.then, depth + 1, fileSlot);
          const skip: Op = { op: 'jump', to: -1 };
          program.push(skip);
          branch.elseTo = program.length;
          emit(step.else, depth + 1, fileSlot);
          skip.to = program.length;
          break;
        }
        case 'loop': {
          const slot = slots;
          slots += 1;
          if (step.over.kind === 'files') {
            if (trigger.kind !== 'new_file') throw new WorkflowError('files_loop_needs_folder');
            const begin: Op = { op: 'files_begin', slot, end: -1 };
            program.push(begin);
            const back = program.length;
            emit(step.body, depth + 1, slot);
            program.push({ op: 'files_end', slot, back });
            begin.end = program.length;
          } else {
            program.push({ op: 'times_begin', slot });
            const back = program.length;
            emit(step.body, depth + 1, fileSlot);
            program.push({ op: 'times_end', slot, times: step.over.times, back });
          }
          break;
        }
      }
    }
  };

  emit(workflow.steps, 1, undefined);
  if (actions === 0) throw new WorkflowError('nothing_to_do');
  return { program, slots, steps };
}

// ── conditions ──────────────────────────────────────────────────────────────
export interface LastResult {
  ok: boolean;
  /** What the task said (its own answer), or why it failed. Compared as text, never obeyed. */
  summary: string;
}

/**
 * Whether a condition holds. With no previous task yet, "the previous step succeeded" is true (nothing has gone
 * wrong) and "failed" and "the answer contains…" are false.
 */
export function evaluateCondition(
  condition: WorkflowCondition,
  context: { last?: LastResult | undefined; now: Date },
): boolean {
  switch (condition.kind) {
    case 'previous':
      return condition.is === 'succeeded' ? context.last?.ok !== false : context.last?.ok === false;
    case 'summary':
      return (
        context.last !== undefined &&
        context.last.summary.toLowerCase().includes(condition.contains.toLowerCase())
      );
    case 'weekday':
      return condition.days.includes(context.now.getDay());
    case 'time_between': {
      const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
      const at = context.now.getHours() * 60 + context.now.getMinutes();
      const from = minutes(condition.from);
      const to = minutes(condition.to);
      if (from === to) return false;
      return from < to ? at >= from && at < to : at >= from || at < to;
    }
  }
}

// ── a run's state ───────────────────────────────────────────────────────────
export const workflowRunStateSchema = z.object({
  program: z.array(z.custom<Op>((value) => typeof value === 'object' && value !== null)),
  pc: z.number().int().nonnegative(),
  /** Tasks started so far. */
  started: z.number().int().nonnegative(),
  counters: z.array(z.number().int().nonnegative()),
  files: z.array(z.string()),
  folder: z.string().optional(),
  last: z.object({ ok: z.boolean(), summary: z.string() }).optional(),
  /** The task this run is waiting on; cleared when its end has been handled, so a repeat is ignored. */
  taskId: z.string().optional(),
  /** Whether the running task's failure ends the run. */
  keepGoing: z.boolean().optional(),
  /** What the person is asked to approve, when the run is waiting on that. */
  pending: z.object({ id: z.string(), message: z.string() }).optional(),
  /** The step being worked on, for the run history. */
  current: z.string().optional(),
});
export type WorkflowRunState = z.infer<typeof workflowRunStateSchema>;

export const MAX_PREVIOUS_CHARS = 600;

export function newWorkflowState(
  compiled: CompiledWorkflow,
  files: readonly string[],
  folder: string | undefined,
): WorkflowRunState {
  return {
    program: compiled.program,
    pc: 0,
    started: 0,
    counters: Array.from({ length: compiled.slots }, () => 0),
    files: files.slice(0, MAX_FILES_PER_RUN),
    ...(folder ? { folder } : {}),
  };
}
