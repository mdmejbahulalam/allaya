import { Check, CircleAlert, Copy, LoaderCircle, Ban } from 'lucide-react';
import { useState } from 'react';
import type { MessageView, Step } from '../../../shared/ipc';
import { useT } from '../i18n';
import { cn } from '../lib/cn';
import { Markdown } from '../lib/markdown';
import { IconButton } from './ui';

function StepLine({ step }: { step: Step }) {
  const t = useT();
  const icon =
    step.status === 'running' ? (
      <LoaderCircle size={13} className="animate-spin" aria-hidden />
    ) : step.status === 'done' ? (
      <Check size={13} aria-hidden className="text-success" />
    ) : (
      <CircleAlert size={13} aria-hidden className="text-danger" />
    );
  const head = (
    <span className="inline-flex items-center gap-2">
      {icon}
      <span className="font-mono text-[0.85em]">{step.summary}</span>
      {step.status === 'running' && <span className="text-muted">· {t.t('chat.stepRunning')}</span>}
      {step.status === 'denied' && <span className="text-danger">· {t.t('chat.stepDenied')}</span>}
    </span>
  );
  if (!step.output) return <div className="py-0.5 text-muted">{head}</div>;
  return (
    <details className="py-0.5 text-muted">
      <summary className="cursor-pointer list-none">{head}</summary>
      <pre
        dir="auto"
        className="mt-1 max-h-48 overflow-auto rounded-lg border border-line bg-panel p-2 font-mono text-[0.8em] whitespace-pre-wrap"
      >
        {step.output}
      </pre>
    </details>
  );
}

export function errorText(
  t: ReturnType<typeof useT>,
  error: { code: string; message: string },
): string {
  const key = `error.${error.code}`;
  return t.has(key) ? t.t(key) : error.message || t.t('error.generic');
}

export function UserMessage({ message }: { message: MessageView }) {
  return (
    <div className="flex">
      <div
        dir="auto"
        className="max-w-[85%] rounded-2xl bg-elevated px-4 py-2.5 break-words whitespace-pre-wrap"
      >
        {message.content}
      </div>
    </div>
  );
}

export function AssistantMessage({ message }: { message: MessageView }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const streaming = message.status === 'streaming';
  const copy = () => {
    void navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="group/message">
      {message.steps && message.steps.length > 0 && (
        <div className="mb-2 text-sm" aria-label="steps">
          {message.steps.map((step) => (
            <StepLine key={step.id} step={step} />
          ))}
        </div>
      )}
      {message.content && (
        <div dir="auto" className="break-words">
          <Markdown text={message.content} />
          {streaming && (
            <span
              aria-hidden
              className="ms-0.5 inline-block h-4 w-1.5 translate-y-0.5 rounded-sm bg-accent"
              style={{ animation: 'blink 1s steps(2) infinite' }}
            />
          )}
        </div>
      )}
      {streaming && !message.content && (!message.steps || message.steps.length === 0) && (
        <span role="status" aria-label="…" className="inline-flex gap-1 py-2">
          {[0, 1, 2].map((n) => (
            <span
              key={n}
              className="size-1.5 rounded-full bg-muted"
              style={{ animation: `blink 1.2s ${n * 0.2}s steps(2) infinite` }}
            />
          ))}
        </span>
      )}
      {message.status === 'cancelled' && (
        <p className="mt-1 inline-flex items-center gap-1.5 text-sm text-muted">
          <Ban size={13} aria-hidden /> {t.t('chat.stopped')}
        </p>
      )}
      {message.status === 'error' && message.error && (
        <p
          role="alert"
          className="mt-2 rounded-lg border border-line-strong px-3 py-2 text-sm text-danger"
        >
          {errorText(t, message.error)}
        </p>
      )}
      {message.status === 'complete' && message.content && (
        <div
          className={cn(
            'mt-1 -ms-2 opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100',
          )}
        >
          <IconButton label={copied ? t.t('chat.copied') : t.t('chat.copy')} onClick={copy}>
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </IconButton>
        </div>
      )}
    </div>
  );
}
