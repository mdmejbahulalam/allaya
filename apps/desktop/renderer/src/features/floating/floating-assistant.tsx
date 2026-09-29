import { OctagonX, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AgentStatusEvent } from '@allaya/validation';
import { invoke, subscribe } from '@renderer/lib/api';
import { useT } from '@renderer/lib/i18n';
import { cn } from '@renderer/lib/cn';
import { Button } from '@renderer/components/ui/button';

/**
 * The small always-on-top bar: what Allaya is doing, STOP, and the way back to the main window. It listens to the same
 * status events as the main window and asks the main process to do the work (it holds no state of its own).
 */
export function FloatingAssistant() {
  const t = useT();
  const [status, setStatus] = useState<AgentStatusEvent | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke('agent:getStatus').then(
      (current) => !cancelled && setStatus(current),
      () => undefined,
    );
    const off = subscribe('agent:status', (event) => setStatus(event));
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const working = (status?.activeRuns ?? 0) > 0;
  const waiting = status?.status === 'paused';
  const label = waiting
    ? t.t('floating.waiting')
    : working
      ? t.t('floating.working')
      : t.t('floating.ready');

  return (
    <div
      role="group"
      aria-label={t.t('floating.label')}
      className="app-drag glass flex h-screen w-screen items-center gap-2 border border-line px-3"
    >
      <span
        aria-hidden
        className="gradient-accent flex size-7 shrink-0 items-center justify-center rounded-lg text-white"
      >
        <Sparkles size={15} />
      </span>
      <button
        type="button"
        onClick={() => void invoke('desktop:showApp').catch(() => undefined)}
        title={t.t('floating.open')}
        className="app-no-drag flex min-w-0 flex-1 items-center gap-2 rounded-control px-1 text-start focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none"
      >
        <span
          aria-hidden
          className={cn(
            'size-2 shrink-0 rounded-full',
            waiting ? 'bg-warning' : working ? 'animate-pulse-soft bg-accent' : 'bg-success',
          )}
        />
        <span role="status" className="truncate text-small font-medium text-fg">
          {label}
        </span>
      </button>
      <Button
        size="sm"
        variant="danger"
        className="app-no-drag"
        leftIcon={<OctagonX size={14} />}
        title={t.t('floating.stopHint')}
        onClick={() => void invoke('desktop:stopEverything').catch(() => undefined)}
      >
        {t.t('floating.stop')}
      </Button>
    </div>
  );
}
