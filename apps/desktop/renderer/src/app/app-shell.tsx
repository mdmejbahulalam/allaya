import { Suspense, useCallback, useEffect, useMemo } from 'react';
import { Activity, FolderOpen, Plus, Search, Settings } from 'lucide-react';
import { createTranslator } from '@allaya/localization';
import { useT } from '@renderer/lib/i18n';
import { matchesShortcut } from '@renderer/lib/shortcuts';
import { useViewportTier } from '@renderer/lib/use-viewport';
import { cn } from '@renderer/lib/cn';
import { invoke } from '@renderer/lib/api';
import { useAgentStore } from '@renderer/stores/agent';
import { selectConnection, useProvidersStore } from '@renderer/stores/providers';
import { useSettingsStore } from '@renderer/stores/settings';
import { useUiStore } from '@renderer/stores/ui';
import { isVoiceActive, useVoiceStore } from '@renderer/stores/voice';
import { CommandPalette, type PaletteItem } from '@renderer/components/shell/command-palette';
import { ContextPanel } from '@renderer/components/shell/context-panel';
import { ErrorBoundary } from '@renderer/components/shell/error-boundary';
import { Header } from '@renderer/components/shell/header';
import { Sidebar } from '@renderer/components/shell/sidebar';
import { Drawer } from '@renderer/components/ui/drawer';
import { Skeleton } from '@renderer/components/ui/skeleton';
import { SCREENS } from '@renderer/features/screens';
import { ToolConfirmationHost } from '@renderer/features/tools/confirmation-host';
import { VoiceBridge } from '@renderer/features/voice/voice-bridge';
import { NAV_GROUPS, ROUTES, type RouteId } from './routes';

// Keywords are gathered from BOTH languages so English / Banglish typing finds items in a Bengali UI.
const EN = createTranslator({ locale: 'en' });
const BN = createTranslator({ locale: 'bn' });

function ScreenSkeleton() {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 px-8 py-8" aria-busy="true">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-40 w-full rounded-card" />
      <Skeleton className="h-24 w-full rounded-card" />
    </div>
  );
}

