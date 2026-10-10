import { create } from 'zustand';
import type { RunView, TaskInput, TaskView } from '../../../shared/ipc';
import { invoke } from '../lib/api';

export type TasksView =
  { kind: 'list' } | { kind: 'detail'; id: string } | { kind: 'form'; id: string | null };

interface TasksState {
  tasks: TaskView[];
  loaded: boolean;
  view: TasksView;
  /** The runs of the task on screen, newest first. */
  runs: RunView[];
  load: () => Promise<void>;
  show: (view: TasksView) => void;
  create: (input: TaskInput) => Promise<TaskView>;
  update: (id: string, changes: Partial<TaskInput>) => Promise<TaskView>;
  remove: (id: string) => Promise<void>;
  run: (id: string) => Promise<void>;
  cancel: (runId: string) => Promise<void>;
  /** Event handlers (called by the app shell). */
  onChanged: () => Promise<void>;
  onRun: (run: RunView) => void;
}

const viewedId = (view: TasksView) => (view.kind === 'detail' ? view.id : null);

export const useTasksStore = create<TasksState>((set, get) => {
  /** The runs of the task on screen; if it has gone, back to the list. */
  const loadRuns = async () => {
    const id = viewedId(get().view);
    if (!id) return;
    try {
      const { runs } = await invoke('tasks:get', { id });
      if (viewedId(get().view) === id) set({ runs });
    } catch {
      if (viewedId(get().view) === id) set({ view: { kind: 'list' }, runs: [] });
    }
  };

  return {
    tasks: [],
    loaded: false,
    view: { kind: 'list' },
    runs: [],

    async load() {
      set({ tasks: await invoke('tasks:list'), loaded: true });
    },

    show(view) {
      const id = viewedId(view);
      set({ view, runs: id && viewedId(get().view) === id ? get().runs : [] });
      if (id) void loadRuns();
    },

    async create(input) {
      const task = await invoke('tasks:create', input);
      await get().load();
      return task;
    },

    async update(id, changes) {
      const task = await invoke('tasks:update', { id, changes });
      await get().load();
      return task;
    },

    async remove(id) {
      await invoke('tasks:remove', { id });
      set({ view: { kind: 'list' }, runs: [] });
      await get().load();
    },

    async run(id) {
      const run = await invoke('tasks:run', { id });
      get().onRun(run);
    },

    async cancel(runId) {
      await invoke('tasks:cancel', { runId });
    },

    async onChanged() {
      await Promise.all([get().load(), loadRuns()]);
    },

    onRun(run) {
      set((s) => ({
        tasks: s.tasks.map((t) =>
          t.id === run.taskId
            ? {
                ...t,
                running: run.status === 'running',
                lastRun: !t.lastRun || run.startedAt >= t.lastRun.startedAt ? run : t.lastRun,
              }
            : t,
        ),
        runs:
          viewedId(s.view) === run.taskId
            ? s.runs.some((r) => r.id === run.id)
              ? s.runs.map((r) => (r.id === run.id ? run : r))
              : [run, ...s.runs]
            : s.runs,
      }));
    },
  };
});
