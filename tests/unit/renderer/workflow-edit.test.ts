import { describe, expect, it } from 'vitest';
import { compileWorkflow, WorkflowError } from '@allaya/automation';
import type { WorkflowStep } from '@allaya/validation';
import {
  allSteps,
  checkWorkflow,
  conditionOf,
  countSteps,
  freshId,
  move,
  newStep,
  tidy,
} from '@renderer/features/automations/workflow-edit';

const act = (id: string, instruction = 'do it'): WorkflowStep => ({
  type: 'action',
  id,
  instruction,
});

describe('editing steps', () => {
  it('finds every step at every level, in the order they are done', () => {
    const tree: WorkflowStep[] = [
      act('a'),
      {
        type: 'condition',
        id: 'c',
        if: conditionOf('previous'),
        then: [act('t')],
        else: [act('e')],
      },
      { type: 'loop', id: 'l', over: { kind: 'times', times: 2 }, body: [act('b')] },
    ];
    expect(allSteps(tree).map((s) => s.id)).toEqual(['a', 'c', 't', 'e', 'l', 'b']);
    expect(countSteps(tree)).toBe(6);
  });

  it('gives each new step an id no other step has, even after deletions', () => {
    const steps: WorkflowStep[] = [act('s1'), act('s3')];
    const id = freshId(steps);
    expect(['s1', 's3']).not.toContain(id);
    const added = newStep('loop', steps);
    expect(new Set(allSteps([...steps, added]).map((s) => s.id)).size).toBe(4);
  });

  it('starts each kind of step empty, ready to fill in', () => {
    expect(newStep('action', [])).toMatchObject({ type: 'action', instruction: '' });
    expect(newStep('approval', [])).toMatchObject({ type: 'approval', message: '' });
    expect(newStep('condition', [])).toMatchObject({
      if: { kind: 'previous', is: 'succeeded' },
      then: [],
      else: [],
    });
    const loop = newStep('loop', []);
    expect(loop).toMatchObject({ over: { kind: 'times', times: 3 } });
    expect((loop as { body: unknown[] }).body).toHaveLength(1);
  });

  it('moves a step one place, and stays put at the ends', () => {
    expect(move(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(move(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    expect(move(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(move(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
  });

  it('tidies labels and text, keeping the rest as it is', () => {
    const tidied = tidy([
      { ...act('a', '  do it  '), label: '   ' },
      { type: 'approval', id: 'p', label: ' Ask ', message: ' ok? ' },
    ]);
    expect(tidied[0]).toEqual({ type: 'action', id: 'a', instruction: 'do it' });
    expect(tidied[1]).toEqual({ type: 'approval', id: 'p', label: 'Ask', message: 'ok?' });
  });
});

describe('checking a workflow on the screen', () => {
  it('points at the step with a blank', () => {
    expect(checkWorkflow([act('a', '  ')], 'manual')).toEqual({
      problem: 'empty_text',
      stepId: 'a',
    });
    expect(
      checkWorkflow([act('a'), { type: 'approval', id: 'p', message: ' ' }], 'manual'),
    ).toEqual({ problem: 'empty_text', stepId: 'p' });
    expect(
      checkWorkflow(
        [
          act('a'),
          {
            type: 'condition',
            id: 'c',
            if: { kind: 'summary', contains: ' ' },
            then: [act('t')],
            else: [],
          },
        ],
        'manual',
      ),
    ).toEqual({ problem: 'empty_text', stepId: 'c' });
  });
  it('accepts a good workflow', () => {
    expect(checkWorkflow([act('a'), { type: 'stop', id: 's' }], 'manual')).toBeUndefined();
  });

  /**
   * The screen and the backend must refuse the same things for the same reasons, or a person is told "fine" and then
   * refused on save. Every structural problem the backend knows is produced here and compared.
   */
  const cases: Array<[string, WorkflowStep[], string]> = [
    ['nothing to do', [{ type: 'stop', id: 'a' }], 'manual'],
    [
      'condition first',
      [
        { type: 'condition', id: 'c', if: conditionOf('previous'), then: [act('x')], else: [] },
        act('y'),
      ],
      'manual',
    ],
    [
      'summary condition first',
      [
        {
          type: 'condition',
          id: 'c',
          if: { kind: 'summary', contains: 'x' },
          then: [act('x')],
          else: [],
        },
        act('y'),
      ],
      'manual',
    ],
    [
      'empty condition',
      [act('a'), { type: 'condition', id: 'c', if: conditionOf('weekday'), then: [], else: [] }],
      'manual',
    ],
    [
      'weekday first is fine',
      [{ type: 'condition', id: 'c', if: conditionOf('weekday'), then: [act('x')], else: [] }],
      'manual',
    ],
    [
      'files loop without folder',
      [{ type: 'loop', id: 'l', over: { kind: 'files' }, body: [act('a')] }],
      'daily',
    ],
    [
      'files loop with folder',
      [{ type: 'loop', id: 'l', over: { kind: 'files' }, body: [act('a')] }],
      'new_file',
    ],
    ['duplicate ids', [act('a'), act('a')], 'manual'],
    [
      'too deep',
      [
        {
          type: 'loop',
          id: 'l1',
          over: { kind: 'times', times: 2 },
          body: [
            {
              type: 'loop',
              id: 'l2',
              over: { kind: 'times', times: 2 },
              body: [
                {
                  type: 'loop',
                  id: 'l3',
                  over: { kind: 'times', times: 2 },
                  body: [
                    { type: 'loop', id: 'l4', over: { kind: 'times', times: 2 }, body: [act('a')] },
                  ],
                },
              ],
            },
          ],
        },
      ],
      'manual',
    ],
    ['too many', Array.from({ length: 31 }, (_, i) => act(`a${i}`)), 'manual'],
    [
      'previous after a step inside a branch',
      [
        { type: 'condition', id: 'c1', if: conditionOf('weekday'), then: [act('x')], else: [] },
        { type: 'condition', id: 'c2', if: conditionOf('previous'), then: [act('y')], else: [] },
      ],
      'manual',
    ],
  ];
  it.each(cases)('agrees with the backend about: %s', (_label, steps, trigger) => {
    const screen = checkWorkflow(steps, trigger)?.problem;
    let backend: string | undefined;
    try {
      compileWorkflow(
        { steps },
        trigger === 'new_file' ? { kind: 'new_file', folder: 'Downloads' } : { kind: 'manual' },
      );
    } catch (error) {
      if (!(error instanceof WorkflowError)) throw error;
      backend = error.problem;
    }
    expect(screen).toBe(backend);
  });
});
