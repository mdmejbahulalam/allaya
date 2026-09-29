import { CancellationSource } from './cancellation';
import { TypedEventBus } from './event-bus';

export interface ActiveRun {
  id: string;
  label: string;
  startedAt: number;
}

type RunEvents = { changed: ActiveRun[] };

/**
 * Every long-running agent operation (a chat generation, a task, an automation run) registers here.
 * That gives the emergency stop a single place to cancel *everything*, and the UI a single source of truth
 * for "is Allaya working right now?".
 */
export class RunRegistry {
  readonly events = new TypedEventBus<RunEvents>();
  private readonly runs = new Map<string, { run: ActiveRun; source: CancellationSource }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Registers a run and returns its cancellation source. Starting an id that is already active is an error. */
  start(id: string, label: string): CancellationSource {
    if (this.runs.has(id)) throw new Error(`Run already active: ${id}`);
    const source = new CancellationSource();
    this.runs.set(id, { run: { id, label, startedAt: this.now() }, source });
    this.emit();
    return source;
  }

  isActive(id: string): boolean {
    return this.runs.has(id);
  }

  finish(id: string): void {
    if (this.runs.delete(id)) this.emit();
  }

  cancel(id: string, reason = 'cancelled'): boolean {
    const entry = this.runs.get(id);
    if (!entry) return false;
    entry.source.cancel(reason);
    return true;
  }

  /** Emergency stop. Returns how many runs were signalled. */
  cancelAll(reason = 'emergency stop'): number {
    const entries = [...this.runs.values()];
    for (const { source } of entries) source.cancel(reason);
    return entries.length;
  }

  active(): ActiveRun[] {
    return [...this.runs.values()].map((entry) => entry.run);
  }

  private emit(): void {
    this.events.emit('changed', this.active());
  }
}
