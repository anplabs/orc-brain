/**
 * Usage & budget tracker (§7). This is an *estimator plus a backpressure
 * system*, not a meter: under subscription auth `total_cost_usd` is an
 * estimated USD-equivalent, not a billed amount. It provides (a) relative
 * consumption per run/scope/task, (b) a spend-equivalent ceiling, and (c)
 * graceful reaction to real rate-limit signals (handled in limitSignals).
 */

import type { BudgetConfig, BudgetState } from "@orc-brain/shared";
import type { Store } from "./store/index.js";
import type { EventBus } from "./eventBus.js";

/** The subset of an SDK result message the ledger needs (§7.1). */
export interface ResultUsageLike {
  total_cost_usd?: number;
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  } | null;
}

/** Computes the budget state from spend against thresholds (§7.3). */
export function computeBudgetState(
  spent: number,
  budget: number,
  config: BudgetConfig,
): BudgetState {
  if (budget <= 0) return "ok";
  const frac = spent / budget;
  if (frac >= config.hard_stop_at) return "stopped";
  if (frac >= config.warn_at) return "warn";
  return "ok";
}

/**
 * Per-task hard bound (§7.2, Open Decision 6): scope budget ÷ task count,
 * clamped to `[per_task_min_usd, per_task_max_usd]`. Passed to the worker as
 * the SDK `maxBudgetUsd` option.
 */
export function perTaskBudgetUsd(
  scopeBudgetUsd: number,
  taskCount: number,
  config: BudgetConfig,
): number {
  const raw = taskCount > 0 ? scopeBudgetUsd / taskCount : scopeBudgetUsd;
  return Math.min(
    config.per_task_max_usd,
    Math.max(config.per_task_min_usd, raw),
  );
}

/** Ledger recorder + threshold enforcer for a single run. */
export class BudgetTracker {
  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly config: BudgetConfig,
  ) {}

  /**
   * Records one result message to the ledger (one row per message — the source
   * of truth for aggregation, §7.1), recomputes the run's spend and budget
   * state, and emits `budget.tick`. Returns the new budget state.
   */
  recordResult(args: {
    run_id: string;
    task_id: string;
    session_id: string | null;
    model: string;
    result: ResultUsageLike;
  }): BudgetState {
    const u = args.result.usage ?? {};
    this.store.insertLedgerEntry({
      run_id: args.run_id,
      task_id: args.task_id,
      session_id: args.session_id,
      cost_usd: args.result.total_cost_usd ?? 0,
      num_turns: args.result.num_turns ?? 0,
      model: args.model,
      tokens_in: u.input_tokens ?? 0,
      tokens_out: u.output_tokens ?? 0,
      cache_read: u.cache_read_input_tokens ?? 0,
      cache_write: u.cache_creation_input_tokens ?? 0,
      recorded_at: new Date().toISOString(),
    });

    // Roll the task's own cost forward too, for per-task display.
    const taskCost = this.store.sumCostForTask(args.task_id);
    this.store.updateTask(args.task_id, { cost_usd: taskCost });

    return this.refresh(args.run_id);
  }

  /** Recomputes spend + state for a run from the ledger and emits a tick (§7.3). */
  refresh(runId: string): BudgetState {
    const run = this.store.getRun(runId);
    if (!run) return "ok";
    const spent = this.store.sumCostForRun(runId);
    const state = computeBudgetState(spent, run.budget_usd, this.config);
    this.store.updateRun(runId, {
      budget_spent_usd: spent,
      budget_state: state,
    });
    this.bus.publish({
      type: "budget.tick",
      run_id: runId,
      payload: {
        budget_usd: run.budget_usd,
        spent_usd: spent,
        state,
        warn_at: this.config.warn_at,
        stop_at: this.config.hard_stop_at,
      },
    });
    return state;
  }

  /** True when dispatch must halt because the run hit the hard stop (§7.3). */
  isStopped(runId: string): boolean {
    const run = this.store.getRun(runId);
    return run?.budget_state === "stopped";
  }
}
