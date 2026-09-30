import {
  MAX_LOOP_TIMES,
  MAX_WORKFLOW_DEPTH,
  MAX_WORKFLOW_STEPS,
  type WorkflowCondition,
  type WorkflowStep,
} from '@allaya/validation';

export type StepType = WorkflowStep['type'];
export const STEP_TYPES: readonly StepType[] = ['action', 'condition', 'loop', 'approval', 'stop'];

/** What is wrong with a workflow on the screen: the backend's problems, and the blanks only a form can have. */
export type FlowProblem =
  | 'too_many_steps'
  | 'too_deep'
  | 'duplicate_id'
  | 'no_previous_step'
  | 'files_loop_needs_folder'
  | 'nothing_to_do'
  | 'empty_condition'
  | 'empty_text'
  | 'empty_body';

export interface FoundProblem {
  problem: FlowProblem;
  /** The step to point at (none for a problem of the whole). */
  stepId?: string | undefined;
}

/** Every step, at every level, in the order it is done. */
export function allSteps(steps: readonly WorkflowStep[]): WorkflowStep[] {
  return steps.flatMap((step) => [
    step,
    ...(step.type === 'condition'
      ? [...allSteps(step.then), ...allSteps(step.else)]
      : step.type === 'loop'
        ? allSteps(step.body)
        : []),
  ]);
}

export const countSteps = (steps: readonly WorkflowStep[]): number => allSteps(steps).length;

/** An id no step uses yet. */
export function freshId(steps: readonly WorkflowStep[]): string {
  const used = new Set(allSteps(steps).map((s) => s.id));
  let n = used.size + 1;
  while (used.has(`s${n}`)) n += 1;
  return `s${n}`;
}

/** A new, empty step of a kind, with an id unique in the whole workflow. */
export function newStep(type: StepType, whole: readonly WorkflowStep[]): WorkflowStep {
  const id = freshId(whole);
  switch (type) {
    case 'action':
      return { type, id, instruction: '' };
    case 'approval':
      return { type, id, message: '' };
    case 'stop':
      return { type, id };
    case 'condition':
      return { type, id, if: { kind: 'previous', is: 'succeeded' }, then: [], else: [] };
    case 'loop': {
      // A loop with nothing inside would be refused, so it starts with one step to fill in.
      const inner: WorkflowStep = { type: 'action', id: `${id}a`, instruction: '' };
      return { type, id, over: { kind: 'times', times: 3 }, body: [inner] };
    }
  }
}

/** The condition a kind starts with when the person changes it. */
export function conditionOf(kind: WorkflowCondition['kind']): WorkflowCondition {
  switch (kind) {
    case 'previous':
      return { kind, is: 'succeeded' };
    case 'summary':
      return { kind, contains: '' };
    case 'weekday':
      return { kind, days: [1, 2, 3, 4, 5] };
    case 'time_between':
      return { kind, from: '09:00', to: '17:00' };
  }
}

/** Moves the item at `index` by `by` places (clamped); returns the same list when there is nowhere to go. */
export function move<T>(list: readonly T[], index: number, by: -1 | 1): T[] {
  const to = index + by;
  if (to < 0 || to >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(to, 0, item!);
  return next;
}

/**
 * The first thing wrong with a workflow, walking it in the order the backend does, so the screen and the backend
 * agree on what is refused and why. Blank text is only a screen matter (the backend refuses it as malformed).
 */
export function checkWorkflow(
  steps: readonly WorkflowStep[],
  triggerKind: string,
): FoundProblem | undefined {
  const ids = new Set<string>();
  let count = 0;
  let actions = 0;
  let found: FoundProblem | undefined;
  const fail = (problem: FlowProblem, stepId?: string) => {
    found ??= { problem, stepId };
  };

  const walk = (list: readonly WorkflowStep[], depth: number) => {
    if (depth > MAX_WORKFLOW_DEPTH) return fail('too_deep', list[0]?.id);
    for (const step of list) {
      if (found) return;
      count += 1;
      if (count > MAX_WORKFLOW_STEPS) return fail('too_many_steps', step.id);
      if (ids.has(step.id)) return fail('duplicate_id', step.id);
      ids.add(step.id);
      switch (step.type) {
        case 'action':
          actions += 1;
          if (!step.instruction.trim()) fail('empty_text', step.id);
          break;
        case 'approval':
          if (!step.message.trim()) fail('empty_text', step.id);
          break;
        case 'stop':
          break;
        case 'condition': {
          if (step.then.length === 0 && step.else.length === 0)
            return fail('empty_condition', step.id);
          const cond = step.if;
          if ((cond.kind === 'previous' || cond.kind === 'summary') && actions === 0) {
            return fail('no_previous_step', step.id);
          }
          if (cond.kind === 'summary' && !cond.contains.trim()) return fail('empty_text', step.id);
          walk(step.then, depth + 1);
          walk(step.else, depth + 1);
          break;
        }
        case 'loop':
          if (step.over.kind === 'files' && triggerKind !== 'new_file') {
            return fail('files_loop_needs_folder', step.id);
          }
          if (
            step.over.kind === 'times' &&
            !(step.over.times >= 1 && step.over.times <= MAX_LOOP_TIMES)
          ) {
            return fail('empty_text', step.id);
          }
          if (step.body.length === 0) return fail('empty_body', step.id);
          walk(step.body, depth + 1);
          break;
      }
    }
  };
  walk(steps, 1);
  if (!found && actions === 0) fail('nothing_to_do');
  return found;
}

/** Drops empty optional labels so the saved workflow holds only what the person wrote. */
export function tidy(steps: readonly WorkflowStep[]): WorkflowStep[] {
  return steps.map((step): WorkflowStep => {
    const label = step.label?.trim();
    const base = { ...step, label: label || undefined };
    if (!base.label) delete (base as { label?: string }).label;
    switch (base.type) {
      case 'action':
        return { ...base, instruction: base.instruction.trim() };
      case 'approval':
        return { ...base, message: base.message.trim() };
      case 'condition':
        return {
          ...base,
          if:
            base.if.kind === 'summary'
              ? { ...base.if, contains: base.if.contains.trim() }
              : base.if,
          then: tidy(base.then),
          else: tidy(base.else),
        };
      case 'loop':
        return { ...base, body: tidy(base.body) };
      case 'stop':
        return base;
    }
  });
}
