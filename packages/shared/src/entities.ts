/** Core entities of the orc-brain data model (§4). */

import type { EntityBase, IsoTimestamp, Ulid } from "./ids.js";
import type {
  BudgetState,
  Environment,
  EscalationAction,
  EscalationStatus,
  GoalStatus,
  ModelName,
  ModelTier,
  ProjectExecutionMode,
  ReportTrigger,
  RunState,
  ScopePermissionMode,
  ScopeStatus,
  SubagentState,
  TaskStatus,
  TaskType,
} from "./enums.js";

/** A checkable success statement attached to a Goal or Scope (§4). */
export interface SuccessCriterion {
  description: string;
  verification_method?: string;
}

/** A human-readable + machine-matchable forbidden action on a Scope (§4, §8). */
export interface ForbiddenAction {
  description: string;
  /** Optional machine pattern appended to the scope's deny rules. */
  pattern?: string;
}

/**
 * Project: a registered local repository orc operates on (spec 002 §R1).
 * `repo_root` is unique; `execution_mode` decides worktree isolation (§R8) and
 * the `default_*` fields seed runs started by the feature flow (§R5).
 */
export interface Project extends EntityBase {
  name: string;
  repo_root: string;
  execution_mode: ProjectExecutionMode;
  default_budget_usd: number;
  default_concurrency: number;
  /**
   * When true (worktree mode only), a successfully settled scope branch is
   * merged (`--no-ff`) into the run's base branch automatically (spec 002 v2).
   * Skipped — branch kept for manual merge — if the checkout is dirty, on a
   * different branch, or the merge conflicts.
   */
  auto_merge: boolean;
}

/**
 * Back-reference from a Goal to the external tracker task it was imported
 * from (spec 003 §R2, §3.5). Null for goals typed by the operator.
 */
export interface ExternalRef {
  /** Plugin name that owns the task (e.g. `"linear"`). */
  provider: string;
  /** Provider-native stable id. */
  id: string;
  /** Human identifier (e.g. `"ENG-123"`). */
  identifier: string;
  url: string;
  title: string;
}

/** Goal: the top-level objective (§4). */
export interface Goal extends EntityBase {
  title: string;
  objective: string;
  success_criteria: SuccessCriterion[];
  constraints: string[];
  out_of_scope: string[];
  /** Owning project (spec 002 §R2); null only for pre-project legacy goals. */
  project_id: Ulid | null;
  /** Denormalized from the project at creation so consumers stay unchanged. */
  repo_root: string;
  status: GoalStatus;
  /** Origin tracker task when imported via a plugin (spec 003 §R2). */
  external_ref: ExternalRef | null;
}

/** Scope: a bounded region of work and the unit of safety config (§4). */
export interface Scope extends EntityBase {
  goal_id: Ulid;
  name: string;
  description: string;
  path_allowlist: string[];
  path_denylist: string[];
  allowed_tools: string[];
  disallowed_tools: string[];
  model_tier: ModelTier;
  environment: Environment;
  permission_mode: ScopePermissionMode;
  forbidden_actions: ForbiddenAction[];
  success_criteria: SuccessCriterion[];
  max_budget_usd: number;
  status: ScopeStatus;
  depends_on: Ulid[];
  /** Worktree the scope's workers run in, when isolated (spec 002 §R8). */
  worktree_path: string | null;
  /** Scope branch (`orc/<goal>/<scope>`), kept after the worktree is removed. */
  branch_name: string | null;
}

/** Task: an atomic dispatchable unit inside a Scope (§4). */
export interface Task extends EntityBase {
  scope_id: Ulid;
  title: string;
  prompt: string;
  task_type: TaskType;
  depends_on: Ulid[];
  status: TaskStatus;
  /**
   * Dispatch priority (spec 002 v2, kanban drag): higher dispatches first;
   * ties fall back to creation order. 0 for every task by default.
   */
  priority: number;
  attempt: number;
  model_used: ModelName | null;
  routing_reason: string | null;
  session_id: string | null;
  cost_usd: number;
  result_summary: unknown | null;
  error: unknown | null;
  /** Set when a non-graceful stop may have left half-applied edits (§5, §13.6). */
  dirty: boolean;
}

