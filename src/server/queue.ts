/**
 * Tiny concurrency-bounded promise queue. Lets us cap how many test runs
 * execute in parallel — important because each run spawns a real browser
 * (Chromium) or Appium session, and 10 of those at once will OOM most
 * machines.
 */
export class Queue {
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      const next = this.waiters.shift();
      if (next) next();
    }
  }

  get inFlight(): number { return this.active; }
  get queued(): number { return this.waiters.length; }
}
