import { z } from 'zod';
import type { PermissionSubject, RiskLevel, SensitiveAction } from '@allaya/types';
import { RISK_LEVELS, SENSITIVE_ACTIONS } from '@allaya/types';
import type { ToolFacts } from './types';

/**
 * A plan is the model's *proposal* for how to do a task: an ordered list of steps. It is never a permission.
 * Every action a step takes still goes through the tool pipeline (validation, risk, the user's permission settings,
 * confirmation), so a plan that names a tool the user has turned off, or that hides a destructive action behind a
 * harmless title, gets no further than the same action would have without a plan.
 */

const STEP_ID = /^[a-z][a-z0-9_-]{0,15}$/i;

export const planStepSchema = z.object({
  id: z.string().regex(STEP_ID).describe('Short unique id, e.g. "s1", "s2".'),
  title: z.string().trim().min(1).max(160).describe('What this step does, in one short sentence.'),
  detail: z
    .string()
    .trim()
    .max(800)
    .optional()
    .describe('Anything needed to do it right: names, paths, sites, values.'),
  expected: z
    .string()
    .trim()
    .max(400)
    .optional()
    .describe('How to tell the step really worked (what should be true afterwards).'),
  tool: z
    .string()
    .trim()
    .max(48)
    .optional()
    .describe('The tool this step mainly uses. Leave out for a step that only needs thinking.'),
  optional: z
    .boolean()
    .optional()
    .describe('True if the task can still succeed when this step cannot be done.'),
  dependsOn: z
    .array(z.string())
    .max(10)
    .optional()
    .describe('Ids of EARLIER steps whose result this step needs.'),
});

/** What the planner sends back: a plan, or (only when it truly cannot proceed) one question. */
export const planSubmissionSchema = z.object({
  question: z
    .string()
    .trim()
    .max(400)
    .optional()
    .describe(
      'Set ONLY if the request is missing something essential that cannot be guessed or found out. Then send no steps.',
    ),
  summary: z.string().trim().max(400).optional().describe('One sentence: what will be done.'),
  steps: z.array(planStepSchema).max(40).optional(),
  successCriteria: z
    .string()
    .trim()
    .max(400)
    .optional()
    .describe('What must be true at the end for the whole task to count as done.'),
});

export interface PlanStep {
  id: string;
  title: string;
  detail?: string | undefined;
  expected?: string | undefined;
  toolHint?: string | undefined;
  optional: boolean;
  /** Earlier steps whose result this one needs. */
  dependsOn: string[];
}

export interface Plan {
  summary: string;
  steps: PlanStep[];
  successCriteria?: string | undefined;
}

export type PlanSubmission =
  | { kind: 'question'; question: string }
  | { kind: 'plan'; plan: Plan }
  | { kind: 'invalid'; reason: string };

/** Turns what the planner model sent into a `Plan` — or says why it is not one. */
export function parsePlanSubmission(input: unknown): PlanSubmission {
  const parsed = planSubmissionSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      kind: 'invalid',
      reason: `${issue?.path.join('.') || 'plan'}: ${issue?.message ?? 'not valid'}`,
    };
  }
  const { question, summary, steps, successCriteria } = parsed.data;
  if (question && (steps?.length ?? 0) === 0) return { kind: 'question', question };
  if (!steps || steps.length === 0) {
    return { kind: 'invalid', reason: 'steps: a plan needs at least one step' };
  }
  return {
    kind: 'plan',
    plan: {
      summary: summary || steps[0]!.title,
      steps: steps.map((step) => ({
        id: step.id,
        title: step.title,
        ...(step.detail ? { detail: step.detail } : {}),
        ...(step.expected ? { expected: step.expected } : {}),
        ...(step.tool ? { toolHint: step.tool } : {}),
        optional: step.optional ?? false,
        dependsOn: step.dependsOn ?? [],
      })),
      ...(successCriteria ? { successCriteria } : {}),
    },
  };
}

/** The one-step plan used for a request that is simple enough not to need planning. */
export function singleStepPlan(title: string): Plan {
  return { summary: title, steps: [{ id: 's1', title, optional: false, dependsOn: [] }] };
}

