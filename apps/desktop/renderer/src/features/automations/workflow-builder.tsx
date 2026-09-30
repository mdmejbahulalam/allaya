import {
  ArrowDown,
  ArrowUp,
  CircleStop,
  GitBranch,
  Hand,
  Play,
  Repeat,
  Trash2,
} from 'lucide-react';
import { useId, type ReactNode } from 'react';
import {
  MAX_LOOP_TIMES,
  MAX_WORKFLOW_DEPTH,
  MAX_WORKFLOW_STEPS,
  type WorkflowCondition,
  type WorkflowStep,
} from '@allaya/validation';
import type { TranslationKey } from '@allaya/localization';
import { useT } from '@renderer/lib/i18n';
import { cn } from '@renderer/lib/cn';
import { Button } from '@renderer/components/ui/button';
import { IconButton } from '@renderer/components/ui/icon-button';
import { Input, Textarea } from '@renderer/components/ui/input';
import { Switch } from '@renderer/components/ui/switch';
import { ALL_DAYS } from './automation-utils';
import {
  STEP_TYPES,
  conditionOf,
  countSteps,
  move,
  newStep,
  type FoundProblem,
  type StepType,
} from './workflow-edit';

const selectClass =
  'h-10 w-full rounded-control border border-line bg-bg-2 px-3 text-body text-fg hover:border-line-strong focus:border-accent focus:ring-2 focus:ring-accent/30 focus:outline-none';

const ICONS: Record<StepType, ReactNode> = {
  action: <Play size={16} />,
  condition: <GitBranch size={16} />,
  loop: <Repeat size={16} />,
  approval: <Hand size={16} />,
  stop: <CircleStop size={16} />,
};

interface Context {
  whole: WorkflowStep[];
  /** What starts the automation (a "for each new file" loop needs a folder). */
  triggerKind: string;
  problem: FoundProblem | undefined;
  focusId: string | undefined;
  total: number;
}

/**
 * The visual editor for a workflow: a top-to-bottom flow of step cards, where a condition holds two lanes and a
 * loop holds one. It edits a plain list of steps and never runs anything; the backend checks the result again.
 */
export function WorkflowBuilder({
  steps,
  triggerKind,
  problem,
  focusId,
  onChange,
}: {
  steps: WorkflowStep[];
  triggerKind: string;
  problem: FoundProblem | undefined;
  /** A step just added: its first field takes focus. */
  focusId: string | undefined;
  onChange: (steps: WorkflowStep[], added?: string) => void;
}) {
  const t = useT();
  const context: Context = {
    whole: steps,
    triggerKind,
    problem,
    focusId,
    total: countSteps(steps),
  };
  return (
    <div className="flex flex-col gap-2" data-testid="workflow-builder">
      <Lane
        steps={steps}
        depth={1}
        context={context}
        label={t.t('automations.workflow.title')}
        onChange={(next, added) => onChange(next, added)}
      />
      <p className="text-caption text-muted">
        {t.t('automations.workflow.limits.steps', { count: MAX_WORKFLOW_STEPS })}
      </p>
    </div>
  );
}

