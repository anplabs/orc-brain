/**
 * Rate-limit backpressure (§7.4). Turns a detected {@link LimitSignal} into a
 * scheduling constraint: a session/weekly/unknown limit pauses *all* dispatch
 * until the reset; a per-model limit only quarantines that model (router R7
 * routes around it). Reset times are used when the CLI text carried one,
 * otherwise an exponential backoff with a cap. Engage/clear are surfaced as
 * `limit.backpressure` events with a countdown for the UI/CLI.
 */

import type { LimitConfig, ModelName } from "@orc-brain/shared";
import type { EventBus } from "./eventBus.js";
import { backoffDelayMs, type LimitSignal } from "./safety/limitSignals.js";

/** An active constraint (global pause or a single model quarantine). */
interface Hold {
  until: number;
  reason: string;
}

/** Scheduler-facing rate-limit state for one orchestrator. */
export class Backpressure {
  private global: Hold | null = null;
  private readonly models = new Map<ModelName, Hold>();
  /** Consecutive limit hits, for backoff escalation when no reset is parsed. */
  private consecutive = 0;
  /** Re-kick the dispatch loop when a hold expires. */
  onClear?: (runId: string) => void;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly bus: EventBus,
    private readonly config: LimitConfig,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Engages backpressure for a detected signal, scheduling its auto-clear. */
  engage(signal: LimitSignal, runId: string): void {
    const t = this.now();
    const until =
      signal.resets_at && signal.resets_at > t
        ? signal.resets_at
        : t + backoffDelayMs(this.consecutive++, this.config);
    const delay = Math.max(0, until - t);

    if (signal.kind === "model_limit" && signal.model) {
      this.models.set(signal.model, { until, reason: signal.raw });
      this.emit(true, "model", signal.raw, until, signal.model);
      this.schedule(delay, () => {
        this.models.delete(signal.model!);
        this.emit(
          false,
          "model",
          "model limit cleared",
          undefined,
          signal.model,
        );
        this.onClear?.(runId);
      });
    } else {
      this.global = { until, reason: signal.raw };
      this.emit(true, "global", signal.raw, until);
      this.schedule(delay, () => {
        this.global = null;
        this.consecutive = 0;
        this.emit(false, "global", "backpressure cleared");
        this.onClear?.(runId);
      });
    }
  }

  /** True when all new dispatch must halt (global hold active). */
  isDispatchBlocked(): boolean {
    if (!this.global) return false;
    if (this.global.until <= this.now()) {
      this.global = null;
      return false;
    }
    return true;
  }

  /** Models currently quarantined by a per-model limit (router R7 input). */
  quarantinedModels(): ModelName[] {
    const t = this.now();
    const out: ModelName[] = [];
    for (const [model, hold] of this.models) {
      if (hold.until > t) out.push(model);
      else this.models.delete(model);
    }
    return out;
  }

  /** Epoch ms the global hold clears at, if any (for status/countdown). */
  globalResetsAt(): number | undefined {
    return this.global?.until;
  }

  /** Cancels all pending timers (shutdown). */
  stopAll(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private schedule(delayMs: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, delayMs);
    if (typeof timer.unref === "function") timer.unref();
    this.timers.add(timer);
  }

  private emit(
    engaged: boolean,
    scope: "global" | "model",
    reason: string,
    resetsAt?: number,
    model?: ModelName,
  ): void {
    this.bus.publish({
      type: "limit.backpressure",
      run_id: null,
      payload: { engaged, scope, model, reason, resets_at: resetsAt },
    });
  }
}
