import type { Translator } from '@allaya/localization';

export interface NotifierPort {
  show(input: { title: string; body?: string; onClick: () => void }): void;
}

export interface TaskNews {
  id: string;
  title: string;
  state: string;
  outcome?: string | undefined;
}

export interface NotificationDeps {
  notifier: NotifierPort;
  /** The person's switch. */
  enabled: () => boolean;
  /** True while Allaya's window is visible and in front: then the window itself is the notification. */
  windowInFront: () => boolean;
  translator: () => Translator;
  /** Brings the window up on the right screen. */
  open: (target: { route: 'tasks' | 'home'; taskId?: string }) => void;
  now?: () => number;
}

/** The same thing is not announced twice within this time. */
const QUIET_MS = 10_000;

/**
 * Desktop notifications for the moments a person would otherwise miss because Allaya's window is not in front: a task
 * needs them, finished, or failed, and a question is waiting. Never shown while the window is in front, never while
 * switched off, and a question's notification does not say what is being asked (a notification can be read on a locked
 * screen); the details are in the window.
 */
export class NotificationController {
  private readonly seen = new Map<string, string>();
  private readonly lastShown = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly deps: NotificationDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Called on every change of a task. The first time a task is seen is not news. */
  taskChanged(task: TaskNews): void {
    const previous = this.seen.get(task.id);
    this.seen.set(task.id, task.state);
    if (previous === undefined || previous === task.state) return;
    const t = this.deps.translator();
    let title: string | undefined;
    if (task.state === 'COMPLETED') {
      title = t.t(task.outcome === 'partial' ? 'tasks.toast.partial' : 'tasks.toast.completed', {
        title: task.title,
      });
    } else if (task.state === 'FAILED') title = t.t('tasks.toast.failed', { title: task.title });
    else if (task.state === 'WAITING_FOR_USER') {
      title = t.t('tasks.toast.waiting', { title: task.title });
    }
    if (!title) return;
    this.show(`task:${task.id}:${task.state}`, {
      title,
      onClick: () => this.deps.open({ route: 'tasks', taskId: task.id }),
    });
  }

  /** A question is waiting for the person (an action that needs their yes). */
  confirmationRequested(): void {
    const t = this.deps.translator();
    this.show('confirmation', {
      title: t.t('notify.confirmTitle'),
      body: t.t('notify.confirmBody'),
      onClick: () => this.deps.open({ route: 'home' }),
    });
  }

  private show(key: string, input: { title: string; body?: string; onClick: () => void }): void {
    if (!this.deps.enabled() || this.deps.windowInFront()) return;
    const at = this.now();
    const last = this.lastShown.get(key);
    if (last !== undefined && at - last < QUIET_MS) return;
    this.lastShown.set(key, at);
    this.deps.notifier.show(input);
  }
}
