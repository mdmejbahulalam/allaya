import { eventContract, type EventChannel, type EventPayload } from '../../shared/ipc';

/** Where pushes to the screen go. Electron implements it; tests collect them. */
export interface EventSink {
  send(channel: string, payload: unknown): void;
}

export class Events {
  private readonly sinks = new Set<EventSink>();

  addSink(sink: EventSink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  publish<E extends EventChannel>(channel: E, payload: EventPayload<E>): void {
    // A malformed event is dropped rather than sent: the screen can trust what it receives.
    if (!eventContract[channel].safeParse(payload).success) return;
    for (const sink of this.sinks) sink.send(channel, payload);
  }
}

export class MemorySink implements EventSink {
  readonly events: Array<{ channel: string; payload: unknown }> = [];
  send(channel: string, payload: unknown): void {
    this.events.push({ channel, payload });
  }
  of<E extends EventChannel>(channel: E): Array<EventPayload<E>> {
    return this.events
      .filter((e) => e.channel === channel)
      .map((e) => e.payload as EventPayload<E>);
  }
}
