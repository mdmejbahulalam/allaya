import { ArrowLeft, ArrowRight, Plus, RotateCw, Sparkles, X } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { useT } from '../i18n';
import { IpcError, invoke } from '../lib/api';
import { cn } from '../lib/cn';
import { MIN_PANE_WIDTH, activeTab, useBrowserStore } from '../stores/browser';
import { IconButton } from './ui';

/** "example.com" for a tab with no title yet. */
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/**
 * The browser beside the chat: tabs, an address box and the page. The page itself is drawn by the engine over the empty
 * box in the middle; this only tells it where that box is.
 */
export function BrowserPane({
  onAsk,
  onNotice,
}: {
  onAsk: () => void;
  onNotice: (text: string) => void;
}) {
  const t = useT();
  const { state, width, refused } = useBrowserStore();
  const refuse = useBrowserStore((s) => s.refuse);
  const setWidth = useBrowserStore((s) => s.setWidth);
  const setOpen = useBrowserStore((s) => s.setOpen);
  const tab = activeTab(state);
  const [draft, setDraft] = useState<string | null>(null);
  const page = useRef<HTMLDivElement>(null);

  const call = (run: () => Promise<unknown>) =>
    void run().catch((error: unknown) => {
      if (error instanceof IpcError && error.details?.['reason'] === 'not_an_address') {
        onNotice(t.t('browser.notAddress'));
      }
    });

  // Tell the engine where the page goes — and that it is showing — whenever that changes; hide it when this goes away.
  const report = (visible: boolean) => {
    const el = page.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    void invoke('browser:bounds', {
      x: Math.max(0, box.left),
      y: Math.max(0, box.top),
      width: Math.max(0, box.width),
      height: Math.max(0, box.height),
      visible,
    }).catch(() => undefined);
  };
  useLayoutEffect(() => {
    report(true);
    const el = page.current;
    const observer = new ResizeObserver(() => report(true));
    if (el) observer.observe(el);
    const onResize = () => report(true);
    window.addEventListener('resize', onResize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onResize);
      report(false);
    };
    // The box moves with the pane's width and with the tab strip, both of which are re-rendered here.
  });

  // The pane's left edge can be dragged to make it wider or narrower.
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: width };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const delta = drag.current.startX - event.clientX;
    const room = window.innerWidth * 0.7;
    setWidth(Math.min(room, Math.max(MIN_PANE_WIDTH, drag.current.startWidth + delta)));
  };

  const shown = draft ?? tab?.url ?? '';

  return (
    <aside
      aria-label={t.t('browser.toggle')}
      style={{ width }}
      className="relative flex h-full shrink-0 flex-col border-s border-line bg-panel"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t.t('browser.resize')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => (drag.current = null)}
        className="absolute inset-y-0 start-0 z-10 w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-accent/40"
      />

      <div
        role="tablist"
        aria-label={t.t('browser.tabs')}
        className="flex items-center gap-1 overflow-x-auto px-2 pt-2"
      >
        {state.tabs.map((item) => {
          const title = item.title || hostOf(item.url) || t.t('browser.untitled');
          return (
            <div
              key={item.id}
              className={cn(
                'group/tab flex max-w-44 min-w-0 items-center rounded-t-lg border border-b-0 border-transparent text-sm',
                item.id === state.activeId ? 'border-line bg-bg' : 'text-muted hover:bg-elevated',
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={item.id === state.activeId}
                onClick={() => call(() => invoke('browser:activate', { id: item.id }))}
                className="min-w-0 flex-1 truncate px-3 py-1.5 text-start"
                title={title}
              >
                {title}
              </button>
              <button
                type="button"
                aria-label={t.t('browser.closeTab', { title })}
                onClick={() => call(() => invoke('browser:close', { id: item.id }))}
                className="me-1 rounded p-0.5 text-muted hover:bg-elevated hover:text-fg"
              >
                <X size={13} aria-hidden />
              </button>
            </div>
          );
        })}
        <IconButton
          label={t.t('browser.newTab')}
          onClick={() => call(() => invoke('browser:newTab', {}))}
        >
          <Plus size={16} />
        </IconButton>
      </div>

      <div className="flex items-center gap-1 border-b border-line bg-bg px-2 py-1.5">
        <IconButton
          label={t.t('browser.back')}
          disabled={!tab?.canGoBack}
          onClick={() => call(() => invoke('browser:back', {}))}
        >
          <ArrowLeft size={16} />
        </IconButton>
        <IconButton
          label={t.t('browser.forward')}
          disabled={!tab?.canGoForward}
          onClick={() => call(() => invoke('browser:forward', {}))}
        >
          <ArrowRight size={16} />
        </IconButton>
        <IconButton
          label={tab?.loading ? t.t('browser.stop') : t.t('browser.reload')}
          disabled={!tab}
          onClick={() => call(() => invoke(tab?.loading ? 'browser:stop' : 'browser:reload', {}))}
        >
          {tab?.loading ? <X size={16} /> : <RotateCw size={16} />}
        </IconButton>
        <form
          className="min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft?.trim()) call(() => invoke('browser:go', { input: draft }));
            setDraft(null);
          }}
        >
          <input
            value={shown}
            aria-label={t.t('browser.address')}
            placeholder={t.t('browser.address')}
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            onFocus={(event) => event.target.select()}
            onBlur={() => setDraft(null)}
            className="h-8 w-full rounded-lg border border-line-strong bg-panel px-3 text-sm placeholder:text-muted/70"
          />
        </form>
        <IconButton label={t.t('browser.ask')} disabled={!tab?.url} onClick={onAsk}>
          <Sparkles size={16} />
        </IconButton>
        <IconButton label={t.t('browser.close')} onClick={() => setOpen(false)}>
          <X size={16} />
        </IconButton>
      </div>

      {refused && (
        <div
          role="status"
          className="flex items-center gap-2 border-b border-line bg-bg px-3 py-1.5 text-sm"
        >
          <span className="flex-1">{t.t('browser.download', { name: refused })}</span>
          <button
            type="button"
            aria-label={t.t('common.dismiss')}
            title={t.t('common.dismiss')}
            onClick={() => refuse(null)}
            className="rounded p-0.5 text-muted hover:bg-elevated hover:text-fg"
          >
            <X size={14} aria-hidden />
          </button>
        </div>
      )}

      <div ref={page} className="relative min-h-0 flex-1 bg-bg" data-testid="browser-page">
        {state.tabs.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center">
            <p className="text-lg font-semibold">{t.t('browser.emptyTitle')}</p>
            <p className="max-w-xs text-sm text-muted">{t.t('browser.emptyBody')}</p>
            <p className="max-w-xs text-xs text-muted">{t.t('browser.privacy')}</p>
          </div>
        )}
      </div>
    </aside>
  );
}
