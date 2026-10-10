import { ShieldQuestion } from 'lucide-react';
import type { ApprovalView } from '../../../shared/ipc';
import { useT } from '../i18n';
import { useApprovalsStore } from '../stores/approvals';
import { Button } from './ui';

function Question({ approval }: { approval: ApprovalView }) {
  const t = useT();
  const decide = useApprovalsStore((s) => s.decide);
  const answer = (allow: boolean) => void decide(approval.id, allow).catch(() => undefined);
  return (
    <div
      role="group"
      aria-label={approval.summary}
      className="pointer-events-auto rounded-xl border border-line-strong bg-panel p-4 shadow-xl"
      data-testid="approval"
    >
      <p className="mb-1 flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted uppercase">
        <ShieldQuestion size={14} aria-hidden />
        {t.t('approval.title')}
        <span className="font-normal tracking-normal normal-case">
          ·{' '}
          {approval.source.kind === 'task'
            ? t.t('approval.inTask', { title: approval.source.taskTitle })
            : t.t('approval.inChat')}
        </span>
      </p>
      <p dir="auto" className="text-sm font-medium break-words">
        {approval.summary}
      </p>
      {approval.details && (
        <details className="mt-1.5 text-sm text-muted">
          <summary className="cursor-pointer">{t.t('approval.details')}</summary>
          <pre
            dir="auto"
            className="mt-1 max-h-40 overflow-auto rounded-lg border border-line bg-bg p-2 font-mono text-[0.8em] whitespace-pre-wrap"
          >
            {approval.details}
          </pre>
        </details>
      )}
      <div className="mt-3 flex gap-2">
        <Button size="sm" variant="primary" onClick={() => answer(true)}>
          {t.t('approval.allow')}
        </Button>
        <Button size="sm" onClick={() => answer(false)}>
          {t.t('approval.deny')}
        </Button>
      </div>
    </div>
  );
}

/**
 * The questions Allaya asks before it changes anything outside itself — from a chat or from a task. They show on
 * every screen, so a task running in the background can still ask. Nothing is allowed until the person says so.
 */
export function ApprovalsPanel() {
  const pending = useApprovalsStore((s) => s.pending);
  return (
    <div
      aria-live="assertive"
      className="pointer-events-none fixed end-4 bottom-4 z-40 flex w-[26rem] max-w-[calc(100vw-2rem)] flex-col gap-3"
    >
      {pending.map((approval) => (
        <Question key={approval.id} approval={approval} />
      ))}
    </div>
  );
}
