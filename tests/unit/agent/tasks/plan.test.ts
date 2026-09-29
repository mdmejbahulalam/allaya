import { describe, expect, it } from 'vitest';
import {
  assessPlan,
  parsePlanSubmission,
  singleStepPlan,
  validatePlan,
  type Plan,
  type ToolFacts,
} from '@allaya/agent';

const known = new Set(['read_file', 'write_file', 'delete_files']);
const opts = { maxSteps: 5, knownTools: known };

const step = (id: string, extra: Partial<Plan['steps'][number]> = {}) => ({
  id,
  title: `Step ${id}`,
  optional: false,
  dependsOn: [],
  ...extra,
});

describe('parsePlanSubmission', () => {
  it('turns what the model sent into a plan, filling defaults', () => {
    const result = parsePlanSubmission({
      summary: 'Copy it',
      steps: [
        { id: 's1', title: 'Read', tool: 'read_file' },
        { id: 's2', title: 'Write', dependsOn: ['s1'] },
      ],
      successCriteria: 'The copy exists',
    });
    expect(result).toMatchObject({
      kind: 'plan',
      plan: {
        summary: 'Copy it',
        successCriteria: 'The copy exists',
        steps: [
          { id: 's1', toolHint: 'read_file', optional: false, dependsOn: [] },
          { id: 's2', optional: false, dependsOn: ['s1'] },
        ],
      },
    });
  });

  it('accepts a lone question, but a question alongside steps is a plan', () => {
    expect(parsePlanSubmission({ question: 'Which folder?' })).toEqual({
      kind: 'question',
      question: 'Which folder?',
    });
    expect(
      parsePlanSubmission({ question: 'Sure?', steps: [{ id: 's1', title: 'Do it' }] }).kind,
    ).toBe('plan');
  });

  it('rejects malformed submissions with a reason the model can act on', () => {
    expect(parsePlanSubmission({})).toMatchObject({
      kind: 'invalid',
      reason: expect.stringMatching(/at least one step/),
    });
    expect(parsePlanSubmission('nope').kind).toBe('invalid');
    const bad = parsePlanSubmission({ steps: [{ id: 'has space', title: 'x' }] });
    expect(bad).toMatchObject({ kind: 'invalid', reason: expect.stringMatching(/steps\.0\.id/) });
    expect(parsePlanSubmission({ steps: [{ id: 's1', title: '   ' }] }).kind).toBe('invalid');
  });

  it('bounds every text field so a plan cannot smuggle in an essay', () => {
    const long = 'x'.repeat(2000);
    expect(parsePlanSubmission({ steps: [{ id: 's1', title: long }] }).kind).toBe('invalid');
    expect(parsePlanSubmission({ steps: [{ id: 's1', title: 'ok', detail: long }] }).kind).toBe(
      'invalid',
    );
    expect(parsePlanSubmission({ summary: long, steps: [{ id: 's1', title: 'ok' }] }).kind).toBe(
      'invalid',
    );
  });
});

