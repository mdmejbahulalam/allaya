import { create } from 'zustand';
import type { ConnectionView, ModelList, ModelRef, ModelView } from '../../../shared/ipc';
import { invoke } from '../lib/api';

interface ConnectionsState {
  connections: ConnectionView[];
  loaded: boolean;
  models: ModelView[];
  problems: ModelList['problems'];
  modelsLoading: boolean;
  modelsLoaded: boolean;
  loadConnections: () => Promise<void>;
  loadModels: (refresh?: boolean) => Promise<void>;
}

export const useConnectionsStore = create<ConnectionsState>((set) => ({
  connections: [],
  loaded: false,
  models: [],
  problems: [],
  modelsLoading: false,
  modelsLoaded: false,
  async loadConnections() {
    set({ connections: await invoke('connections:list'), loaded: true });
  },
  async loadModels(refresh = false) {
    set({ modelsLoading: true });
    try {
      const { models, problems } = await invoke('models:list', { refresh });
      set({ models, problems, modelsLoaded: true });
    } finally {
      set({ modelsLoading: false });
    }
  },
}));

export const sameModel = (
  a: ModelRef | null | undefined,
  b: ModelRef | null | undefined,
): boolean => !!a && !!b && a.connectionId === b.connectionId && a.modelId === b.modelId;

export const findModel = (models: readonly ModelView[], ref: ModelRef | null | undefined) =>
  ref ? models.find((m) => sameModel(m, ref)) : undefined;
