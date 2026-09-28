export type Unsubscribe = () => void;
type Handler<T> = (payload: T) => void;

/**
 * Small typed, synchronous pub/sub. Handlers are isolated: one throwing handler
 * never prevents others from running or crashes the publisher.
 */
export class TypedEventBus<Events extends Record<string, unknown>> {
  private readonly handlers = new Map<keyof Events, Set<Handler<never>>>();
  private readonly anyHandlers = new Set<(type: keyof Events, payload: unknown) => void>();

  constructor(private readonly onHandlerError?: (error: unknown, type: keyof Events) => void) {}

  on<K extends keyof Events>(type: K, handler: Handler<Events[K]>): Unsubscribe {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  onAny(handler: (type: keyof Events, payload: unknown) => void): Unsubscribe {
    this.anyHandlers.add(handler);
    return () => this.anyHandlers.delete(handler);
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    for (const handler of [...(this.handlers.get(type) ?? [])]) {
      try {
        (handler as Handler<Events[K]>)(payload);
      } catch (error) {
        this.onHandlerError?.(error, type);
      }
    }
    for (const handler of [...this.anyHandlers]) {
      try {
        handler(type, payload);
      } catch (error) {
        this.onHandlerError?.(error, type);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
    this.anyHandlers.clear();
  }
}
