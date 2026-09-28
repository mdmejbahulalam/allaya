import type { z } from '@allaya/validation';
import type { Logger } from '@allaya/shared';
import { nullLogger } from '@allaya/shared';
import { ipcEventContract, type EventChannel, type EventPayload } from '@allaya/validation';

/** Transport for main → renderer pushes. Electron implements it; tests use a memory sink. */
export interface EventSink {
  send(channel: string, payload: unknown): void;
}

export class EventPublisher {
  private sinks = new Set<EventSink>();
  constructor(private readonly options: { validate?: boolean; logger?: Logger } = {}) {}

  addSink(sink: EventSink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  publish<E extends EventChannel>(
    channel: E,
    payload: z.input<(typeof ipcEventContract)[E]> & EventPayload<E>,
  ): void {
    if (this.options.validate) {
      const checked = ipcEventContract[channel].safeParse(payload);
      if (!checked.success) {
        (this.options.logger ?? nullLogger).error('Refusing to publish invalid event', { channel });
        return;
      }
    }
    for (const sink of this.sinks) sink.send(channel, payload);
  }
}

export class MemoryEventSink implements EventSink {
  readonly events: Array<{ channel: string; payload: unknown }> = [];
  send(channel: string, payload: unknown): void {
    this.events.push({ channel, payload });
  }
}