function Lane({
  steps,
  depth,
  context,
  label,
  onChange,
}: {
  steps: WorkflowStep[];
  depth: number;
  context: Context;
  label: string;
  onChange: (steps: WorkflowStep[], added?: string) => void;
}) {
  const t = useT();
  const full = context.total >= MAX_WORKFLOW_STEPS;
  const deep = depth >= MAX_WORKFLOW_DEPTH;
  const add = (type: StepType) => {
    const step = newStep(type, context.whole);
    onChange([...steps, step], step.id);
  };

  return (
    <div role="group" aria-label={label} className="flex flex-col gap-2">
      {steps.length === 0 && (
        <p className="rounded-control border border-dashed border-line px-3 py-2 text-small text-muted">
          {t.t('automations.workflow.empty')}
        </p>
      )}
      <ol className="flex flex-col gap-2">
        {steps.map((step, index) => (
          <li key={step.id}>
            <StepCard
              step={step}
              index={index}
              siblings={steps.length}
              depth={depth}
              context={context}
              onChange={(next) => onChange(steps.map((s, i) => (i === index ? next : s)))}
              onMove={(by) => onChange(move(steps, index, by))}
              onRemove={() => onChange(steps.filter((_, i) => i !== index))}
            />
          </li>
        ))}
      </ol>
      <div
        role="group"
        aria-label={t.t('automations.workflow.add.label')}
        className="flex flex-wrap gap-1.5"
      >
        {STEP_TYPES.map((type) => {
          const blocked = full || (deep && (type === 'condition' || type === 'loop'));
          return (
            <Button
              key={type}
              size="sm"
              variant="outline"
              leftIcon={ICONS[type]}
              disabled={blocked}
              title={
                blocked
                  ? t.t(
                      full
                        ? 'automations.workflow.limits.steps'
                        : 'automations.workflow.limits.depth',
                      { count: full ? MAX_WORKFLOW_STEPS : MAX_WORKFLOW_DEPTH },
                    )
                  : undefined
              }
              onClick={() => add(type)}
            >
              {t.t(`automations.workflow.add.${type}` as TranslationKey)}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

function StepCard({
  step,
  index,
  siblings,
  depth,
  context,
  onChange,
  onMove,
  onRemove,
}: {
  step: WorkflowStep;
  index: number;
  siblings: number;
  depth: number;
  context: Context;
  onChange: (step: WorkflowStep) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const ids = useId();
  const n = index + 1;
  const problem = context.problem?.stepId === step.id ? context.problem.problem : undefined;
  const focus = context.focusId === step.id;
  const typeName = t.t(`automations.workflow.step.${step.type}` as TranslationKey);
  const field = (key: string) => `${ids}-${key}`;
  const labelField = (
    <div>
      <label htmlFor={field('label')} className="mb-1 block text-caption font-medium text-muted">
        {t.t('automations.workflow.field.label')}
      </label>
      <Input
        id={field('label')}
        value={step.label ?? ''}
        maxLength={80}
        onChange={(event) => onChange({ ...step, label: event.target.value })}
      />
    </div>
  );

  return (
    <section
      aria-label={t.t('automations.workflow.stepLabel', { n, type: typeName })}
      data-testid="workflow-step"
      data-step-type={step.type}
      className={cn(
        'flex flex-col gap-3 rounded-lg border bg-elevated/40 p-3',
        problem ? 'border-danger/60' : 'border-line',
      )}
    >
      <header className="flex items-center gap-2">
        <span aria-hidden className="text-accent-text">
          {ICONS[step.type]}
        </span>
        <h4 className="text-small font-semibold text-fg">
          {n}. {typeName}
        </h4>
        <span className="ms-auto flex gap-0.5">
          <IconButton
            size="sm"
            label={t.t('automations.workflow.moveUp', { n })}
            icon={<ArrowUp size={14} />}
            disabled={index === 0}
            onClick={() => onMove(-1)}
          />
          <IconButton
            size="sm"
            label={t.t('automations.workflow.moveDown', { n })}
            icon={<ArrowDown size={14} />}
            disabled={index === siblings - 1}
            onClick={() => onMove(1)}
          />
          <IconButton
            size="sm"
            label={t.t('automations.workflow.remove', { n })}
            icon={<Trash2 size={14} />}
            onClick={onRemove}
          />
        </span>
      </header>

      {step.type === 'action' && (
        <>
          <div>
            <label
              htmlFor={field('instruction')}
              className="mb-1 block text-caption font-medium text-muted"
            >
              {t.t('automations.workflow.field.instruction')}
            </label>
            <Textarea
              id={field('instruction')}
              autoFocus={focus}
              autoGrow
              rows={2}
              maxRows={6}
              maxLength={2000}
              value={step.instruction}
              placeholder={t.t('automations.form.instructionPlaceholder')}
              invalid={problem === 'empty_text'}
              onChange={(event) => onChange({ ...step, instruction: event.target.value })}
            />
          </div>
          {labelField}
          <label className="flex items-center gap-3 text-small text-fg">
            <Switch
              checked={step.keepGoing === true}
              onCheckedChange={(on) => onChange({ ...step, keepGoing: on })}
              label={t.t('automations.workflow.field.keepGoing')}
            />
            {t.t('automations.workflow.field.keepGoing')}
          </label>
          {index > 0 || depth > 1 ? (
            <label className="flex items-center gap-3 text-small text-fg">
              <Switch
                checked={step.usePrevious === true}
                onCheckedChange={(on) => onChange({ ...step, usePrevious: on })}
                label={t.t('automations.workflow.field.usePrevious')}
              />
              {t.t('automations.workflow.field.usePrevious')}
            </label>
          ) : null}
        </>
      )}

      {step.type === 'approval' && (
        <div>
          <label
            htmlFor={field('message')}
            className="mb-1 block text-caption font-medium text-muted"
          >
            {t.t('automations.workflow.field.message')}
          </label>
          <Input
            id={field('message')}
            autoFocus={focus}
            value={step.message}
            maxLength={300}
            placeholder={t.t('automations.workflow.field.messagePlaceholder')}
            aria-invalid={problem === 'empty_text'}
            onChange={(event) => onChange({ ...step, message: event.target.value })}
          />
          <p className="mt-1 text-caption text-muted">{t.t('automations.workflow.approvalHint')}</p>
        </div>
      )}

      {step.type === 'stop' && (
        <p className="text-small text-muted">{t.t('automations.workflow.stopHint')}</p>
      )}

      {step.type === 'condition' && (
        <>
          <ConditionEditor
            step={step}
            ids={ids}
            focus={focus}
            onChange={onChange}
            problem={problem}
          />
          <div className="grid gap-3 md:grid-cols-2">
            <div className="flex flex-col gap-1.5 border-s-2 border-success/50 ps-3">
              <h5 className="text-caption font-semibold text-success">
                {t.t('automations.workflow.lane.then')}
              </h5>
              <Lane
                steps={step.then}
                depth={depth + 1}
                context={context}
                label={t.t('automations.workflow.lane.thenFor', { n })}
                onChange={(next) => onChange({ ...step, then: next })}
              />
            </div>
            <div className="flex flex-col gap-1.5 border-s-2 border-line-strong ps-3">
              <h5 className="text-caption font-semibold text-muted">
                {t.t('automations.workflow.lane.otherwise')}
              </h5>
              <Lane
                steps={step.else}
                depth={depth + 1}
                context={context}
                label={t.t('automations.workflow.lane.otherwiseFor', { n })}
                onChange={(next) => onChange({ ...step, else: next })}
              />
            </div>
          </div>
        </>
      )}

      {step.type === 'loop' && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor={field('over')}
                className="mb-1 block text-caption font-medium text-muted"
              >
                {t.t('automations.workflow.field.repeat')}
              </label>
              <select
                id={field('over')}
                className={selectClass}
                value={step.over.kind}
                onChange={(event) =>
                  onChange({
                    ...step,
                    over:
                      event.target.value === 'files'
                        ? { kind: 'files' }
                        : { kind: 'times', times: 3 },
                  })
                }
              >
                <option value="times">{t.t('automations.workflow.loop.times')}</option>
                <option value="files" disabled={context.triggerKind !== 'new_file'}>
                  {t.t('automations.workflow.loop.files')}
                </option>
              </select>
              {context.triggerKind !== 'new_file' && (
                <p className="mt-1 text-caption text-muted">
                  {t.t('automations.workflow.limits.filesNeedFolder')}
                </p>
              )}
            </div>
            {step.over.kind === 'times' && (
              <div>
                <label
                  htmlFor={field('times')}
                  className="mb-1 block text-caption font-medium text-muted"
                >
                  {t.t('automations.workflow.field.times')}
                </label>
                <Input
                  id={field('times')}
                  type="number"
                  min={1}
                  max={MAX_LOOP_TIMES}
                  inputMode="numeric"
                  className="w-28"
                  value={step.over.times}
                  onChange={(event) =>
                    onChange({
                      ...step,
                      over: { kind: 'times', times: Number(event.target.value) },
                    })
                  }
                />
              </div>
            )}
          </div>
          <div className="flex flex-col gap-1.5 border-s-2 border-accent/50 ps-3">
            <Lane
              steps={step.body}
              depth={depth + 1}
              context={context}
              label={t.t('automations.workflow.lane.insideFor', { n })}
              onChange={(next) => onChange({ ...step, body: next })}
            />
          </div>
        </>
      )}

      {problem && (
        <p role="alert" className="text-small text-danger-text">
          {t.t(`automations.workflow.problem.${problem}` as TranslationKey)}
        </p>
      )}
    </section>
  );
}

function ConditionEditor({
  step,
  ids,
  focus,
  onChange,
  problem,
}: {
  step: Extract<WorkflowStep, { type: 'condition' }>;
  ids: string;
  focus: boolean;
  onChange: (step: WorkflowStep) => void;
  problem: string | undefined;
}) {
  const t = useT();
  const cond = step.if;
  const set = (next: WorkflowCondition) => onChange({ ...step, if: next });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div>
        <label htmlFor={`${ids}-kind`} className="mb-1 block text-caption font-medium text-muted">
          {t.t('automations.workflow.cond.kind')}
        </label>
        <select
          id={`${ids}-kind`}
          autoFocus={focus}
          className={selectClass}
          value={cond.kind}
          onChange={(event) => set(conditionOf(event.target.value as WorkflowCondition['kind']))}
        >
          {(['previous', 'summary', 'weekday', 'time_between'] as const).map((kind) => (
            <option key={kind} value={kind}>
              {t.t(`automations.workflow.cond.${kind}` as TranslationKey)}
            </option>
          ))}
        </select>
      </div>

      {cond.kind === 'previous' && (
        <div>
          <label htmlFor={`${ids}-is`} className="mb-1 block text-caption font-medium text-muted">
            {t.t('automations.workflow.cond.is')}
          </label>
          <select
            id={`${ids}-is`}
            className={selectClass}
            value={cond.is}
            onChange={(event) =>
              set({ kind: 'previous', is: event.target.value as 'succeeded' | 'failed' })
            }
          >
            <option value="succeeded">{t.t('automations.workflow.cond.succeeded')}</option>
            <option value="failed">{t.t('automations.workflow.cond.failed')}</option>
          </select>
        </div>
      )}

      {cond.kind === 'summary' && (
        <div>
          <label
            htmlFor={`${ids}-contains`}
            className="mb-1 block text-caption font-medium text-muted"
          >
            {t.t('automations.workflow.field.contains')}
          </label>
          <Input
            id={`${ids}-contains`}
            value={cond.contains}
            maxLength={200}
            aria-invalid={problem === 'empty_text'}
            onChange={(event) => set({ kind: 'summary', contains: event.target.value })}
          />
        </div>
      )}

      {cond.kind === 'weekday' && (
        <fieldset className="sm:col-span-2">
          <legend className="mb-1 text-caption font-medium text-muted">
            {t.t('automations.form.days')}
          </legend>
          <div className="flex flex-wrap gap-1.5">
            {ALL_DAYS.map((day) => {
              const on = cond.days.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={on}
                  aria-label={t.t(`automations.day.long.${day}` as TranslationKey)}
                  onClick={() => {
                    const days = on ? cond.days.filter((d) => d !== day) : [...cond.days, day];
                    set({
                      kind: 'weekday',
                      days: days.length ? days.sort((a, b) => a - b) : cond.days,
                    });
                  }}
                  className={cn(
                    'h-8 min-w-11 rounded-control border px-2.5 text-small font-medium transition-colors',
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
        </fieldset>
      )}

      {cond.kind === 'time_between' && (
        <div className="flex items-end gap-2 sm:col-span-2">
          <div>
            <label
              htmlFor={`${ids}-from`}
              className="mb-1 block text-caption font-medium text-muted"
            >
              {t.t('automations.workflow.field.from')}
            </label>
            <Input
              id={`${ids}-from`}
              type="time"
              className="w-36"
              value={cond.from}
              onChange={(event) =>
                set({ kind: 'time_between', from: event.target.value, to: cond.to })
              }
            />
          </div>
          <div>
            <label htmlFor={`${ids}-to`} className="mb-1 block text-caption font-medium text-muted">
              {t.t('automations.workflow.field.to')}
            </label>
            <Input
              id={`${ids}-to`}
              type="time"
              className="w-36"
              value={cond.to}
              onChange={(event) =>
                set({ kind: 'time_between', from: cond.from, to: event.target.value })
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}
