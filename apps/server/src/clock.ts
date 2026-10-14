/** Injectable time source so trial/expiry logic can be tested deterministically. */
export interface Clock {
  now(): Date
}

export const systemClock: Clock = { now: () => new Date() }

export class ManualClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current.getTime())
  }
  set(date: Date): void {
    this.current = new Date(date.getTime())
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms)
  }
}
