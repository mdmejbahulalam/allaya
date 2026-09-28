/** Injectable time source so scheduling, expiry and durations are testable. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export class FakeClock implements Clock {
  constructor(private current = 0) {}
  now(): number {
    return this.current;
  }
  set(value: number): void {
    this.current = value;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}
