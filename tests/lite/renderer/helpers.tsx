import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import { I18nProvider, type Lang } from '@lite/renderer/src/i18n';
import { useAppStore } from '@lite/renderer/src/stores/app';
import { useChatStore } from '@lite/renderer/src/stores/chat';
import { useConnectionsStore } from '@lite/renderer/src/stores/connections';
import { settingsDefaults } from '@lite/shared/defaults';
import type { MessageView, ModelView } from '@lite/shared/ipc';

export const renderLite = (ui: ReactElement, lang: Lang = 'en') =>
  render(<I18nProvider lang={lang}>{ui}</I18nProvider>);

type Handler = (payload: unknown) => unknown;

/** What the engine says to a list when a test does not care: nothing in it. */
const DEFAULTS: Record<string, Handler> = {
  'connections:list': () => [],
  'chats:list': () => [],
  'models:list': () => ({ models: [], problems: [] }),
};

/** A stand-in for the engine: `handlers` answer channels; anything else resolves to `{ ok: true }`. */
export function bridge(handlers: Record<string, Handler> = {}) {
  const invoke = vi.fn(async (channel: string, payload?: unknown) => {
    const handler = handlers[channel] ?? DEFAULTS[channel];
    if (!handler) return { ok: true, data: { ok: true } };
    try {
      return { ok: true, data: await handler(payload) };
    } catch (error) {
      const e = error as { code?: string; message?: string; details?: Record<string, unknown> };
      return {
        ok: false,
        error: {
          code: e.code ?? 'UNKNOWN',
          message: e.message ?? 'x',
          retryable: false,
          details: e.details,
        },
      };
    }
  });
  (window as unknown as { allaya: unknown }).allaya = { invoke, subscribe: () => () => undefined };
  return invoke;
}

export const fail = (code: string, message = 'no', details?: Record<string, unknown>) =>
  Object.assign(new Error(message), { code, details });

export function resetStores() {
  useAppStore.setState({
    settings: settingsDefaults,
    hydrated: true,
    route: 'chat',
    settingsTab: 'providers',
    info: { version: '1', platform: 'test', locale: 'en-US', e2e: false },
  });
  useChatStore.setState({ chats: [], activeId: null, messages: [], pendingModel: null });
  useConnectionsStore.setState({
    connections: [],
    loaded: true,
    models: [],
    problems: [],
    modelsLoading: false,
    modelsLoaded: true,
  });
}

export const model = (over: Partial<ModelView> = {}) => ({
  connectionId: 'c1',
  connectionName: 'Anthropic (Claude)',
  modelId: 'claude-sonnet',
  displayName: 'Claude Sonnet',
  tier: 'balanced' as const,
  vision: true,
  reasoning: false,
  contextWindow: 200_000,
  inferred: false,
  ...over,
});

export const message = (over: Partial<MessageView> = {}): MessageView => ({
  id: 'm1',
  chatId: 'chat1',
  role: 'assistant',
  content: '',
  status: 'complete',
  createdAt: 1,
  ...over,
});
