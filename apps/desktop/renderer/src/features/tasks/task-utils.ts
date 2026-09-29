import type { TimelineStepState } from '@allaya/types';
import type { TaskEventView, TaskStepView, TaskSummary } from '@allaya/validation';

export function timelineState(state: TaskStepView['state']): TimelineStepState {
  return state === 'cancelled' ? 'skipped' : state;
}

/** Progress of a task as a percentage, or `undefined` while it is not known (no plan yet). */
export function progressOf(task: TaskSummary): number | undefined {
  return task.stepCount > 0 ? Math.round((task.stepsDone / task.stepCount) * 100) : undefined;
}

/** Events that are noise in the activity list (the timeline already shows steps and actions). */
const QUIET_EVENTS: ReadonlySet<TaskEventView['type']> = new Set([
  'STATE_CHANGED',
  'TOOL_STARTED',
  'OBSERVATION_CREATED',
]);

export const visibleEvents = (events: readonly TaskEventView[]): TaskEventView[] =>
  events.filter((event) => !QUIET_EVENTS.has(event.type));

/** The one-line detail worth showing next to an event: which action, or why. */
export function eventDetail(event: TaskEventView): string | undefined {
  const payload = event.payload;
  if (!payload) return undefined;
  const text = (key: string) => (typeof payload[key] === 'string' ? payload[key] : '');
  const detail = text('summary') || text('title') || text('question') || text('message');
  const error = text('error');
  return [detail, error].filter(Boolean).join(' — ') || undefined;
}
