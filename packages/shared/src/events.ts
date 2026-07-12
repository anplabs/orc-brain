/**
 * Event bus / SSE event schemas (§3, §10). Every event is appended to the
 * store before fan-out, so the persisted log is never behind the UI.
 */

import type { IsoTimestamp, Ulid } from "./ids.js";
import type { BudgetState, ModelName, RunState, TaskStatus } from "./enums.js";
import type { ExternalRef } from "./entities.js";

/** Envelope carried by every bus/SSE event. */
export interface EventEnvelope<K extends string, P> {
  /** Monotonic per-run sequence id; also the SSE `id:` for Last-Event-ID resume. */
  seq: number;
  ts: IsoTimestamp;
  run_id: Ulid | null;
  type: K;
  payload: P;
}

/** A task changed state (§10 `task.state`). */
export type TaskStateEvent = EventEnvelope<
  "task.state",
  {
    task_id: Ulid;
    scope_id: Ulid;
    status: TaskStatus;
    model?: ModelName;
    routing_reason?: string;
    attempt?: number;
    error?: unknown;
  }
>;

/** A worker began a tool call (§10 `tool.call`). */
export type ToolCallEvent = EventEnvelope<
  "tool.call",
  {
    task_id: Ulid;
    session_id: string | null;
    tool_name: string;
    /** Truncated/redacted input summary for display. */
    input_summary: string;
    decision?: "allow" | "deny";
    rule_id?: string;
  }
>;

/** A tool call produced a result (§10 `tool.result`). */
export type ToolResultEvent = EventEnvelope<
  "tool.result",
  {
    task_id: Ulid;
    session_id: string | null;
    tool_name: string;
    is_error: boolean;
    summary: string;
  }
>;

/** A streamed text delta from a worker (§10 `text.delta`). */
export type TextDeltaEvent = EventEnvelope<
  "text.delta",
  { task_id: Ulid; session_id: string | null; delta: string }
>;

/** Budget ledger updated (§10 `budget.tick`). */
export type BudgetTickEvent = EventEnvelope<
  "budget.tick",
  {
    budget_usd: number;
    spent_usd: number;
    state: BudgetState;
    warn_at: number;
    stop_at: number;
  }
>;

/** Rate-limit backpressure engaged/cleared (§7, §10 `limit.backpressure`). */
export type LimitBackpressureEvent = EventEnvelope<
  "limit.backpressure",
  {
    engaged: boolean;
    scope: "global" | "model";
    model?: ModelName;
    reason: string;
    /** Epoch ms when backpressure is expected to clear, if known. */
    resets_at?: number;
  }
>;

/** Run state machine transition (§10 `run.state`). */
export type RunStateEvent = EventEnvelope<
  "run.state",
  { state: RunState; reason?: string }
>;

/** A tool call was blocked and needs operator action (§8.5, §10 `escalation.new`). */
export type EscalationEvent = EventEnvelope<
  "escalation.new",
  {
    escalation_id: Ulid;
    task_id: Ulid;
    rule_id: string;
    tool_name: string;
    input_summary: string;
    stated_intent?: string;
  }
>;

/** A new report was generated (§10 `report.new`). */
export type ReportEvent = EventEnvelope<
  "report.new",
  { report_id: Ulid; trigger: string; path: string | null }
>;

/** A worker was dispatched (§5 dispatch loop). */
export type DispatchEvent = EventEnvelope<
  "dispatch",
  { task_id: Ulid; scope_id: Ulid; model: ModelName; routing_reason: string }
>;

/**
 * A scope reached a terminal state — all its tasks settled
 * (.specs/active/autonomous-loop.md §3.2, G1). `scope.done` = none failed;
 * `scope.failed` = at least one task failed after retries.
 */
export type ScopeSettledEvent = EventEnvelope<
  "scope.done" | "scope.failed",
  { scope_id: Ulid; goal_id: Ulid; task_count: number; failed_count: number }
>;

/**
 * The autonomous controller ran a re-plan cycle
 * (.specs/active/autonomous-loop.md §3.1, G2). `added_tasks` = 0 signals the
 * no-progress guard (G5).
 */
export type ReplanCycleEvent = EventEnvelope<
  "replan_cycle",
  { cycle: number; added_scopes: number; added_tasks: number }
>;

/**
 * The hybrid goal-satisfaction evaluator produced a verdict
 * (.specs/active/autonomous-loop.md §3.4, G3).
 */
export type GoalEvaluatedEvent = EventEnvelope<
  "goal_evaluated",
  { satisfied: boolean; unmet: string[]; rationale: string }
>;

/**
 * Dispatch was deferred by proactive pacing (spec 002 §R16): the global
 * concurrency cap, the tasks-per-hour throttle, or the per-run task ceiling.
 * Edge-triggered — published when the gate first engages, not every tick.
 */
export type PacingHoldEvent = EventEnvelope<
  "pacing.hold",
  {
    reason: "global_concurrency" | "tasks_per_hour" | "tasks_per_run";
    /** ISO timestamp when dispatch is expected to resume, if known. */
    resume_at?: IsoTimestamp;
  }
>;

/**
 * A plugin performed (or failed) an outbound sync action against its external
 * tracker (spec 003 §R9, §R12) — e.g. a Linear comment or state transition.
 * Published by the plugin host via `host.reportSync`.
 */
export type PluginSyncEvent = EventEnvelope<
  "plugin.sync",
  {
    plugin: string;
    action: string;
    ref?: ExternalRef;
    ok: boolean;
    detail?: string;
  }
>;

/** Discriminated union of all bus/SSE events. */
export type BusEvent =
  | TaskStateEvent
  | ToolCallEvent
  | ToolResultEvent
  | TextDeltaEvent
  | BudgetTickEvent
  | LimitBackpressureEvent
  | RunStateEvent
  | EscalationEvent
  | ReportEvent
  | DispatchEvent
  | ScopeSettledEvent
  | ReplanCycleEvent
  | GoalEvaluatedEvent
  | PacingHoldEvent
  | PluginSyncEvent;

/** String literal type of every event kind. */
export type BusEventType = BusEvent["type"];
