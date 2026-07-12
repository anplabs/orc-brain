/** Enumerations for the orc-brain data model (§4) and state machines (§5). */

/**
 * Execution isolation mode of a registered Project (spec 002 §R1, §R8).
 * `worktree` runs each scope in a dedicated git worktree on an `orc/<goal>/
 * <scope>` branch; `in_repo` runs workers directly in the repo working tree
 * (the pre-project behavior).
 */
export type ProjectExecutionMode = "worktree" | "in_repo";

/** Goal lifecycle status. */
export type GoalStatus =
  "draft" | "planning" | "awaiting_approval" | "active" | "done" | "abandoned";

/**
 * Environment classification of a Scope (§4, §8.1). `unknown` is treated as
 * `production` everywhere enforcement happens — see the safety layer.
 */
export type Environment = "development" | "staging" | "production" | "unknown";

/**
 * Permission mode a Scope may request (§4, §8.3). `bypassPermissions` is
 * deliberately NOT representable — the safety layer refuses it structurally.
 */
export type ScopePermissionMode = "plan" | "default" | "acceptEdits";

/** Model tier a Scope pins, or `auto` to let the router decide (§6). */
export type ModelTier = "haiku" | "sonnet" | "opus" | "auto";

/** Concrete model a worker runs on. `inherit` defers to the session default. */
export type ModelName = "haiku" | "sonnet" | "opus" | "inherit";

/** Scope lifecycle status (§4). */
export type ScopeStatus =
  "proposed" | "approved" | "running" | "blocked" | "done" | "failed";

/** Router-relevant classification of a Task (§4, §6). */
export type TaskType =
  | "mechanical"
  | "codegen"
  | "refactor"
  | "test"
  | "review"
  | "planning"
  | "research";

/** Task lifecycle status (§5). */
export type TaskStatus =
  | "pending"
  | "queued"
  | "running"
  | "paused"
  | "blocked"
  | "done"
  | "failed"
  | "skipped"
  | "cancelled";

/** Run state machine states (§5). */
export type RunState =
  | "draft"
  | "planning"
  | "awaiting_approval"
  | "running"
  | "pausing"
  | "paused"
  | "done"
  | "failed";

/** Budget backpressure state (§7). */
export type BudgetState = "ok" | "warn" | "stopped";

/** Live worker session state (§4 SubagentRecord). */
export type SubagentState =
  "spawning" | "running" | "interrupting" | "paused" | "exited";

/** What triggered a report (§11). */
export type ReportTrigger =
  | "interval"
  | "scope_done"
  | "task_done"
  | "budget_threshold"
  | "manual"
  | "final";

/** Lifecycle of an operator escalation raised by a blocked tool call (§8.5). */
export type EscalationStatus = "open" | "resolved";

/** The three operator resolutions for a blocked action (§8.5). */
export type EscalationAction = "deny_instruct" | "approve_once" | "skip_task";

/** Scope of an engaged rate-limit backpressure (§7.4). */
export type BackpressureScope = "global" | "model";

/** Kinds of audit event recorded to the append-only JSONL log (§4, §8.6). */
export type AuditKind =
  | "tool_call"
  | "tool_result"
  | "hook_block"
  | "permission_deny"
  | "permission_allow"
  | "interrupt"
  | "dispatch"
  | "state_change"
  | "routing_decision"
  | "escalation"
  | "exemption"
  | "backpressure"
  | "report";
