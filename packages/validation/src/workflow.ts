import { z } from 'zod';

/**
 * A workflow: an automation made of several steps instead of one instruction. Every step that does something is
 * still an ordinary task — the same tools, permissions and confirmations as a message typed in the chat — so a
 * workflow can arrange work but never widen what Allaya may do. Conditions, loops and approvals are decided here, by
 * the app, never by the model.
 *
 * The definition is a tree: a list of steps, where a condition holds two lists (yes / no) and a loop holds one.
 * It is bounded on every side so a saved workflow cannot run away.
 */
export const MAX_WORKFLOW_STEPS = 30;
export const MAX_WORKFLOW_DEPTH = 3;
export const MAX_LOOP_TIMES = 10;
/** The most tasks one run may start, however the loops multiply. */
export const MAX_ACTIONS_PER_RUN = 50;
/** The most files a "for each new file" loop goes through in one run. */
export const MAX_FILES_PER_RUN = 20;
export const MAX_STEP_INSTRUCTION_CHARS = 2000;

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM, 24-hour');
const stepId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const label = z.string().trim().max(80).optional();

/** What a condition looks at. All of it is known to the app: nothing here asks a model for a verdict. */
export const workflowConditionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('previous'),
      /** How the previous task ended. */
      is: z.enum(['succeeded', 'failed']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('summary'),
      /** The previous task's own answer contains this text (ignoring capitals). */
      contains: z.string().trim().min(1).max(200),
    })
    .strict(),
  z
    .object({
      kind: z.literal('weekday'),
      /** 0 = Sunday … 6 = Saturday. */
      days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    })
    .strict(),
  z
    .object({
      kind: z.literal('time_between'),
      from: clock,
      /** Later than `from`, or past midnight ("22:00" to "06:00"). */
      to: clock,
    })
    .strict(),
]);
export type WorkflowCondition = z.infer<typeof workflowConditionSchema>;

export type WorkflowStep =
  | {
      type: 'action';
      id: string;
      label?: string | undefined;
      /** What to do, in the person's own words. Runs as a task. */
      instruction: string;
      /** If it fails, carry on with the next step instead of ending the run. */
      keepGoing?: boolean | undefined;
      /** Give this step the previous task's answer, as marked data. Off by default: it is the person's choice. */
      usePrevious?: boolean | undefined;
    }
  | {
      type: 'condition';
      id: string;
      label?: string | undefined;
      if: WorkflowCondition;
      /** Do the steps under "otherwise" when the condition is *not* met, instead of the steps under "then". */
      then: WorkflowStep[];
      else: WorkflowStep[];
    }
  | {
      type: 'loop';
      id: string;
      label?: string | undefined;
      /** Repeat a number of times, or once for each new file that started the run. */
      over: { kind: 'times'; times: number } | { kind: 'files' };
      body: WorkflowStep[];
    }
  | { type: 'approval'; id: string; label?: string | undefined; message: string }
  | { type: 'stop'; id: string; label?: string | undefined };

export const workflowStepSchema: z.ZodType<WorkflowStep> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z
      .object({
        type: z.literal('action'),
        id: stepId,
        label,
        instruction: z.string().trim().min(1).max(MAX_STEP_INSTRUCTION_CHARS),
        keepGoing: z.boolean().optional(),
        usePrevious: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal('condition'),
        id: stepId,
        label,
        if: workflowConditionSchema,
        then: z.array(workflowStepSchema).max(MAX_WORKFLOW_STEPS),
        else: z.array(workflowStepSchema).max(MAX_WORKFLOW_STEPS),
      })
      .strict(),
    z
      .object({
        type: z.literal('loop'),
        id: stepId,
        label,
        over: z.discriminatedUnion('kind', [
          z
            .object({
              kind: z.literal('times'),
              times: z.number().int().min(1).max(MAX_LOOP_TIMES),
            })
            .strict(),
          z.object({ kind: z.literal('files') }).strict(),
        ]),
        body: z.array(workflowStepSchema).min(1).max(MAX_WORKFLOW_STEPS),
      })
      .strict(),
    z
      .object({
        type: z.literal('approval'),
        id: stepId,
        label,
        /** Shown to the person, who decides. Plain text. */
        message: z.string().trim().min(1).max(300),
      })
      .strict(),
    z.object({ type: z.literal('stop'), id: stepId, label }).strict(),
  ]),
);

export const workflowSchema = z
  .object({ steps: z.array(workflowStepSchema).min(1).max(MAX_WORKFLOW_STEPS) })
  .strict();
export type Workflow = z.infer<typeof workflowSchema>;

/** What is wrong with a workflow that is well-formed but cannot work, as a code the screen turns into words. */
export type WorkflowProblem =
  | 'too_many_steps'
  | 'too_deep'
  | 'duplicate_id'
  | 'no_previous_step'
  | 'files_loop_needs_folder'
  | 'nothing_to_do'
  | 'empty_condition';
