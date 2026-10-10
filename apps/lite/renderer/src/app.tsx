import { useEffect, useState } from 'react';
import { ChatView } from './components/chat-view';
import { Sidebar } from './components/sidebar';
import { I18nProvider, resolveLang } from './i18n';
import { subscribe } from './lib/api';
import { SettingsView } from './settings/settings-view';
import { useAppStore } from './stores/app';
import { useChatStore } from './stores/chat';
import { useConnectionsStore } from './stores/connections';

/** Light, dark, or whatever the computer is set to. */
function useTheme(preference: 'system' | 'dark' | 'light') {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = preference === 'dark' || (preference === 'system' && media.matches);
      document.documentElement.dataset['theme'] = dark ? 'dark' : 'light';
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [preference]);
}

export function App() {
  const hydrated = useAppStore((s) => s.hydrated);
  const settings = useAppStore((s) => s.settings);
  const info = useAppStore((s) => s.info);
  const route = useAppStore((s) => s.route);
  const lang = resolveLang(settings.language, info.locale);
  const [failure, setFailure] = useState<string | null>(null);

  useTheme(settings.theme);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  // Start: read what is saved, then keep the screen true as the engine reports changes.
  useEffect(() => {
    const { load } = useAppStore.getState();
    const { loadChats, onDelta, onMessage } = useChatStore.getState();
    const { loadConnections, loadModels } = useConnectionsStore.getState();
    void load();
    void loadChats();
    void loadConnections().then(() => loadModels());
    const offs = [
      subscribe('chat:delta', onDelta),
      subscribe('chat:message', onMessage),
      subscribe('chats:changed', () => void useChatStore.getState().loadChats()),
      subscribe('connections:changed', () => {
        void useConnectionsStore.getState().loadConnections();
        void useConnectionsStore.getState().loadModels();
      }),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  if (!hydrated) return null;
  return (
    <I18nProvider lang={lang}>
      <div className="flex h-full">
        <Sidebar />
        <main className="relative flex h-full min-w-0 flex-1 flex-col">
          {route === 'settings' ? <SettingsView /> : <ChatView onFailure={setFailure} />}
          {failure && (
            <div
              role="alert"
              className="absolute start-1/2 bottom-24 -translate-x-1/2 rounded-lg border border-line-strong bg-panel px-4 py-2 text-sm shadow-lg"
            >
              {failure}
              <button
                type="button"
                className="ms-3 text-muted underline"
                onClick={() => setFailure(null)}
              >
                ×
              </button>
            </div>
          )}
        </main>
      </div>
    </I18nProvider>
  );
}
