import { PanelRight, Search, Settings, Sparkles, OctagonX } from 'lucide-react';
import { useT } from '@renderer/lib/i18n';
import { cn } from '@renderer/lib/cn';
import { Button } from '@renderer/components/ui/button';
import { IconButton } from '@renderer/components/ui/icon-button';
import { Kbd } from '@renderer/components/ui/kbd';

export type ConnectionState = 'online' | 'ai_offline' | 'not_configured';

export function StatusPill({ state }: { state: ConnectionState }) {
  const t = useT();
  const label =
    state === 'online'
      ? t.t('header.online')
      : state === 'ai_offline'
        ? t.t('header.offlineAi')
        : t.t('header.aiNotConfigured');
  const tone =
    state === 'online' ? 'bg-success' : state === 'ai_offline' ? 'bg-danger' : 'bg-warning';
  return (
    <span role="status" className="flex items-center gap-2 text-small text-muted">
      <span aria-hidden className={cn('size-2 rounded-full', tone)} />
      <span className="hidden whitespace-nowrap sm:inline">{label}</span>
    </span>
  );
}

export interface HeaderProps {
  connection: ConnectionState;
  working: boolean;
  contextVisible: boolean;
  onOpenPalette: () => void;
  onToggleContext: () => void;
  onOpenSettings: () => void;
  onStop: () => void;
}

/**
 * Title-bar-height header. The empty areas are the window drag handle; interactive
 * children opt out with `app-no-drag`. The right padding leaves room for the native
 * Windows caption buttons that overlay this strip (titleBarOverlay).
 */
export function Header({
  connection,
  working,
  contextVisible,
  onOpenPalette,
  onToggleContext,
  onOpenSettings,
  onStop,
}: HeaderProps) {
  const t = useT();
  return (
    <header
      className="app-drag glass flex h-12 shrink-0 items-center gap-3 border-b border-line ps-4"
      style={{
        paddingInlineEnd:
          'max(1rem, calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw)))',
      }}
    >
      <div className="flex w-[216px] shrink-0 items-center gap-2">
        <span
          aria-hidden
          className="gradient-accent flex size-7 items-center justify-center rounded-lg text-white"
        >
          <Sparkles size={15} />
        </span>
        <span className="text-h3 font-semibold tracking-tight text-fg">{t.t('app.name')}</span>
      </div>

      <div className="flex min-w-0 flex-1 justify-center">
        <button
          type="button"
          onClick={onOpenPalette}
          aria-label={t.t('header.searchPlaceholder')}
          aria-keyshortcuts="Control+K"
          className={cn(
            'app-no-drag flex h-9 w-full max-w-xl items-center gap-2.5 rounded-control border border-line bg-bg-2 px-3 text-start text-body text-muted',
            'transition-colors duration-150 hover:border-line-strong hover:text-fg',
          )}
        >
          <Search aria-hidden size={16} />
          <span className="min-w-0 flex-1 truncate">{t.t('header.searchPlaceholder')}</span>
          <Kbd>Ctrl K</Kbd>
        </button>
      </div>

      <div className="app-no-drag flex shrink-0 items-center gap-2">
        {working && (
          <Button
            variant="danger"
            size="sm"
            onClick={onStop}
            leftIcon={<OctagonX aria-hidden size={15} />}
            title={t.t('header.stopHint')}
            aria-keyshortcuts="Control+Shift+Escape"
          >
            {t.t('header.stop')}
          </Button>
        )}
        <StatusPill state={connection} />
        <IconButton
          label={contextVisible ? t.t('header.hideContext') : t.t('header.showContext')}
          icon={<PanelRight size={18} />}
          active={contextVisible}
          onClick={onToggleContext}
        />
        <IconButton
          label={t.t('header.settings')}
          icon={<Settings size={18} />}
          onClick={onOpenSettings}
        />
      </div>
    </header>
  );
}
