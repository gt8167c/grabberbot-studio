/**
 * A clock that lives in *simulation* time, so every "wait" in a program,
 * an action, or a servo move stays in lockstep with the physics loop —
 * including when turbo mode runs the world faster than real time.
 */

export class AbortedError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortedError';
  }
}

type Waiter = { due: number; resolve: () => void };
type CondWaiter = { pred: () => boolean; resolve: () => void };

export class Scheduler {
  /** Seconds of simulated time since boot. */
  time = 0;
  private waiters: Waiter[] = [];
  private conds: CondWaiter[] = [];
  private epoch = 0;

  tick(dt: number): void {
    this.time += dt;

    if (this.waiters.length) {
      const due = this.waiters.filter((w) => w.due <= this.time);
      if (due.length) {
        this.waiters = this.waiters.filter((w) => w.due > this.time);
        due.forEach((w) => w.resolve());
      }
    }

    if (this.conds.length) {
      const met = this.conds.filter((c) => {
        try {
          return c.pred();
        } catch {
          return true;
        }
      });
      if (met.length) {
        this.conds = this.conds.filter((c) => !met.includes(c));
        met.forEach((c) => c.resolve());
      }
    }
  }

  /** Resolve after `seconds` of simulated time. */
  wait(seconds: number): Promise<void> {
    if (seconds <= 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ due: this.time + seconds, resolve }));
  }

  /** Resolve once `pred()` becomes true (checked once per physics tick). */
  waitUntil(pred: () => boolean): Promise<void> {
    if (pred()) return Promise.resolve();
    return new Promise((resolve) => this.conds.push({ pred, resolve }));
  }

  /**
   * Release everything that is waiting. Callers unwind on their next
   * `checkAbort()`, so a stopped program tears down cleanly instead of
   * leaving dangling promises.
   */
  cancelAll(): void {
    const w = this.waiters, c = this.conds;
    this.waiters = [];
    this.conds = [];
    this.epoch++;
    w.forEach((x) => x.resolve());
    c.forEach((x) => x.resolve());
  }

  get generation(): number {
    return this.epoch;
  }
}