export function AppShell() {
  const t = useT();
  const tier = useViewportTier();
  const settings = useSettingsStore((s) => s.values);
  const update = useSettingsStore((s) => s.update);
  const {
    route,
    navigate,
    contextOpen,
    setContextOpen,
    paletteOpen,
    setPaletteOpen,
    setComposerDraft,
    sidebarHover,
    setSidebarHover,
  } = useUiStore();
  const agentWorking = useAgentStore((s) => s.isWorking);
  const voiceState = useVoiceStore((s) => s.state);
  // Listening and speaking count as "working": the emergency stop must be reachable whenever Allaya is active.
  const isWorking = agentWorking || isVoiceActive(voiceState);
  const connection = useProvidersStore(selectConnection);

  // ── Sidebar: pinned honours the user's setting; unpinned is a rail that expands on hover.
  const forcedCollapsed = tier === 'sm';
  const pinned = settings['appearance.sidebarPinned'];
  const railCollapsed =
    forcedCollapsed || (pinned ? settings['appearance.sidebar'] === 'collapsed' : true);
  const hoverExpanded = !pinned && !forcedCollapsed && sidebarHover;
  const sidebarCollapsed = railCollapsed && !hoverExpanded;

  // ── Context panel: docked from `lg` up; a drawer below that.
  const contextDocked = tier === 'xl' || tier === 'lg';
  const contextVisible = contextOpen ?? contextDocked;

  const ask = useCallback(
    (text: string) => {
      setComposerDraft(text);
      navigate('chat');
    },
    [navigate, setComposerDraft],
  );

  const newTask = useCallback(() => {
    setComposerDraft('');
    navigate('home');
    requestAnimationFrame(() => document.getElementById('home-ask')?.focus());
  }, [navigate, setComposerDraft]);

  // ── Global keyboard shortcuts (configurable through settings).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        matchesShortcut(event, settings['shortcuts.commandPalette']) ||
        matchesShortcut(event, settings['shortcuts.search'])
      ) {
        event.preventDefault();
        setPaletteOpen(!useUiStore.getState().paletteOpen);
      } else if (matchesShortcut(event, settings['shortcuts.newTask'])) {
        event.preventDefault();
        newTask();
      } else if (matchesShortcut(event, settings['shortcuts.voice']) && !isEditable(event.target)) {
        // Ctrl+Shift+V is also "paste as plain text" inside text fields, so it only toggles voice elsewhere.
        // (A system-wide shortcut arrives with the Windows integration phase.)
        event.preventDefault();
        void useVoiceStore.getState().toggle();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [settings, setPaletteOpen, newTask]);

  const items = useMemo<PaletteItem[]>(() => {
    const kw = (key: Parameters<typeof EN.t>[0]) => [EN.t(key), BN.t(key)];
    const go = (id: RouteId) => () => navigate(id);
    const suggested: PaletteItem[] = [
      {
        id: 'open-downloads',
        label: t.t('palette.openDownloads'),
        icon: <FolderOpen size={16} />,
        group: 'suggested',
        keywords: [...kw('palette.openDownloads'), 'downloads folder', 'ডাউনলোড'],
        run: () => ask(t.t('quickActions.prompts.open_folder')),
      },
      {
        id: 'new-task',
        label: t.t('palette.startNewTask'),
        icon: <Plus size={16} />,
        group: 'suggested',
        keywords: kw('palette.startNewTask'),
        run: newTask,
      },
      {
        id: 'search-files',
        label: t.t('palette.searchFiles'),
        icon: <Search size={16} />,
        group: 'suggested',
        keywords: [...kw('palette.searchFiles'), 'find file', 'ফাইল খুঁজুন'],
        run: () => ask(t.t('quickActions.prompts.find_file')),
      },
      {
        id: 'open-settings',
        label: t.t('palette.openSettings'),
        icon: <Settings size={16} />,
        group: 'suggested',
        keywords: kw('palette.openSettings'),
        run: go('settings'),
      },
      {
        id: 'run-automation',
        label: t.t('palette.runAutomation'),
        icon: <Activity size={16} />,
        group: 'suggested',
        keywords: kw('palette.runAutomation'),
        run: go('automations'),
      },
    ];
    const navigation: PaletteItem[] = NAV_GROUPS.flatMap((group) =>
      ROUTES.filter((r) => r.group === group),
    )
      .concat(ROUTES.filter((r) => !r.group && r.id !== 'gallery'))
      .map((r) => ({
        id: `nav-${r.id}`,
        label: t.t(`nav.${r.id as 'home'}`),
        icon: <r.icon size={16} />,
        group: 'navigate' as const,
        keywords: [EN.t(`nav.${r.id as 'home'}`), BN.t(`nav.${r.id as 'home'}`)],
        run: go(r.id),
      }));
    return [...suggested, ...navigation];
  }, [t, navigate, ask, newTask]);

  const Screen = SCREENS[route];

  return (
    <div className="flex h-full flex-col bg-bg">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:start-3 focus:top-3 focus:z-[90] focus:rounded-control focus:bg-accent-solid focus:px-4 focus:py-2 focus:text-accent-fg"
      >
        {t.t('a11y.skipToContent')}
      </a>
      <Header
        connection={connection}
        working={isWorking}
        contextVisible={contextVisible}
        onOpenPalette={() => setPaletteOpen(true)}
        onToggleContext={() => setContextOpen(!contextVisible)}
        onOpenSettings={() => navigate('settings')}
        onStop={() => {
          // One STOP silences everything: the microphone, speech, and every running task.
          useVoiceStore.getState().interrupt();
          void invoke('agent:stop').catch(() => undefined);
        }}
      />

      <div className="flex min-h-0 flex-1">
        {/* The rail keeps its width; a hover-expanded sidebar floats over the content instead of pushing it. */}
        <div
          className={cn(
            'relative shrink-0 transition-[width] duration-200 ease-out-soft',
            railCollapsed ? 'w-[72px]' : 'w-[248px]',
          )}
          onMouseEnter={() => !pinned && setSidebarHover(true)}
          onMouseLeave={() => setSidebarHover(false)}
        >
          <div className={cn('h-full', hoverExpanded && 'absolute inset-y-0 start-0 z-30')}>
            <Sidebar
              route={route}
              collapsed={sidebarCollapsed}
              pinned={pinned}
              overlay={hoverExpanded}
              canToggle={!forcedCollapsed}
              onNavigate={navigate}
              onNewTask={newTask}
              onToggleCollapsed={() =>
                void update(
                  'appearance.sidebar',
                  settings['appearance.sidebar'] === 'collapsed' ? 'expanded' : 'collapsed',
                )
              }
              onTogglePinned={() => void update('appearance.sidebarPinned', !pinned)}
            />
          </div>
        </div>

        <main
          id="main"
          tabIndex={-1}
          aria-label={t.t('a11y.mainContent')}
          className="min-w-0 flex-1 overflow-y-auto outline-none"
        >
          <ErrorBoundary resetKey={route}>
            <Suspense fallback={<ScreenSkeleton />}>
              <Screen />
            </Suspense>
          </ErrorBoundary>
        </main>

        {contextDocked && contextVisible && (
          <div
            className={cn(
              'shrink-0 border-s border-line',
              tier === 'xl' ? 'w-[340px]' : 'w-[288px]',
            )}
          >
            <ContextPanel />
          </div>
        )}
      </div>

      {!contextDocked && (
        <Drawer
          open={contextVisible}
          onOpenChange={setContextOpen}
          title={t.t('context.title')}
          width={340}
        >
          <ContextPanel className="-m-4 h-[calc(100%+2rem)]" />
        </Drawer>
      )}

      <VoiceBridge />
      <ToolConfirmationHost />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} items={items} onAsk={ask} />
    </div>
  );
}

/** True for text-entry elements, where keystrokes belong to the field. */
function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement)
  );
}