/** SubagentRecord: a live/finished worker session, 1:1 with a Task attempt (§4). */
export interface SubagentRecord extends EntityBase {
  task_id: Ulid;
  session_id: string | null;
  model: ModelName;
  pid: number | null;
  state: SubagentState;
  started_at: IsoTimestamp | null;
  ended_at: IsoTimestamp | null;
  num_turns: number;
  cost_usd: number;
  last_tool_call: unknown | null;
  transcript_path: string | null;
}

/** Run: one execution of a Goal (§4). */
export interface Run extends EntityBase {
  goal_id: Ulid;
  state: RunState;
  budget_usd: number;
  budget_spent_usd: number;
  budget_state: BudgetState;
  concurrency_limit: number;
  started_at: IsoTimestamp | null;
  paused_at: IsoTimestamp | null;
  finished_at: IsoTimestamp | null;
  pause_reason: string | null;
  /**
   * Branch of the repo when the run started (spec 002 §R8, §R10): worktrees
   * fork from it and environment classification uses it, never the `orc/…`
   * worktree branch. Null when the repo branch could not be read.
   */
  base_branch: string | null;
  /**
   * True for runs started by the feature flow (spec 002 §R5): the run hands
   * off to the autonomous controller on quiescence even when the global
   * `autoLoop.enabled` config is off, and replan cycles are unattended.
   */
  auto_loop: boolean;
  /**
   * Count of autonomous re-plan cycles executed for this run
   * (.specs/active/autonomous-loop.md §3.5, G5). Guards against runaway loops
   * via `AutoLoopConfig.max_replan_cycles`. 0 for static (non-auto) runs.
   */
  replan_cycle: number;
}

/**
 * Escalation: a blocked tool call awaiting operator resolution (§8.5). Raised
 * when a task hits the same deny rule twice; the run continues elsewhere.
 */
export interface Escalation extends EntityBase {
  run_id: Ulid;
  task_id: Ulid;
  rule_id: string;
  tool_name: string;
  /** Redacted, truncated tool input for display (§8.6). */
  input_summary: string;
  /** The subagent's stated intent, if captured. */
  stated_intent: string | null;
  status: EscalationStatus;
  /** How the operator resolved it, once resolved. */
  action: EscalationAction | null;
  /** Operator guidance sent back to the subagent (deny_instruct). */
  message: string | null;
  resolved_at: IsoTimestamp | null;
}

/** Report: a rendered Markdown status report (§4, §11). */
export interface Report extends EntityBase {
  run_id: Ulid;
  trigger: ReportTrigger;
  content_md: string;
  path: string | null;
}

/**
 * BudgetLedgerEntry: one row per SDK result message; the source of truth for
 * cost aggregation (§4, §7). Aggregation is `SUM()` over this table.
 */
export interface BudgetLedgerEntry extends EntityBase {
  run_id: Ulid;
  task_id: Ulid;
  session_id: string | null;
  cost_usd: number;
  num_turns: number;
  model: string;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_write: number;
  recorded_at: IsoTimestamp;
}

/**
 * AuditEvent: an append-only JSONL record. Never stored in SQLite (§4, §8.6).
 * `tool_input` is redacted per §8.6 before it is written.
 */
export interface AuditEvent {
  ts: IsoTimestamp;
  /** Who acted, when not a worker — e.g. `"plugin:linear"` (spec 003 §R6). */
  actor?: string;
  run_id: Ulid | null;
  task_id: Ulid | null;
  session_id: string | null;
  kind: import("./enums.js").AuditKind;
  tool_name: string | null;
  tool_input_hash: string | null;
  tool_input: unknown;
  decision: string | null;
  rule_id: string | null;
  detail: unknown;
}
