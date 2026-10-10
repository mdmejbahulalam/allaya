import { create } from 'zustand';
import type { McpServerInput, McpServerView } from '../../../shared/ipc';
import { invoke } from '../lib/api';

interface McpState {
  servers: McpServerView[];
  loaded: boolean;
  load: () => Promise<void>;
  /** The engine's own report of every app (it pushes one whenever anything changes). */
  set: (servers: McpServerView[]) => void;
  add: (input: McpServerInput) => Promise<McpServerView>;
  update: (id: string, changes: Partial<McpServerInput>) => Promise<McpServerView>;
  remove: (id: string) => Promise<void>;
  reconnect: (id: string) => Promise<void>;
  signIn: (id: string) => Promise<void>;
  cancelSignIn: (id: string) => Promise<void>;
  signOut: (id: string) => Promise<void>;
  setTool: (
    id: string,
    tool: string,
    change: { ask?: boolean; enabled?: boolean },
  ) => Promise<void>;
}

export const useMcpStore = create<McpState>((set, get) => {
  /** Puts one app's new state in the list at once; the engine's report that follows says the same. */
  const put = (view: McpServerView) =>
    set((s) => ({
      servers: s.servers.some((x) => x.id === view.id)
        ? s.servers.map((x) => (x.id === view.id ? view : x))
        : [...s.servers, view],
    }));
  return {
    servers: [],
    loaded: false,
    async load() {
      set({ servers: await invoke('mcp:list'), loaded: true });
    },
    set: (servers) => set({ servers, loaded: true }),
    async add(input) {
      const view = await invoke('mcp:add', input);
      put(view);
      return view;
    },
    async update(id, changes) {
      const view = await invoke('mcp:update', { id, changes });
      put(view);
      return view;
    },
    async remove(id) {
      await invoke('mcp:remove', { id });
      set({ servers: get().servers.filter((s) => s.id !== id) });
    },
    async reconnect(id) {
      put(await invoke('mcp:reconnect', { id }));
    },
    async signIn(id) {
      put(await invoke('mcp:signIn', { id }));
    },
    async cancelSignIn(id) {
      await invoke('mcp:cancelSignIn', { id });
    },
    async signOut(id) {
      put(await invoke('mcp:signOut', { id }));
    },
    async setTool(id, tool, change) {
      put(await invoke('mcp:setTool', { id, tool, ...change }));
    },
  };
});

export const appName = (servers: readonly McpServerView[], group: string): string | undefined =>
  servers.find((s) => s.group === group)?.name;
