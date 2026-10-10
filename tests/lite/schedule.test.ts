import { describe, expect, it } from 'vitest';
import { checkSchedule, nextRun, scheduleSchema, type Schedule } from '@lite/shared/schedule';
import { suggestModel } from '@lite/shared/model-choice';
import type { ModelView } from '@lite/shared/ipc';

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);

describe('when a task runs next', () => {
  it('a task run by hand never runs by itself', () => {
    expect(nextRun({ kind: 'manual' }, at(2026, 10, 10))).toBeNull();
  });

  it('a one-time task runs at its time, and has no next once that has passed', () => {
    const when = at(2026, 10, 12, 9, 30).getTime();
    expect(nextRun({ kind: 'once', at: when }, at(2026, 10, 10))).toEqual(new Date(when));
    expect(nextRun({ kind: 'once', at: when }, at(2026, 10, 12, 9, 30))).toBeNull();
    expect(nextRun({ kind: 'once', at: when }, at(2026, 10, 13))).toBeNull();
  });

  it('a repeating task runs that long after it last started', () => {
    expect(nextRun({ kind: 'every', minutes: 90 }, at(2026, 10, 10, 8, 0))).toEqual(
      at(2026, 10, 10, 9, 30),
    );
  });

  it('a daily task runs at that time today if it has not passed, otherwise tomorrow', () => {
    const daily: Schedule = { kind: 'daily', time: '08:30', days: [] };
    expect(nextRun(daily, at(2026, 10, 10, 7, 0))).toEqual(at(2026, 10, 10, 8, 30));
    expect(nextRun(daily, at(2026, 10, 10, 8, 30))).toEqual(at(2026, 10, 11, 8, 30));
    expect(nextRun(daily, at(2026, 10, 10, 23, 59))).toEqual(at(2026, 10, 11, 8, 30));
  });

  it('keeps to the chosen days of the week (0 is Sunday), across the end of the month and year', () => {
    // 2026-10-10 is a Saturday.
    const weekdays: Schedule = { kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] };
    expect(nextRun(weekdays, at(2026, 10, 10, 8, 0))).toEqual(at(2026, 10, 12, 9, 0)); // Monday
    expect(nextRun({ kind: 'daily', time: '09:00', days: [0] }, at(2026, 10, 10, 8, 0))).toEqual(
      at(2026, 10, 11, 9, 0),
    );
    expect(nextRun({ kind: 'daily', time: '06:00', days: [] }, at(2026, 12, 31, 12, 0))).toEqual(
      at(2027, 1, 1, 6, 0),
    );
    expect(nextRun({ kind: 'daily', time: '10:00', days: [6] }, at(2026, 10, 10, 10, 0))).toEqual(
      at(2026, 10, 17, 10, 0),
    );
  });

  it('checks a schedule is possible', () => {
    const now = at(2026, 10, 10, 12, 0);
    expect(checkSchedule({ kind: 'once', at: now.getTime() - 1 }, now)).toBe('in_the_past');
    expect(checkSchedule({ kind: 'once', at: now.getTime() + 60_000 }, now)).toBeUndefined();
    expect(checkSchedule({ kind: 'every', minutes: 30 }, now)).toBeUndefined();
  });

  it('accepts only sensible schedules', () => {
    for (const ok of [
      { kind: 'manual' },
      { kind: 'once', at: 1_800_000_000_000 },
      { kind: 'every', minutes: 5 },
      { kind: 'daily', time: '00:00', days: [] },
      { kind: 'daily', time: '23:59', days: [0, 6] },
    ]) {
      expect(scheduleSchema.safeParse(ok).success, JSON.stringify(ok)).toBe(true);
    }
    for (const bad of [
      { kind: 'every', minutes: 4 },
      { kind: 'every', minutes: 1.5 },
      { kind: 'every', minutes: 7 * 24 * 60 + 1 },
      { kind: 'daily', time: '24:00', days: [] },
      { kind: 'daily', time: '8:30', days: [] },
      { kind: 'daily', time: '08:30', days: [7] },
      { kind: 'once', at: -1 },
      { kind: 'cron', expr: '* * * * *' },
    ]) {
      expect(scheduleSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

const view = (over: Partial<ModelView>): ModelView => ({
  connectionId: 'c1',
  connectionName: 'A',
  modelId: 'm',
  displayName: 'm',
  tier: 'balanced',
  vision: false,
  reasoning: false,
  contextWindow: 32_000,
  inferred: false,
  ...over,
});

describe('choosing a model by what a task needs', () => {
  const models = [
    view({ modelId: 'sonnet', tier: 'balanced', vision: true, contextWindow: 200_000 }),
    view({ modelId: 'haiku', tier: 'fast', vision: true, contextWindow: 200_000 }),
    view({
      modelId: 'opus',
      tier: 'frontier',
      reasoning: true,
      vision: true,
      contextWindow: 200_000,
    }),
    view({
      connectionId: 'c2',
      modelId: 'gemini-pro',
      tier: 'frontier',
      vision: true,
      contextWindow: 1_000_000,
    }),
    view({ connectionId: 'c3', modelId: 'text-only', tier: 'balanced', contextWindow: 8_000 }),
  ];
  const id = (need: Parameters<typeof suggestModel>[1], list = models) =>
    suggestModel(list, need)?.modelId;

  it('fast takes a small model, smart a frontier one that reasons, balanced the middle', () => {
    expect(id('fast')).toBe('haiku');
    expect(id('smart')).toBe('opus');
    expect(id('balanced')).toBe('sonnet');
  });

  it('long takes the biggest memory; vision one that can see, preferring one that is not the most costly', () => {
    expect(id('long')).toBe('gemini-pro');
    expect(id('vision')).toBe('sonnet');
    expect(
      id('vision', [view({ modelId: 'text-only' }), view({ modelId: 'eyes', vision: true })]),
    ).toBe('eyes');
  });

  it('prefers what the service said about a model over what was guessed from its name', () => {
    const guessed = view({ modelId: 'guess-fast', tier: 'fast', inferred: true });
    const told = view({ modelId: 'told-fast', tier: 'fast', inferred: false });
    expect(id('fast', [guessed, told])).toBe('told-fast');
    expect(id('fast', [guessed])).toBe('guess-fast');
  });

  it('settles for the nearest when nothing fits, and for nothing when nothing exists', () => {
    expect(id('smart', [view({ modelId: 'only' })])).toBe('only');
    expect(id('vision', [view({ modelId: 'blind' })])).toBe('blind');
    expect(id('fast', [])).toBeUndefined();
    expect(suggestModel(models, 'fast')).toEqual({ connectionId: 'c1', modelId: 'haiku' });
  });
});
