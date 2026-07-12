/**
 * Planner output contract (§3, §15 Phase 2). The Planner emits a structured
 * Scope/Task breakdown validated against this shape before it is materialized
 * into {@link Scope}/{@link Task} rows for operator approval. Dependencies are
 * expressed by human-readable reference (scope `name`, task `title`) so the LLM
 * never has to invent ULIDs; the orchestrator resolves them at materialization.
 */

import type {
  Environment,
  ModelTier,
  ScopePermissionMode,
  TaskType,
} from "./enums.js";
import type { ForbiddenAction, SuccessCriterion } from "./entities.js";

/** A planned task inside a planned scope (materializes to a {@link Task}). */
export interface PlannedTask {
  title: string;
  prompt: string;
  task_type: TaskType;
  /** Titles of sibling tasks (within the same scope) this task depends on. */
  depends_on?: string[];
}

/** A planned scope (materializes to a {@link Scope}). */
export interface PlannedScope {
  name: string;
  description: string;
  path_allowlist: string[];
  path_denylist?: string[];
  allowed_tools: string[];
  disallowed_tools?: string[];
  model_tier: ModelTier;
  environment: Environment;
  permission_mode: ScopePermissionMode;
  forbidden_actions?: ForbiddenAction[];
  success_criteria?: SuccessCriterion[];
  max_budget_usd: number;
  /** Names of other scopes this scope depends on (scope-level DAG). */
  depends_on?: string[];
  tasks: PlannedTask[];
}

/** The Planner's full output: a proposed Scope/Task DAG for a Goal. */
export interface Plan {
  scopes: PlannedScope[];
}

/**
 * JSON Schema handed to the SDK via `outputFormat: { type: "json_schema" }` so
 * the Planner returns a machine-checkable {@link Plan}. Kept deliberately strict
 * on enums (they mirror {@link ModelTier}/{@link Environment}/etc.) so an invalid
 * plan fails fast at validation rather than at dispatch.
 */
export const PLAN_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["scopes"],
  properties: {
    scopes: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "name",
          "description",
          "path_allowlist",
          "allowed_tools",
          "model_tier",
          "environment",
          "permission_mode",
          "max_budget_usd",
          "tasks",
        ],
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          path_allowlist: { type: "array", items: { type: "string" } },
          path_denylist: { type: "array", items: { type: "string" } },
          allowed_tools: { type: "array", items: { type: "string" } },
          disallowed_tools: { type: "array", items: { type: "string" } },
          model_tier: {
            type: "string",
            enum: ["haiku", "sonnet", "opus", "auto"],
          },
          environment: {
            type: "string",
            enum: ["development", "staging", "production", "unknown"],
          },
          permission_mode: {
            type: "string",
            enum: ["plan", "default", "acceptEdits"],
          },
          forbidden_actions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["description"],
              properties: {
                description: { type: "string" },
                pattern: { type: "string" },
              },
            },
          },
          success_criteria: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["description"],
              properties: {
                description: { type: "string" },
                verification_method: { type: "string" },
              },
            },
          },
          max_budget_usd: { type: "number", minimum: 0 },
          depends_on: { type: "array", items: { type: "string" } },
          tasks: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["title", "prompt", "task_type"],
              properties: {
                title: { type: "string" },
                prompt: { type: "string" },
                task_type: {
                  type: "string",
                  enum: [
                    "mechanical",
                    "codegen",
                    "refactor",
                    "test",
                    "review",
                    "planning",
                    "research",
                  ],
                },
                depends_on: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
      },
    },
  },
};
