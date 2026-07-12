/**
 * Model router (§6): deterministic, rule-based, explainable, reproducible. No
 * LLM in the routing decision itself — the Planner already labelled each task
 * with `task_type`. Every decision carries the rule that fired and a reason,
 * emitted as a `routing_decision` audit event by the caller.
 */

import type {
  BudgetState,
  ModelName,
  ModelTier,
  RoutingConfig,
  TaskType,
} from "@orc-brain/shared";

/** Output of a routing decision. */
export interface RoutingDecision {
  model: ModelName;
  rule_id: string;
  reason: string;
  /** Set when R7 routed around a rate-limited model. */
  degraded?: boolean;
  /** Set when R5 escalated after repeated failures. */
  escalated_from?: ModelName;
}

/** Dynamic signals that influence routing beyond the static table. */
export interface RoutingContext {
  /** Current budget backpressure state (R6). */
  budget_state?: BudgetState;
  /** Models currently quarantined by rate limits (R7). */
  quarantined?: ModelName[];
  /** Attempt count for escalation (R5). */
  attempt?: number;
  /** Model used on the previous attempt, for escalation bumps (R5). */
  previous_model?: ModelName;
}

const TIER_ORDER: ModelName[] = ["haiku", "sonnet", "opus"];

/** Bumps a model up one tier (haiku→sonnet→opus), capped at opus. */
function bumpTier(model: ModelName): ModelName {
  const idx = TIER_ORDER.indexOf(model);
  if (idx < 0) return "opus";
  return TIER_ORDER[Math.min(idx + 1, TIER_ORDER.length - 1)]!;
}

/** Routes around a quarantined model (R7): opus→sonnet→haiku. */
function routeAround(model: ModelName, quarantined: ModelName[]): ModelName {
  let m = model;
  const order: ModelName[] = ["opus", "sonnet", "haiku"];
  let guard = 0;
  while (quarantined.includes(m) && guard++ < order.length) {
    const idx = order.indexOf(m);
    m = order[Math.min(idx + 1, order.length - 1)]!;
    if (idx === order.length - 1) break; // haiku is the floor
  }
  return m;
}

/** Maps a scope tier to a concrete model, or null for `auto`. */
function tierToModel(tier: ModelTier): ModelName | null {
  return tier === "auto" ? null : tier;
}

/** Selects a model from the static table for a task type (§6 R2–R4). */
function fromTable(
  taskType: TaskType,
  routing: RoutingConfig,
): { model: ModelName; rule_id: string; reason: string } {
  for (const rule of routing.rules) {
    if (rule.when.task_types?.includes(taskType)) {
      return { model: rule.model, rule_id: rule.id, reason: rule.description };
    }
  }
  return {
    model: routing.default_model,
    rule_id: "R0",
    reason: "default model (no rule matched)",
  };
}

/**
 * Computes the model for a task (§6). Rule precedence:
 * R1 scope pin → R5 escalation → R6 budget warn cap → R7 rate-limit reroute →
 * R2–R4 static table.
 */
export function routeModel(input: {
  task_type: TaskType;
  model_tier: ModelTier;
  routing: RoutingConfig;
  ctx?: RoutingContext;
}): RoutingDecision {
  const { task_type, model_tier, routing } = input;
  const ctx = input.ctx ?? {};
  const pinned = tierToModel(model_tier);

  // R1: scope pin wins for the base choice, but escalation/reroute can still act.
  let base = pinned ?? fromTable(task_type, routing).model;
  const baseRuleId = pinned ? "R1" : fromTable(task_type, routing).rule_id;
  const baseReason = pinned
    ? `scope pinned model_tier=${model_tier}`
    : fromTable(task_type, routing).reason;

  let decision: RoutingDecision = {
    model: base,
    rule_id: baseRuleId,
    reason: baseReason,
  };

  // R5: escalation after ≥2 attempts on the current model, bump one tier.
  if ((ctx.attempt ?? 0) >= 2 && ctx.previous_model) {
    const bumped = bumpTier(ctx.previous_model);
    if (bumped !== ctx.previous_model) {
      decision = {
        model: bumped,
        rule_id: "R5",
        reason: `escalated after ${ctx.attempt} attempts`,
        escalated_from: ctx.previous_model,
      };
      base = bumped;
    }
  }

  // R6: budget warn caps new dispatches at sonnet unless R1 pinned opus.
  if (ctx.budget_state === "warn" && !(pinned === "opus")) {
    if (base === "opus") {
      decision = {
        ...decision,
        model: "sonnet",
        rule_id: "R6",
        reason: "budget warn: capped at sonnet",
      };
      base = "sonnet";
    }
  }

  // R7: quarantined model → route around, flag degraded.
  const quarantined = ctx.quarantined ?? [];
  if (quarantined.includes(base)) {
    const rerouted = routeAround(base, quarantined);
    if (rerouted !== base) {
      decision = {
        model: rerouted,
        rule_id: "R7",
        reason: `${base} rate-limited: routed around`,
        degraded: true,
      };
    }
  }

  return decision;
}
