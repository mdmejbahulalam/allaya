import { useId, useMemo, useState } from 'react';
import type { Schedule } from '../../../shared/schedule';
import type { TaskView } from '../../../shared/ipc';
import { MODEL_NEEDS, suggestModel, type ModelNeed } from '../../../shared/model-choice';
import { useT } from '../i18n';
import { cn } from '../lib/cn';
import {
  BROWSER_GROUP,
  draftFromTask,
  draftToInput,
  emptyDraft,
  type Draft,
  type DraftErrors,
} from '../lib/task-draft';
import { weekdayName } from '../lib/time';
import { useAppStore } from '../stores/app';
import { useConnectionsStore } from '../stores/connections';
import { useTasksStore } from '../stores/tasks';
import { ModelPicker } from './model-picker';
import { taskErrorText } from './task-errors';
import { Button, Field, Input, Select, Textarea } from './ui';

const KINDS: Schedule['kind'][] = ['manual', 'once', 'every', 'daily'];
const WEEK = [1, 2, 3, 4, 5, 6, 0];

/** Making or changing a task: what to do, which model does it, and when. */
export function TaskForm({ task }: { task: TaskView | null }) {
  const t = useT();
  const ids = useId();
  const models = useConnectionsStore((s) => s.models);
  const go = useAppStore((s) => s.go);
  const { create, update, show } = useTasksStore();
  const [draft, setDraft] = useState<Draft>(() => (task ? draftFromTask(task) : emptyDraft()));
  const [errors, setErrors] = useState<DraftErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [noModel, setNoModel] = useState(false);
  const [busy, setBusy] = useState(false);
  const others = useMemo(() => task?.groups.filter((g) => g !== BROWSER_GROUP) ?? [], [task]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const pickNeed = (need: ModelNeed) => {
    const ref = suggestModel(models, need);
    setNoModel(!ref);
    if (ref) set('model', ref);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const result = draftToInput(draft, new Date(), others);
    setErrors(result.errors ?? {});
    setFailure(null);
    if (!result.input) return;
    setBusy(true);
    try {
      const saved = task
        ? await update(task.id, { ...result.input, enabled: task.enabled })
        : await create(result.input);
      show({ kind: 'detail', id: saved.id });
    } catch (error) {
      setFailure(taskErrorText(t, error));
    } finally {
      setBusy(false);
    }
  };

  const error = (key: keyof DraftErrors) =>
    errors[key] && (
      <p id={`${ids}-${key}-error`} role="alert" className="mt-1 text-sm text-danger">
        {t.t(errors[key])}
      </p>
    );
  const invalid = (key: keyof DraftErrors) =>
    errors[key] ? { 'aria-invalid': true, 'aria-describedby': `${ids}-${key}-error` } : {};

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="space-y-5">
      <h2 className="text-xl font-semibold">
        {task ? t.t('tasks.form.editTitle') : t.t('tasks.form.newTitle')}
      </h2>

      <Field
        label={t.t('tasks.form.title')}
        help={t.t('tasks.form.titleHelp')}
        htmlFor={`${ids}-title`}
      >
        <Input
          id={`${ids}-title`}
          value={draft.title}
          maxLength={100}
          dir="auto"
          onChange={(e) => set('title', e.target.value)}
          {...invalid('title')}
        />
        {error('title')}
      </Field>

      <Field
        label={t.t('tasks.form.instructions')}
        help={t.t('tasks.form.instructionsHelp')}
        htmlFor={`${ids}-instructions`}
      >
        <Textarea
          id={`${ids}-instructions`}
          rows={6}
          maxLength={8000}
          dir="auto"
          value={draft.instructions}
          onChange={(e) => set('instructions', e.target.value)}
          {...invalid('instructions')}
        />
        {error('instructions')}
      </Field>

      <div>
        <p id={`${ids}-model`} className="mb-1.5 text-sm font-medium">
          {t.t('tasks.form.model')}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-labelledby={`${ids}-model`}
            className="rounded-lg border border-line-strong"
          >
            <ModelPicker
              value={draft.model}
              emptyLabel={t.t('tasks.modelDefault')}
              onPick={(model) => {
                setNoModel(false);
                set('model', model);
              }}
              onConnect={() => go('settings', 'providers')}
            />
          </div>
          {draft.model && (
            <Button size="sm" variant="ghost" onClick={() => set('model', null)}>
              {t.t('tasks.form.useDefault')}
            </Button>
          )}
        </div>
        <p className="mt-1 text-sm text-muted">{t.t('tasks.form.modelHelp')}</p>
        <div
          role="group"
          aria-label={t.t('tasks.form.needs')}
          className="mt-2 flex flex-wrap gap-1.5"
        >
          {MODEL_NEEDS.map((need) => (
            <button
              key={need}
              type="button"
              onClick={() => pickNeed(need)}
              className="rounded-full border border-line-strong px-3 py-1 text-sm transition-colors hover:bg-elevated"
            >
              {t.t(`tasks.need.${need}`)}
            </button>
          ))}
        </div>
        {noModel && (
          <p role="status" className="mt-1 text-sm text-danger">
            {t.t('tasks.err.no_model')}
          </p>
        )}
      </div>

      <fieldset className="space-y-3">
        <legend className="mb-1.5 text-sm font-medium">{t.t('tasks.form.when')}</legend>
        <Select
          aria-label={t.t('tasks.form.when')}
          value={draft.kind}
          onChange={(e) => set('kind', e.target.value as Schedule['kind'])}
        >
          {KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t.t(`tasks.form.when.${kind}`)}
            </option>
          ))}
        </Select>

        {draft.kind === 'once' && (
          <Field label={t.t('tasks.form.at')} htmlFor={`${ids}-at`}>
            <Input
              id={`${ids}-at`}
              type="datetime-local"
              value={draft.at}
              onChange={(e) => set('at', e.target.value)}
              {...invalid('at')}
            />
            {error('at')}
          </Field>
        )}

        {draft.kind === 'every' && (
          <div>
            <label htmlFor={`${ids}-every`} className="mb-1.5 block text-sm font-medium">
              {t.t('tasks.form.every')}
            </label>
            <div className="flex gap-2">
              <Input
                id={`${ids}-every`}
                type="number"
                min={1}
                inputMode="numeric"
                className="w-28"
                value={draft.everyN}
                onChange={(e) => set('everyN', e.target.value)}
                {...invalid('every')}
              />
              <Select
                aria-label={t.t('tasks.form.unit')}
                className="w-40"
                value={draft.unit}
                onChange={(e) => set('unit', e.target.value as Draft['unit'])}
              >
                <option value="minutes">{t.t('tasks.form.unit.minutes')}</option>
                <option value="hours">{t.t('tasks.form.unit.hours')}</option>
              </Select>
            </div>
            {error('every')}
          </div>
        )}

        {draft.kind === 'daily' && (
          <>
            <Field label={t.t('tasks.form.time')} htmlFor={`${ids}-time`}>
              <Input
                id={`${ids}-time`}
                type="time"
                className="w-40"
                value={draft.time}
                onChange={(e) => set('time', e.target.value)}
                {...invalid('time')}
              />
              {error('time')}
            </Field>
            <div>
              <p className="mb-1.5 text-sm font-medium">{t.t('tasks.form.days')}</p>
              <div className="flex flex-wrap gap-1.5">
                {WEEK.map((day) => {
                  const on = draft.days.includes(day);
                  return (
                    <button
                      key={day}
                      type="button"
                      aria-pressed={on}
                      aria-label={weekdayName(day, t.lang)}
                      title={weekdayName(day, t.lang)}
                      onClick={() =>
                        set('days', on ? draft.days.filter((d) => d !== day) : [...draft.days, day])
                      }
                      className={cn(
                        'h-9 min-w-12 rounded-lg border px-2 text-sm transition-colors',
                        on
                          ? 'border-accent bg-accent text-accent-fg'
                          : 'border-line-strong hover:bg-elevated',
                      )}
                    >
                      {weekdayName(day, t.lang, 'short')}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1 text-sm text-muted">{t.t('tasks.form.daysHelp')}</p>
            </div>
          </>
        )}
        {draft.kind !== 'manual' && (
          <p className="text-sm text-muted">{t.t('tasks.form.laterNote')}</p>
        )}
      </fieldset>

      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={draft.browser}
          onChange={(e) => set('browser', e.target.checked)}
          className="mt-1 size-4 accent-[var(--accent)]"
        />
        <span>
          <span className="block text-sm font-medium">{t.t('tasks.form.browser')}</span>
          <span className="block text-sm text-muted">{t.t('tasks.form.browserHelp')}</span>
        </span>
      </label>

      {failure && (
        <p role="alert" className="text-sm text-danger">
          {failure}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={busy}>
          {task ? t.t('tasks.form.save') : t.t('tasks.form.create')}
        </Button>
        <Button
          onClick={() => show(task ? { kind: 'detail', id: task.id } : { kind: 'list' })}
          disabled={busy}
        >
          {t.t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}