export interface PlanCheckOptions {
  maxSteps: number;
  /** Tool names the task may use. */
  knownTools: ReadonlySet<string>;
}

/**
 * Problems that make a plan unusable, in words the planner model can act on. Dependencies may only point at
 * *earlier* steps, which makes cycles impossible and the written order a valid running order.
 */
export function validatePlan(plan: Plan, options: PlanCheckOptions): string[] {
  const issues: string[] = [];
  if (plan.steps.length === 0) issues.push('The plan has no steps.');
  if (plan.steps.length > options.maxSteps) {
    issues.push(
      `The plan has ${plan.steps.length} steps; at most ${options.maxSteps} are allowed. Combine steps.`,
    );
  }
  const seen = new Map<string, number>();
  for (const [index, step] of plan.steps.entries()) {
    if (seen.has(step.id)) issues.push(`Step id "${step.id}" is used more than once.`);
    seen.set(step.id, index);
  }
  for (const [index, step] of plan.steps.entries()) {
    for (const dependency of step.dependsOn) {
      const at = seen.get(dependency);
      if (at === undefined) {
        issues.push(`Step "${step.id}" depends on "${dependency}", which is not a step.`);
      } else if (at >= index) {
        issues.push(
          `Step "${step.id}" depends on "${dependency}", which does not come before it. Order the steps so dependencies come first.`,
        );
      }
    }
    if (step.toolHint !== undefined && !options.knownTools.has(step.toolHint)) {
      issues.push(
        `Step "${step.id}" names the tool "${step.toolHint}", which does not exist. Use only the tools you were given, or leave "tool" out.`,
      );
    }
  }
  return issues;
}

export type ApprovalReason = 'requested' | 'many_steps' | 'risky_tool' | 'sensitive_subject';

export interface PlanAssessment {
  /** The most serious risk among the tools the plan names (an estimate: real risk is judged per call). */
  risk: RiskLevel;
  /** Tools the plan names, in order of first use. */
  tools: string[];
  /** Permission subjects those tools may need. */
  subjects: PermissionSubject[];
  /** True when nothing the plan names changes anything. */
  readOnly: boolean;
  needsApproval: boolean;
  reasons: ApprovalReason[];
}

const rank = (risk: RiskLevel) => RISK_LEVELS.indexOf(risk);

const isSensitive = (subject: PermissionSubject): subject is SensitiveAction =>
  (SENSITIVE_ACTIONS as readonly string[]).includes(subject);

/**
 * What the plan is likely to touch, and whether to show it to the user before doing anything. The rule is
 * conservative on purpose: a long plan, a risky tool or a sensitive area (deleting, sending, installing) always
 * asks first. This is a courtesy on top of — never instead of — the per-action checks.
 */
export function assessPlan(
  plan: Plan,
  facts: (tool: string) => ToolFacts | undefined,
  options: { planFirst: boolean; approvalStepThreshold: number },
): PlanAssessment {
  let risk: RiskLevel = 'LOW';
  let readOnly = true;
  const tools: string[] = [];
  const subjects = new Set<PermissionSubject>();
  for (const step of plan.steps) {
    if (!step.toolHint) continue;
    const info = facts(step.toolHint);
    if (!info) continue;
    if (!tools.includes(info.name)) tools.push(info.name);
    for (const subject of info.subjects) subjects.add(subject);
    // A tool whose risk depends on its arguments counts as MEDIUM here; the real level is set per call.
    const worst: RiskLevel =
      info.risk === 'varies' ? (info.readOnly ? 'LOW' : 'MEDIUM') : info.risk;
    if (rank(worst) > rank(risk)) risk = worst;
    if (!info.readOnly) readOnly = false;
  }
  const reasons: ApprovalReason[] = [];
  if (options.planFirst) reasons.push('requested');
  if (plan.steps.length > options.approvalStepThreshold) reasons.push('many_steps');
  if (rank(risk) >= rank('HIGH')) reasons.push('risky_tool');
  if ([...subjects].some(isSensitive)) reasons.push('sensitive_subject');
  return {
    risk,
    tools,
    subjects: [...subjects],
    readOnly,
    needsApproval: reasons.length > 0,
    reasons,
  };
}
