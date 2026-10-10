import { ArrowLeft } from 'lucide-react';
import { useT } from '../i18n';
import { cn } from '../lib/cn';
import { useAppStore, type SettingsTab } from '../stores/app';
import { AppsPanel } from './apps-panel';
import { GeneralPanel } from './general-panel';
import { ProvidersPanel } from './providers-panel';
import { VoicePanel } from './voice-panel';

const TABS: SettingsTab[] = ['providers', 'apps', 'voice', 'general'];

export function SettingsView() {
  const t = useT();
  const tab = useAppStore((s) => s.settingsTab);
  const go = useAppStore((s) => s.go);
  return (
    <div className="h-full min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-8">
        <div className="mb-6 flex items-center gap-3">
          <button
            type="button"
            onClick={() => go('chat')}
            aria-label={t.t('settings.back')}
            title={t.t('settings.back')}
            className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-fg"
          >
            <ArrowLeft size={18} aria-hidden />
          </button>
          <h1 className="text-2xl font-semibold">{t.t('settings.title')}</h1>
        </div>
        <div
          role="tablist"
          aria-label={t.t('settings.title')}
          className="mb-6 flex gap-1 border-b border-line"
        >
          {TABS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => go('settings', id)}
              className={cn(
                '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                tab === id
                  ? 'border-accent text-fg'
                  : 'border-transparent text-muted hover:text-fg',
              )}
            >
              {t.t(`settings.tab.${id}`)}
            </button>
          ))}
        </div>
        <div role="tabpanel">
          {tab === 'providers' ? (
            <ProvidersPanel />
          ) : tab === 'apps' ? (
            <AppsPanel />
          ) : tab === 'voice' ? (
            <VoicePanel />
          ) : (
            <GeneralPanel />
          )}
        </div>
      </div>
    </div>
  );
}
