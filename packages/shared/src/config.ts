/** Configuration shapes for routing, budget, safety, and limits (§6, §7, §8). */

import type { ModelName, TaskType } from "./enums.js";

/** Budget thresholds and per-task bounds (§7). */
export interface BudgetConfig {
  /** Fraction of run budget at which to warn (default 0.7). */
  warn_at: number;
  /** Fraction of run budget at which dispatch halts (default 0.9). */
  hard_stop_at: number;
  /** Floor for the per-task `maxBudgetUsd` bound (default 0.5). */
  per_task_min_usd: number;
  /** Cap for the per-task `maxBudgetUsd` bound (default 5). */
  per_task_max_usd: number;
  /** Secondary volume ceilings (§7.6). */
  max_tasks_per_run: number;
  max_tasks_per_hour: number;
}

/** A single model-routing rule (§6). Evaluated in order; first match wins. */
export interface RoutingRule {
  id: string;
  description: string;
  when: {
    task_types?: TaskType[];
    /** Applies only when the scope did not pin a tier. */
    unpinned_only?: boolean;
  };
  model: ModelName;
}

/** Model routing policy (§6). */
export interface RoutingConfig {
  rules: RoutingRule[];
  /** Fallback model when no rule matches. */
  default_model: ModelName;
  /**
   * When set, every task runs on this model — overrides scope pins, the static
   * table, and the dynamic escalations (R1–R7). Configurable via the
   * `ORC_FORCE_MODEL` environment variable on `orc serve`.
   */
  force_model?: ModelName | null;
}

/** Dev-scope posture per destructive rule class (§8.2, Open Decision 5). */
export type DevPosture = "allow_with_audit" | "require_approval" | "deny";

/** Safety configuration (§8). Production rules are never disableable. */
export interface SafetyConfig {
  /**
   * Host/URL substrings that force a `production` classification (§8.1).
   * Anything not matching a local/RFC-1918 pattern is `unknown` ⇒ production.
   */
  prod_host_indicators: string[];
  /** Branch names that classify the cwd as production (§8.1). */
  prod_branches: string[];
  /** Per-class dev-scope posture (§8.2). Prod scopes always deny. */
  dev_posture: Record<string, DevPosture>;
}

/** Rate-limit detection patterns, kept in config because they drift (§7.4). */
export interface LimitConfig {
  /** Regex sources matched against worker error text. */
  patterns: {
    session_limit: string;
    weekly_limit: string;
    model_limit: string;
  };
  /** Backoff schedule in ms when a reset time can't be parsed (§7.4). */
  backoff_ms: number[];
  /** Cap on backoff in ms. */
  backoff_cap_ms: number;
}

/** Planner configuration (§3, §15 Phase 2). */
export interface PlannerConfig {
  /** Model the plan-only session is pinned to (§3: Opus). */
  model: ModelName;
  /** Read-only tools the Planner may use to inspect the repo (§3). */
  allowed_tools: string[];
  /** Turn ceiling for a planning session. */
  max_turns: number;
}

/** Retry policy for failed tasks (§5, §13; router R5 escalates on retry). */
export interface RetryConfig {
  /** Maximum attempts per task before it is left `failed` (attempt 0 = first try). */
  max_attempts: number;
}

/** Reporting cadence (§11). */
export interface ReportingConfig {
  /** Minutes between interval reports while Running (default 15). */
  interval_minutes: number;
}

/** Escalation / blocked-queue posture (§8.5). */
export interface EscalationConfig {
  /**
   * Number of same-rule denials in one task before it transitions to `blocked`
   * and an escalation is raised (§8.5 default: halt on the 2nd denial).
   */
  block_on_denial_count: number;
}

/** Pause / interrupt grace behaviour (§5). */
export interface PauseConfig {
  /** Grace window (ms) for workers to yield before SIGTERM (§5). */
  grace_ms: number;
  /** Additional window (ms) after SIGTERM before SIGKILL (§5). */
  sigkill_after_ms: number;
}

/**
 * Autonomous outer-loop ("auto-replan controller") posture
 * (.specs/active/autonomous-loop.md §3.5). Opt-in; default preserves the
 * static plan-once/execute-fixed-DAG behavior.
 */
export interface AutoLoopConfig {
  /** When false, the controller never engages — behavior is unchanged (AC1). */
  enabled: boolean;
  /**
   * `supervised` keeps the human plan-approval gate for re-planned scopes;
   * `unattended` auto-approves them (still fully bound by the safety layer,
   * scope boundaries, budget, and escalations).
   */
  mode: "supervised" | "unattended";
  /** Re-plan trigger granularity. `scope` = after each scope completes. */
  replan_on: "scope";
  /** Runaway ceiling: max re-plan cycles before the run is paused (G5). */
  max_replan_cycles: number;
}

/** Top-level orchestrator configuration (`orchestrator.toml`, §12). */
export interface OrchestratorConfig {
  concurrency_limit: number;
  /**
   * Cap on simultaneously running workers across ALL runs (spec 002 §R13) —
   * the subscription is shared, so per-run limits alone don't bound total load.
   */
  global_concurrency_limit: number;
  budget: BudgetConfig;
  routing: RoutingConfig;
  safety: SafetyConfig;
  limits: LimitConfig;
  planner: PlannerConfig;
  retry: RetryConfig;
  reporting: ReportingConfig;
  escalation: EscalationConfig;
  pause: PauseConfig;
  autoLoop: AutoLoopConfig;
}
