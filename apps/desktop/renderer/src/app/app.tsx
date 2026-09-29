import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'motion/react';
import { useEffect, useState } from 'react';
import { invoke, subscribe } from '@renderer/lib/api';
import { I18nProvider } from '@renderer/lib/i18n';
import { useAppInfoStore } from '@renderer/stores/app-info';
import { useSettingsStore } from '@renderer/stores/settings';
import { Toaster } from '@renderer/components/ui/toast';
import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { FloatingAssistant } from '@renderer/features/floating/floating-assistant';
import { AppShell } from './app-shell';
import { useBackendSync } from './use-backend-sync';
import { useMotionPreference, useThemeEffects } from './use-theme-effects';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, retry: false, refetchOnWindowFocus: false } },
});

/** Loads settings + app info from the trusted main process before first paint of the real UI. */
export function useBootstrap(): boolean {
  const [ready, setReady] = useState(false);
  const hydrate = useSettingsStore((s) => s.hydrate);
  const setInfo = useAppInfoStore((s) => s.set);

  useEffect(() => {
    let cancelled = false;
    const offSettings = subscribe('settings:changed', hydrate);
    void Promise.all([invoke('settings:getAll'), invoke('app:getInfo')])
      .then(([settings, info]) => {
        if (cancelled) return;
        hydrate(settings);
        setInfo(info);
      })
      .catch(() => undefined)
      .finally(() => !cancelled && setReady(true));
    return () => {
      cancelled = true;
      offSettings();
    };
  }, [hydrate, setInfo]);
  return ready;
}

function Themed() {
  useThemeEffects();
  useBackendSync();
  const reducedMotion = useMotionPreference();
  return (
    <MotionConfig reducedMotion={reducedMotion}>
      <TooltipProvider>
        <AppShell />
        <Toaster />
      </TooltipProvider>
    </MotionConfig>
  );
}

/** The page of the small always-on-top bar (`#/floating`): the same themed, translated app, without the shell. */
export function FloatingApp() {
  const ready = useBootstrap();
  if (!ready) return null;
  return (
    <I18nProvider>
      <FloatingThemed />
    </I18nProvider>
  );
}

function FloatingThemed() {
  useThemeEffects();
  const reducedMotion = useMotionPreference();
  return (
    <MotionConfig reducedMotion={reducedMotion}>
      <TooltipProvider>
        <FloatingAssistant />
      </TooltipProvider>
    </MotionConfig>
  );
}

export function App() {
  const ready = useBootstrap();
  if (!ready) return null; // First frame is just the themed background; avoids a flash of default settings.
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <Themed />
      </I18nProvider>
    </QueryClientProvider>
  );
}
