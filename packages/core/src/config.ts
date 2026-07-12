/**
 * Default orchestrator configuration (§6, §7, §8). These are the recommended
 * defaults from §14; `orchestrator.toml` overrides land in Phase 2. Values are
 * exported so the router, budget tracker, and safety layer share one source.
 */

import type { OrchestratorConfig } from "@orc-brain/shared";

/** Recommended defaults (§14: concurrency 3, warn 70%, hard-stop 90%). */
export const DEFAULT_CONFIG: OrchestratorConfig = {
  concurrency_limit: 3,
  // Fleet-wide worker cap across all runs (spec 002 §R13). ≥ concurrency_limit
  // so a single-run setup behaves exactly as before.
  global_concurrency_limit: 4,
  budget: {
    warn_at: 0.7,
    hard_stop_at: 0.9,
    per_task_min_usd: 0.5,
    per_task_max_usd: 5,
    max_tasks_per_run: 200,
    max_tasks_per_hour: 120,
  },
  routing: {
    // Order matters: first matching rule wins (§6). R1 (scope pin) is applied
    // in the router before this table; R5–R7 are dynamic escalations.
    rules: [
      {
        id: "R2",
        description: "architecture-level planning/research/review → opus",
        when: { task_types: ["planning", "research", "review"] },
        model: "opus",
      },
      {
        id: "R3",
        description: "codegen/refactor/test → sonnet",
        when: { task_types: ["codegen", "refactor", "test"] },
        model: "sonnet",
      },
      {
        id: "R4",
        description: "mechanical work → haiku",
        when: { task_types: ["mechanical"] },
        model: "haiku",
      },
    ],
    default_model: "sonnet",
    // No forced model by default; set via config or ORC_FORCE_MODEL (§6 R-F).
    force_model: null,
  },
  safety: {
    // Default treats any non-local/non-RFC-1918 host as unknown ⇒ production
    // (§8.1, Open Decision 12). Seed with real prod hosts to loosen dev friction.
    prod_host_indicators: [],
    prod_branches: ["main", "master", "prod", "production", "release/*"],
    // Open Decision 5: require-approval for VCS/db/infra in dev, allow-with-audit
    // for filesystem-within-allowlist. Prod scopes always deny regardless.
    dev_posture: {
      filesystem: "allow_with_audit",
      vcs: "require_approval",
      database: "require_approval",
      infra: "require_approval",
      publish: "require_approval",
      credential: "deny",
      network: "require_approval",
    },
  },
  limits: {
    patterns: {
      session_limit: "session limit|resets? (at )?\\d",
      weekly_limit: "weekly limit",
      model_limit: "(opus|sonnet|haiku) limit",
    },
    backoff_ms: [60_000, 120_000, 240_000, 480_000, 960_000],
    backoff_cap_ms: 1_800_000,
  },
  planner: {
    // Pinned to Opus in plan mode with read-only tools (§3). It inspects the
    // repo to decompose the goal but can never edit or run Bash.
    model: "opus",
    allowed_tools: ["Read", "Glob", "Grep"],
    max_turns: 40,
  },
  retry: {
    // failed → queued, bounded (§5). 3 attempts feeds router R5 (escalate a
    // tier after ≥2 attempts on the current model).
    max_attempts: 3,
  },
  reporting: {
    // Interval reports every 15 min while Running (§11, Open Decision 10).
    interval_minutes: 15,
  },
  escalation: {
    // Halt-scope-and-ask on the 2nd same-rule denial (§8.5, Open Decision 11).
    block_on_denial_count: 2,
  },
  pause: {
    // 60s grace, then SIGTERM, then SIGKILL after 10s (§5).
    grace_ms: 60_000,
    sigkill_after_ms: 10_000,
  },
  autoLoop: {
    // Opt-in; default is the static plan-once behavior (autonomous-loop.md §3.5,
    // AC1). Supervised keeps the human approval gate; runaway ceiling of 5.
    enabled: false,
    mode: "supervised",
    replan_on: "scope",
    max_replan_cycles: 5,
  },
};
