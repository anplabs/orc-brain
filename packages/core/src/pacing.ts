/**
 * Proactive dispatch pacing (spec 002 §R14). A sliding 60-minute window of
 * dispatch timestamps enforces `budget.max_tasks_per_hour` BEFORE a worker
 * spawns — unlike {@link Backpressure}, which reacts to provider limit signals
 * after the fact. Pure and clock-injected: every method takes `now`, so tests
 * never sleep. The window is global (the subscription is shared across runs).
 */

/** Sliding-window length: the "per hour" in max_tasks_per_hour. */
export const PACER_WINDOW_MS = 60 * 60 * 1000;

/** Verdict of a pacing check. `resume_at` is when a slot frees up. */
export type PacerVerdict = { ok: true } | { ok: false; resume_at: Date };

/** Sliding-window dispatch pacer (spec 002 §R14). */
export class DispatchPacer {
  /** Epoch ms of dispatches inside the current window, oldest first. */
  private dispatches: number[] = [];

  /** `maxPerHour <= 0` disables the throttle entirely. */
  constructor(private readonly maxPerHour: number) {}

  /** Records a dispatch at `now`. Call once per spawned worker. */
  recordDispatch(now: Date): void {
    this.dispatches.push(now.getTime());
    this.prune(now);
  }

  /**
   * True when another dispatch fits in the window; otherwise the time the
   * oldest blocking dispatch ages out and one slot frees.
   */
  check(now: Date): PacerVerdict {
    if (this.maxPerHour <= 0) return { ok: true };
    this.prune(now);
    if (this.dispatches.length < this.maxPerHour) return { ok: true };
    // One more fits once the entry at (len - max) leaves the window.
    const blocking = this.dispatches[this.dispatches.length - this.maxPerHour]!;
    return { ok: false, resume_at: new Date(blocking + PACER_WINDOW_MS) };
  }

  /** Drops timestamps that have aged out of the window. */
  private prune(now: Date): void {
    const cutoff = now.getTime() - PACER_WINDOW_MS;
    let drop = 0;
    while (drop < this.dispatches.length && this.dispatches[drop]! <= cutoff) {
      drop++;
    }
    if (drop > 0) this.dispatches = this.dispatches.slice(drop);
  }
}
