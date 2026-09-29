import { Check, ChevronDown, Circle, Minus, X } from 'lucide-react';
import { useState } from 'react';
import type { TimelineStepState } from '@allaya/types';
import { useT } from '@renderer/lib/i18n';
import { cn } from '@renderer/lib/cn';

export interface TimelineStep {
  id: string;
  title: string;
  state: TimelineStepState;
  detail?: string;
  durationMs?: number;
}

function StepIcon({ state }: { state: TimelineStepState }) {
  const base = 'flex size-6 shrink-0 items-center justify-center rounded-full border';
  switch (state) {
    case 'done':
      return (
        <span aria-hidden className={cn(base, 'border-success/40 bg-success/15 text-success')}>
          <Check size={14} strokeWidth={3} />
        </span>
      );
    case 'running':
      return (
        <span aria-hidden className={cn(base, 'border-accent/50 bg-accent/15')}>
          <span className="size-2.5 rounded-full bg-accent animate-pulse-soft" />
        </span>
      );
    case 'failed':
      return (
        <span aria-hidden className={cn(base, 'border-danger/40 bg-danger/15 text-danger-text')}>
          <X size={14} strokeWidth={3} />
        </span>
      );
    case 'skipped':
      return (
        <span aria-hidden className={cn(base, 'border-line text-muted')}>
          <Minus size={14} />
        </span>
      );
    default:
      return (
        <span aria-hidden className={cn(base, 'border-line text-muted')}>
          <Circle size={8} />
        </span>
      );
  }
}

const stateLabelKey = {
  done: 'taskState.COMPLETED',
  running: 'taskState.EXECUTING',
  pending: 'taskState.READY',
  failed: 'taskState.FAILED',
  skipped: 'common.none',
} as const;

/** Task execution visualization (§39): never just "Working…" — always which step, and what's next. */
export function Timeline({ steps, className }: { steps: TimelineStep[]; className?: string }) {
  const t = useT();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <ol className={cn('relative space-y-1', className)}>
      {steps.map((step, index) => {
        const open = expanded.has(step.id);
        const last = index === steps.length - 1;
        return (
          <li key={step.id} className="relative flex gap-3">
            {!last && (
              <span
                aria-hidden
                className="absolute start-3 top-7 bottom-[-4px] w-px -translate-x-1/2 bg-line"
              />
            )}
            <StepIcon state={step.state} />
            <div className="min-w-0 flex-1 pb-3">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'text-body',
                    step.state === 'pending' || step.state === 'skipped' ? 'text-muted' : 'text-fg',
                    step.state === 'running' && 'font-medium',
                  )}
                >
                  {step.title}
                </span>
                <span className="sr-only">{t.t(stateLabelKey[step.state])}</span>
                {step.durationMs !== undefined && (
                  <span className="text-caption text-muted tabular-nums">
                    {t.formatDuration(step.durationMs)}
                  </span>
                )}
                {step.detail && (
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-label={t.t('common.details')}
                    onClick={() => toggle(step.id)}
                    className="ms-auto flex size-6 items-center justify-center rounded-md text-muted hover:bg-elevated hover:text-fg"
                  >
                    <ChevronDown
                      size={16}
                      className={cn('transition-transform duration-200', open && 'rotate-180')}
                    />
                  </button>
                )}
              </div>
              {step.detail && open && (
                <p className="mt-1 rounded-lg bg-bg-2 px-3 py-2 font-mono text-small break-words text-muted">
                  {step.detail}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
