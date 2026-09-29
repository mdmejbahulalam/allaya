import { Activity } from 'lucide-react';
import { useT } from '@renderer/lib/i18n';
import { cn } from '@renderer/lib/cn';
import { useAgentStore } from '@renderer/stores/agent';
import { ActivityItem } from '@renderer/components/domain/activity-item';
import { AIStatus } from '@renderer/components/domain/ai-status';

/** Live activity (§41): what Allaya is doing now, and the last few things it did. */
export function ContextPanel({ className }: { className?: string }) {
  const t = useT();
  const { status, detail, activity, isWorking } = useAgentStore();
  return (
    <aside
      aria-label={t.t('a11y.contextPanel')}
      className={cn('flex h-full flex-col bg-bg-2', className)}
    >
      <div className="flex items-center gap-2 px-4 pt-4 pb-3">
        <Activity aria-hidden size={16} className="text-muted" />
        <h2 className="text-caption font-semibold tracking-wider text-muted uppercase">
          {t.t('context.title')}
        </h2>
      </div>
      <div className="border-b border-line px-4 pb-4">
        <AIStatus variant="inline" status={status} {...(detail ? { detail } : {})} />
        <p className="sr-only" aria-live="polite">
          {isWorking ? t.t('activity.working') : t.t('activity.idle')}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {activity.length === 0 ? (
          <p className="text-small text-muted">{t.t('context.empty')}</p>
        ) : (
          <>
            <h3 className="mb-3 text-caption font-medium text-muted">{t.t('context.recent')}</h3>
            <ol className="space-y-4">
              {activity.map((entry) => (
                <ActivityItem key={entry.id} entry={entry} />
              ))}
            </ol>
          </>
        )}
      </div>
    </aside>
  );
}