describe('validatePlan', () => {
  it('passes a well-formed plan', () => {
    const plan: Plan = {
      summary: 's',
      steps: [step('s1', { toolHint: 'read_file' }), step('s2', { dependsOn: ['s1'] })],
    };
    expect(validatePlan(plan, opts)).toEqual([]);
    expect(validatePlan(singleStepPlan('Do it'), opts)).toEqual([]);
  });

  it('rejects duplicate ids, unknown and forward dependencies, and self-dependency', () => {
    const issues = validatePlan(
      {
        summary: 's',
        steps: [
          step('s1', { dependsOn: ['s2'] }),
          step('s2', { dependsOn: ['s2'] }),
          step('s2'),
          step('s4', { dependsOn: ['ghost'] }),
        ],
      },
      opts,
    ).join('\n');
    expect(issues).toMatch(/"s2" is used more than once/);
    expect(issues).toMatch(/"s1" depends on "s2", which does not come before it/);
    expect(issues).toMatch(/"s2" depends on "s2"/);
    expect(issues).toMatch(/"s4" depends on "ghost", which is not a step/);
  });

  it('makes cycles impossible: a dependency must come earlier', () => {
    const cyclic: Plan = {
      summary: 's',
      steps: [step('a', { dependsOn: ['b'] }), step('b', { dependsOn: ['a'] })],
    };
    expect(validatePlan(cyclic, opts).length).toBeGreaterThan(0);
  });

  it('rejects tools that do not exist, empty plans and oversized plans', () => {
    expect(
      validatePlan({ summary: 's', steps: [step('s1', { toolHint: 'format_disk' })] }, opts).join(),
    ).toMatch(/"format_disk", which does not exist/);
    expect(validatePlan({ summary: 's', steps: [] }, opts).join()).toMatch(/no steps/);
    const many: Plan = { summary: 's', steps: Array.from({ length: 6 }, (_, i) => step(`s${i}`)) };
    expect(validatePlan(many, opts).join()).toMatch(/6 steps; at most 5/);
  });
});

describe('assessPlan', () => {
  const facts = (name: string): ToolFacts | undefined =>
    (
      ({
        read_file: {
          name,
          category: 'files',
          description: '',
          risk: 'LOW',
          readOnly: true,
          subjects: ['file_access'],
        },
        write_file: {
          name,
          category: 'files',
          description: '',
          risk: 'MEDIUM',
          readOnly: false,
          subjects: ['file_access'],
        },
        delete_files: {
          name,
          category: 'files',
          description: '',
          risk: 'HIGH',
          readOnly: false,
          subjects: ['delete_files'],
        },
        click: {
          name,
          category: 'browser',
          description: '',
          risk: 'varies',
          readOnly: false,
          subjects: ['browser_automation'],
        },
      }) as Record<string, ToolFacts>
    )[name];
  const options = { planFirst: false, approvalStepThreshold: 3 };

  it('lets a read-only plan run without asking', () => {
    const plan: Plan = { summary: 's', steps: [step('s1', { toolHint: 'read_file' })] };
    expect(assessPlan(plan, facts, options)).toMatchObject({
      risk: 'LOW',
      readOnly: true,
      needsApproval: false,
      reasons: [],
      tools: ['read_file'],
    });
  });

  it('asks first for a risky tool or a sensitive area, and says why', () => {
    const plan: Plan = { summary: 's', steps: [step('s1', { toolHint: 'delete_files' })] };
    const result = assessPlan(plan, facts, options);
    expect(result.needsApproval).toBe(true);
    expect(result.risk).toBe('HIGH');
    expect(result.reasons).toEqual(['risky_tool', 'sensitive_subject']);
    expect(result.readOnly).toBe(false);
  });

  it('asks first when the user asked to see the plan, or when it is long', () => {
    const plan: Plan = { summary: 's', steps: [step('s1', { toolHint: 'read_file' })] };
    expect(assessPlan(plan, facts, { ...options, planFirst: true }).reasons).toEqual(['requested']);
    const long: Plan = { summary: 's', steps: Array.from({ length: 4 }, (_, i) => step(`s${i}`)) };
    expect(assessPlan(long, facts, options).reasons).toEqual(['many_steps']);
  });

  it('counts a tool whose risk depends on the arguments as medium, not as free', () => {
    const plan: Plan = { summary: 's', steps: [step('s1', { toolHint: 'click' })] };
    const result = assessPlan(plan, facts, options);
    expect(result.risk).toBe('MEDIUM');
    expect(result.readOnly).toBe(false);
  });

  it('ignores hints for tools it knows nothing about (real risk is judged per action)', () => {
    const plan: Plan = { summary: 's', steps: [step('s1', { toolHint: 'unknown_tool' })] };
    expect(assessPlan(plan, facts, options)).toMatchObject({
      risk: 'LOW',
      tools: [],
      needsApproval: false,
    });
  });
});
