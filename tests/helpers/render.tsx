import { render, type RenderOptions } from '@testing-library/react';
import { MotionConfig } from 'motion/react';
import type { ReactElement, ReactNode } from 'react';
import { settingsDefaults, type SettingsSnapshot } from '@allaya/validation';
import { I18nProvider } from '@renderer/lib/i18n';
import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { useSettingsStore } from '@renderer/stores/settings';
import { useToastStore } from '@renderer/stores/toasts';
import { useOverlayStore } from '@renderer/stores/overlays';

export function resetStores(overrides: Partial<SettingsSnapshot> = {}): void {
  useSettingsStore.setState({ values: { ...settingsDefaults, ...overrides }, hydrated: true });
  useToastStore.setState({ toasts: [] });
  useOverlayStore.setState({ depth: 0 });
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="always">
      <I18nProvider>
        <TooltipProvider>{children}</TooltipProvider>
      </I18nProvider>
    </MotionConfig>
  );
}

/** Renders with the real i18n, tooltip and motion providers (animations disabled for determinism). */
export function renderUi(
  ui: ReactElement,
  options: { settings?: Partial<SettingsSnapshot> } & Omit<RenderOptions, 'wrapper'> = {},
) {
  const { settings, ...rest } = options;
  resetStores({ 'language.ui': 'en', ...settings });
  return render(ui, { wrapper: Providers, ...rest });
}
