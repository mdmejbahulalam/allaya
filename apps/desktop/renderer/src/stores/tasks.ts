import { create } from 'zustand';
import type { TaskSummary } from '@allaya/validation';
import { invoke } from '@renderer/lib/api';

interface TasksState {
  byId: Record<string, TaskSummary>;
  loaded: boolean;
  /** The task open in the Tasks screen. */
  selectedId: string | null;
  load: () => Promise<void>;
  /** Stores a pushed summary and returns what was known before (to spot a change of state). */
  apply: (task: TaskSummary) => TaskSummary | undefined;
  removeMany: (ids: string[]) => void;
  select: (id: string | null) => void;
}

export const useTasksStore = create<TasksState>((set, get) => ({
  byId: {},
  loaded: false,
  selectedId: null,

  async load() {
    const list = await invoke('tasks:list', {});
    set((state) => ({
      loaded: true,
      // What was pushed while loading is newer than the list; keep whichever was updated last.
      byId: Object.fromEntries(
        list.map((task) => {
          const known = state.byId[task.id];
          return [task.id, known && known.updatedAt > task.updatedAt ? known : task];
        }),
      ),
    }));
  },

  apply(task) {
    const previous = get().byId[task.id];
    if (previous && previous.updatedAt > task.updatedAt) return previous;
    set((state) => ({ byId: { ...state.byId, [task.id]: task } }));
    return previous;
  },

  removeMany(ids) {
    set((state) => {
      const byId = { ...state.byId };
      for (const id of ids) delete byId[id];
      return {
        byId,
        selectedId: state.selectedId && ids.includes(state.selectedId) ? null : state.selectedId,
      };
    });
  },

  select: (selectedId) => set({ selectedId }),
}));

/** Newest first. */
export const sortTasks = (byId: Record<string, TaskSummary>): TaskSummary[] =>
  Object.values(byId).sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));

export const isFinished = (task: TaskSummary): boolean =>
  task.state === 'COMPLETED' || task.state === 'FAILED' || task.state === 'CANCELLED';

export const needsAttention = (task: TaskSummary): boolean => task.state === 'WAITING_FOR_USER';

/** Running or waiting its turn — something is (about to be) happening. */
export const isActive = (task: TaskSummary): boolean =>
  !isFinished(task) && task.state !== 'PAUSED' && task.state !== 'WAITING_FOR_USER';

export const TASK_TABS = [
  'all',
  'running',
  'waiting',
  'scheduled',
  'paused',
  'completed',
  'failed',
] as const;
export type TaskTab = (typeof TASK_TABS)[number];

export function matchesTab(task: TaskSummary, tab: TaskTab): boolean {
  switch (tab) {
    case 'all':
      return true;
    case 'running':
      return isActive(task);
    case 'waiting':
      return needsAttention(task);
    case 'scheduled':
      return task.source === 'automation';
    case 'paused':
      return task.state === 'PAUSED';
    case 'completed':
      return task.state === 'COMPLETED';
    case 'failed':
      return task.state === 'FAILED' || task.state === 'CANCELLED';
  }
}
