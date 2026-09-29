import {
  CheckCircle2,
  CircleAlert,
  CircleSlash,
  Hourglass,
  Loader2,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import type { ActionRecord } from '@allaya/validation';
import { useT } from '@renderer/lib/i18n';
import { cn } from '@renderer/lib/cn';
import { Badge } from '@renderer/components/ui/badge';

const ICON: Record<ActionRecord['status'], typeof Loader2> = {
  running: Loader2,
  awaiting_confirmation: Hourglass,
  success: CheckCircle2,
  failed: XCircle,
  denied: CircleSlash,
  rejected: CircleSlash,
  cancelled: CircleSlash,
  invalid: CircleAlert,
  unknown_tool: CircleAlert,
  unsupported: CircleAlert,
};

const TONE: Record<ActionRecord['status'], string> = {
  running: 'text-accent-text',
  awaiting_confirmation: 'text-warning',
  success: 'text-success',
  failed: 'text-danger-text',
  denied: 'text-muted',
  rejected: 'text-muted',
  cancelled: 'text-muted',
  invalid: 'text-danger-text',
  unknown_tool: 'text-muted',
  unsupported: 'text-muted',
};

/**
 * What Allaya did on the computer while writing this reply — each step with its outcome and whether the effect
 * was actually checked. "Done" alone is never shown for an effect that could not be verified.
 */
export function ActionTimeline({ actions }: { actions: readonly ActionRecord[] }) {
  const t = useT();
  if (actions.length === 0) return null;
  return (
    <section aria-label={t.t('tools.actionsLabel')} className="mt-3">
      <ol className="space-y-1.5">
        {actions.map((action) => {
          const Icon = ICON[action.status];
          const verification =
            action.verification &&
            action.verification !== 'not_applicable' &&
            action.status === 'success'
              ? t.t(`tools.verification.${action.verification}`)
              : '';
          return (
            <li
              key={action.callId}
              data-status={action.status}
              className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-control border border-line bg-surface px-3 py-2 text-small"
            >
              <Icon
                aria-hidden
                size={16}
                className={cn(
                  'shrink-0',
                  TONE[action.status],
                  action.status === 'running' && 'animate-spin',
                )}
              />
              <span className="min-w-0 flex-1 text-fg">{action.summary || action.tool}</span>
              <span className={cn('shrink-0', TONE[action.status])}>
                {t.t(`tools.status.${action.status}`)}
              </span>
              {action.risk && action.risk !== 'LOW' && (
                <Badge tone={action.risk === 'MEDIUM' ? 'warning' : 'danger'}>
                  {t.t(`risk.${action.risk}`)}
                </Badge>
              )}
              {verification && (
                <Badge tone={action.verification === 'verified' ? 'success' : 'neutral'}>
                  {action.verification === 'verified' && <ShieldCheck aria-hidden size={12} />}
                  {verification}
                </Badge>
              )}
              {action.status !== 'success' && action.error && (
                <span className="basis-full text-caption text-muted">{action.error}</span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
