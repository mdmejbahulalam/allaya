import { create } from 'zustand';
import type { ProviderView, RoutingView } from '@allaya/validation';
import { invoke } from '@renderer/lib/api';

export type ConnectionState = 'online' | 'ai_offline' | 'not_configured';

interface ProvidersState {
  providers: ProviderView[];
  routing: RoutingView;
  loaded: boolean;
  setProviders: (providers: ProviderView[]) => void;
  load: () => Promise<void>;
  loadRouting: () => Promise<void>;
  setRouting: (patch: Parameters<typeof invoke<'models:setRouting'>>[1]) => Promise<void>;
}

export const useProvidersStore = create<ProvidersState>((set) => ({
  providers: [],
  routing: { autoRouting: true, assignments: {} },
  loaded: false,
  setProviders: (providers) => set({ providers, loaded: true }),
  async load() {
    set({ providers: await invoke('providers:list'), loaded: true });
  },
  async loadRouting() {
    set({ routing: await invoke('models:getRouting') });
  },
  async setRouting(patch) {
    set({ routing: await invoke('models:setRouting', patch) });
  },
}));

export function connectionState(providers: ProviderView[]): ConnectionState {
  if (providers.some((p) => p.status === 'connected')) return 'online';
  if (providers.some((p) => p.maskedKey)) return 'ai_offline';
  return 'not_configured';
}

export const selectConnection = (state: ProvidersState): ConnectionState =>
  connectionState(state.providers);
export const selectHasConnected = (state: ProvidersState): boolean =>
  state.providers.some((p) => p.status === 'connected');
