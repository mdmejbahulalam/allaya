import { useId, useMemo, useRef, useState } from 'react';
import type { AutomationInput, AutomationView, WorkflowStep } from '@allaya/validation';
import type { TranslationKey } from '@allaya/localization';
import { IpcError } from '@renderer/lib/api';
import { useT } from '@renderer/lib/i18n';
import { cn } from '@renderer/lib/cn';
import { Button } from '@renderer/components/ui/button';
import { Input, Textarea } from '@renderer/components/ui/input';
import { Modal } from '@renderer/components/ui/modal';
import { Switch } from '@renderer/components/ui/switch';
import {
  ALL_DAYS,
  TRIGGER_KINDS,
  buildInput,
  emptyForm,
  type FormField,
  type FormState,
  type IntervalUnit,
} from './automation-utils';
import { WorkflowBuilder } from './workflow-builder';
import { newStep, type FoundProblem } from './workflow-edit';

/** What the form holds while it is closed (never shown). */
const BLANK: FormState = emptyForm(0);

const selectClass =
  'h-10 w-full rounded-control border border-line bg-bg-2 px-3 text-body text-fg hover:border-line-strong focus:border-accent focus:ring-2 focus:ring-accent/30 focus:outline-none';

/** Create or edit an automation. The backend checks everything again; this only saves a round trip. */
export function AutomationForm({
  initial,
  automation,
  folders,
  busy,
  onSubmit,
  onCancel,
}: {
  /** The form as it starts (built by whoever opens the dialog); `null` while the dialog is closed. */
  initial: FormState | null;
  /** The automation being edited; none to create a new one. */
  automation?: AutomationView | undefined;
  /** Names of folders Allaya may use, offered as suggestions. */
  folders: string[];
  busy: boolean;
  /** Rejects with the backend's error; the form shows it and stays open. */
  onSubmit: (input: AutomationInput) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const ids = useId();
  const open = initial !== null;
  const [form, setForm] = useState<FormState>(initial ?? BLANK);
  const [errors, setErrors] = useState<Partial<Record<FormField, TranslationKey>>>({});
  const [serverError, setServerError] = useState<string | undefined>();
  const [problem, setProblem] = useState<FoundProblem | undefined>();
  const [focusId, setFocusId] = useState<string | undefined>();
  const [seed, setSeed] = useState(initial);
  // Start afresh each time the dialog opens (adjusting state while rendering, not in an effect).
  if (initial !== seed) {
    setSeed(initial);
    if (initial) {
      setForm(initial);
      setErrors({});
      setServerError(undefined);
      setProblem(undefined);
      setFocusId(undefined);
    }
  }
  const nameRef = useRef<HTMLInputElement>(null);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const days = useMemo(() => new Set(form.days), [form.days]);
  const fieldError = (field: FormField) =>
    errors[field] ? (
      <p role="alert" className="mt-1 text-small text-danger-text">
        {t.t(errors[field])}
      </p>
    ) : null;

  const submit = async () => {
    const result = buildInput(form, Date.now());
    if (!result.ok) {
      setErrors(result.errors);
      setProblem(result.problem);
      return;
    }
    setErrors({});
    setProblem(undefined);
    setServerError(undefined);
    try {
      await onSubmit(result.input);
    } catch (error) {
      if (error instanceof IpcError) {
        const reason = error.details?.['reason'];
        if (reason === 'in_the_past') setErrors({ onceAt: 'automations.form.past' });
        else if (typeof reason === 'string' && t.has(`automations.workflow.problem.${reason}`)) {
          setProblem({ problem: reason as FoundProblem['problem'] });
          setErrors({ workflow: 'automations.workflow.invalid' });
        } else if (error.code === 'LIMIT_EXCEEDED')
          setServerError(t.t('automations.limit', { count: 20 }));
        else if (
          error.code === 'PATH_NOT_ALLOWED' ||
          error.code === 'UNSAFE_PATH' ||
          error.code === 'NOT_FOUND'
        ) {
          setErrors({ folder: 'automations.form.needFolder' });
        } else {
          setServerError(
            t.has(`errors.ipc.${error.code}`)
              ? t.t(`errors.ipc.${error.code}` as TranslationKey)
              : t.t('errors.ipc.UNKNOWN'),
          );
        }
      } else setServerError(t.t('errors.ipc.UNKNOWN'));
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => !next && onCancel()}
      title={t.t(automation ? 'automations.edit' : 'automations.new')}
      size={form.mode === 'workflow' ? 'lg' : 'md'}
      initialFocusRef={nameRef}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            {t.t('confirmation.cancel')}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            {t.t('common.save')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div>
          <label htmlFor={`${ids}-name`} className="mb-1.5 block text-small font-medium text-fg">
            {t.t('automations.form.name')}
          </label>
          <Input
            id={`${ids}-name`}
            ref={nameRef}
            value={form.name}
            maxLength={80}
            placeholder={t.t('automations.form.namePlaceholder')}
            invalid={Boolean(errors.name)}
            onChange={(event) => set('name', event.target.value)}
          />
          {fieldError('name')}
        </div>

        <fieldset>
          <legend className="mb-1.5 text-small font-medium text-fg">
            {t.t('automations.workflow.mode.label')}
          </legend>
          <div role="radiogroup" className="flex flex-wrap gap-1.5">
            {(['single', 'workflow'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={form.mode === mode}
                onClick={() => {
                  if (mode === form.mode) return;
                  setForm((current) => {
                    // Switching to steps starts from what was typed, so nothing is lost.
                    const seeded: WorkflowStep[] =
                      mode === 'workflow' && current.steps.length === 0
                        ? [
                            {
                              ...newStep('action', []),
                              instruction: current.instruction,
                            } as WorkflowStep,
                          ]
                        : current.steps;
                    return { ...current, mode, steps: seeded };
                  });
                  setErrors({});
                  setProblem(undefined);
                }}
                className={cn(
                  'h-9 rounded-control border px-3 text-small font-medium transition-colors',
                  form.mode === mode
                    ? 'border-accent bg-accent/15 text-accent-text'
                    : 'border-line text-muted hover:border-line-strong hover:text-fg',
                )}
              >
                {t.t(`automations.workflow.mode.${mode}` as TranslationKey)}
              </button>
            ))}
          </div>
        </fieldset>

        {form.mode === 'single' ? (
          <div>
            <label
              htmlFor={`${ids}-instruction`}
              className="mb-1.5 block text-small font-medium text-fg"
            >
              {t.t('automations.form.instruction')}
            </label>
            <Textarea
              id={`${ids}-instruction`}
              autoGrow
              rows={3}
              maxRows={8}
              maxLength={2000}
              value={form.instruction}
              placeholder={t.t('automations.form.instructionPlaceholder')}
              invalid={Boolean(errors.instruction)}
              onChange={(event) => set('instruction', event.target.value)}
            />
            {fieldError('instruction')}
            <p className="mt-1 text-caption text-muted">
              {t.t('automations.form.instructionHint')}
            </p>
          </div>
        ) : (
          <div>
            <p className="mb-2 text-caption text-muted">{t.t('automations.workflow.hint')}</p>
            <WorkflowBuilder
              steps={form.steps}
              triggerKind={form.kind}
              problem={problem}
              focusId={focusId}
              onChange={(steps, added) => {
                set('steps', steps);
                setFocusId(added);
                if (errors.workflow) {
                  setErrors({});
                  setProblem(undefined);
                }
              }}
            />
            {errors.workflow && (
              <p role="alert" className="mt-2 text-small text-danger-text">
                {t.t(
                  problem && !problem.stepId
                    ? (`automations.workflow.problem.${problem.problem}` as TranslationKey)
                    : errors.workflow,
                )}
              </p>
            )}
          </div>
        )}

        <div>
          <label htmlFor={`${ids}-kind`} className="mb-1.5 block text-small font-medium text-fg">
            {t.t('automations.form.when')}
          </label>
          <select
            id={`${ids}-kind`}
            className={selectClass}
            value={form.kind}
            onChange={(event) => set('kind', event.target.value as FormState['kind'])}
          >
            {TRIGGER_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t.t(`automations.form.kind.${kind}`)}
              </option>
            ))}
          </select>
        </div>

        {form.kind === 'once' && (
          <div>
            <label htmlFor={`${ids}-at`} className="mb-1.5 block text-small font-medium text-fg">
              {t.t('automations.form.at')}
            </label>
            <Input
              id={`${ids}-at`}
              type="datetime-local"
              value={form.onceAt}
              invalid={Boolean(errors.onceAt)}
              onChange={(event) => set('onceAt', event.target.value)}
            />
            {fieldError('onceAt')}
          </div>
        )}

        {form.kind === 'interval' && (
          <div>
            <label htmlFor={`${ids}-every`} className="mb-1.5 block text-small font-medium text-fg">
              {t.t('automations.form.every')}
            </label>
            <div className="flex gap-2">
              <Input
                id={`${ids}-every`}
                type="number"
                min={1}
                inputMode="numeric"
                className="w-28"
                value={form.everyValue}
                invalid={Boolean(errors.every)}
                onChange={(event) => set('everyValue', event.target.value)}
              />
              <select
                aria-label={t.t('automations.form.every')}
                className={cn(selectClass, 'w-40')}
                value={form.everyUnit}
                onChange={(event) => set('everyUnit', event.target.value as IntervalUnit)}
              >
                {(['minutes', 'hours', 'days'] as const).map((unit) => (
                  <option key={unit} value={unit}>
                    {t.t(`automations.form.unit.${unit}`)}
                  </option>
                ))}
              </select>
            </div>
            {fieldError('every')}
          </div>
        )}

        {(form.kind === 'daily' || form.kind === 'monthly') && (
          <div>
            <label htmlFor={`${ids}-time`} className="mb-1.5 block text-small font-medium text-fg">
              {t.t('automations.form.time')}
            </label>
            <Input
              id={`${ids}-time`}
              type="time"
              className="w-40"
              value={form.time}
              invalid={Boolean(errors.time)}
              onChange={(event) => set('time', event.target.value)}
            />
            {fieldError('time')}
          </div>
        )}

        {form.kind === 'daily' && (
          <fieldset>
            <legend className="mb-1.5 text-small font-medium text-fg">
              {t.t('automations.form.days')}
            </legend>
            <div className="flex flex-wrap gap-1.5">
              {ALL_DAYS.map((day) => {
                const on = days.has(day);
                return (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={on}
                    aria-label={t.t(`automations.day.long.${day}` as TranslationKey)}
                    onClick={() =>
                      set('days', on ? form.days.filter((d) => d !== day) : [...form.days, day])
                    }
                    className={cn(
                      'h-9 min-w-12 rounded-control border px-3 text-small font-medium transition-colors',
                      on
                        ? 'border-accent bg-accent/15 text-accent-text'
                        : 'border-line text-muted hover:border-line-strong hover:text-fg',
                    )}
                  >
                    {t.t(`automations.day.short.${day}` as TranslationKey)}
                  </button>
                );
              })}
            </div>
            {fieldError('days')}
          </fieldset>
        )}

        {form.kind === 'monthly' && (
          <div>
            <label htmlFor={`${ids}-day`} className="mb-1.5 block text-small font-medium text-fg">
              {t.t('automations.form.day')}
            </label>
            <Input
              id={`${ids}-day`}
              type="number"
              min={1}
              max={28}
              inputMode="numeric"
              className="w-28"
              value={form.day}
              invalid={Boolean(errors.day)}
              onChange={(event) => set('day', event.target.value)}
            />
            {fieldError('day')}
          </div>
        )}

        {form.kind === 'new_file' && (
          <div>
            <label
              htmlFor={`${ids}-folder`}
              className="mb-1.5 block text-small font-medium text-fg"
            >
              {t.t('automations.form.folder')}
            </label>
            <Input
              id={`${ids}-folder`}
              list={`${ids}-folders`}
              value={form.folder}
              maxLength={1024}
              placeholder="Downloads"
              autoComplete="off"
              spellCheck={false}
              invalid={Boolean(errors.folder)}
              onChange={(event) => set('folder', event.target.value)}
            />
            <datalist id={`${ids}-folders`}>
              {folders.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            {fieldError('folder')}
            <p className="mt-1 text-caption text-muted">{t.t('automations.form.folderHint')}</p>
          </div>
        )}

        {(form.kind === 'once' ||
          form.kind === 'interval' ||
          form.kind === 'daily' ||
          form.kind === 'monthly') && (
          <div>
            <label
              htmlFor={`${ids}-missed`}
              className="mb-1.5 block text-small font-medium text-fg"
            >
              {t.t('automations.form.missed.label')}
            </label>
            <select
              id={`${ids}-missed`}
              className={selectClass}
              value={form.missed}
              onChange={(event) => set('missed', event.target.value as FormState['missed'])}
            >
              <option value="skip">{t.t('automations.form.missed.skip')}</option>
              <option value="run_once">{t.t('automations.form.missed.run_once')}</option>
            </select>
          </div>
        )}

        <label className="flex items-center gap-3 text-small text-fg">
          <Switch
            checked={form.planFirst}
            onCheckedChange={(checked) => set('planFirst', checked)}
            label={t.t('automations.form.planFirst')}
          />
          {t.t('automations.form.planFirst')}
        </label>

        {serverError && (
          <p role="alert" className="text-small text-danger-text">
            {serverError}
          </p>
        )}
      </form>
    </Modal>
  );
}
