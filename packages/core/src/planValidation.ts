/**
 * Plan validation (§3, §15 Phase 2). A small hand-written validator — matching
 * the codebase's dependency-light style — that checks a Planner candidate
 * against the data model before it is materialized: required fields, enum
 * membership, and that every `depends_on` reference resolves to a sibling in
 * the plan (an unresolved edge would strand a task forever). Cycle detection is
 * left to the orchestrator's dependency gate, which simply never marks a cyclic
 * task ready; validation here catches the structural errors worth failing fast.
 */

import type {
  Environment,
  ModelTier,
  Plan,
  PlannedScope,
  PlannedTask,
  ScopePermissionMode,
  TaskType,
} from "@orc-brain/shared";

const MODEL_TIERS: ModelTier[] = ["haiku", "sonnet", "opus", "auto"];
const ENVIRONMENTS: Environment[] = [
  "development",
  "staging",
  "production",
  "unknown",
];
const PERMISSION_MODES: ScopePermissionMode[] = [
  "plan",
  "default",
  "acceptEdits",
];
const TASK_TYPES: TaskType[] = [
  "mechanical",
  "codegen",
  "refactor",
  "test",
  "review",
  "planning",
  "research",
];

/** Result of {@link validatePlan}: a validated plan or a list of reasons. */
export type PlanValidation =
  { ok: true; plan: Plan } | { ok: false; errors: string[] };

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Validates a single planned task, appending any problems to `errors`. */
function validateTask(t: unknown, where: string, errors: string[]): void {
  if (typeof t !== "object" || t === null) {
    errors.push(`${where}: task is not an object`);
    return;
  }
  const task = t as Record<string, unknown>;
  if (typeof task.title !== "string" || !task.title.trim()) {
    errors.push(`${where}: task.title missing`);
  }
  if (typeof task.prompt !== "string" || !task.prompt.trim()) {
    errors.push(`${where}: task.prompt missing`);
  }
  if (!TASK_TYPES.includes(task.task_type as TaskType)) {
    errors.push(`${where}: invalid task_type ${String(task.task_type)}`);
  }
  if (task.depends_on !== undefined && !isStringArray(task.depends_on)) {
    errors.push(`${where}: task.depends_on must be a string[]`);
  }
}

/** Validates a single planned scope, appending any problems to `errors`. */
function validateScope(s: unknown, index: number, errors: string[]): void {
  const where = `scopes[${index}]`;
  if (typeof s !== "object" || s === null) {
    errors.push(`${where}: scope is not an object`);
    return;
  }
  const scope = s as Record<string, unknown>;
  if (typeof scope.name !== "string" || !scope.name.trim()) {
    errors.push(`${where}: name missing`);
  }
  if (typeof scope.description !== "string") {
    errors.push(`${where}: description missing`);
  }
  if (
    !isStringArray(scope.path_allowlist) ||
    scope.path_allowlist.length === 0
  ) {
    errors.push(`${where}: path_allowlist must be a non-empty string[]`);
  }
  if (!isStringArray(scope.allowed_tools)) {
    errors.push(`${where}: allowed_tools must be a string[]`);
  }
  if (!MODEL_TIERS.includes(scope.model_tier as ModelTier)) {
    errors.push(`${where}: invalid model_tier ${String(scope.model_tier)}`);
  }
  if (!ENVIRONMENTS.includes(scope.environment as Environment)) {
    errors.push(`${where}: invalid environment ${String(scope.environment)}`);
  }
  if (
    !PERMISSION_MODES.includes(scope.permission_mode as ScopePermissionMode)
  ) {
    errors.push(
      `${where}: invalid permission_mode ${String(scope.permission_mode)} ` +
        `(bypassPermissions is not representable, §8.3)`,
    );
  }
  if (typeof scope.max_budget_usd !== "number" || scope.max_budget_usd < 0) {
    errors.push(`${where}: max_budget_usd must be a non-negative number`);
  }
  if (!Array.isArray(scope.tasks) || scope.tasks.length === 0) {
    errors.push(`${where}: tasks must be a non-empty array`);
  } else {
    scope.tasks.forEach((t, i) =>
      validateTask(t, `${where}.tasks[${i}]`, errors),
    );
    // Task depends_on must reference sibling titles within this scope.
    const titles = new Set(
      (scope.tasks as PlannedTask[])
        .map((t) => t?.title)
        .filter((x): x is string => typeof x === "string"),
    );
    (scope.tasks as PlannedTask[]).forEach((t, i) => {
      for (const dep of t?.depends_on ?? []) {
        if (!titles.has(dep)) {
          errors.push(
            `${where}.tasks[${i}]: depends_on "${dep}" has no matching sibling task`,
          );
        }
      }
    });
  }
}

/**
 * Validates a Planner candidate and returns a typed {@link Plan} on success.
 * Also checks scope-level `depends_on` references resolve to other scope names.
 */
export function validatePlan(candidate: unknown): PlanValidation {
  const errors: string[] = [];
  if (typeof candidate !== "object" || candidate === null) {
    return { ok: false, errors: ["plan is not an object"] };
  }
  const obj = candidate as Record<string, unknown>;
  if (!Array.isArray(obj.scopes) || obj.scopes.length === 0) {
    return { ok: false, errors: ["plan.scopes must be a non-empty array"] };
  }

  obj.scopes.forEach((s, i) => validateScope(s, i, errors));

  const scopeNames = new Set(
    (obj.scopes as PlannedScope[])
      .map((s) => s?.name)
      .filter((x): x is string => typeof x === "string"),
  );
  (obj.scopes as PlannedScope[]).forEach((s, i) => {
    for (const dep of s?.depends_on ?? []) {
      if (!scopeNames.has(dep)) {
        errors.push(
          `scopes[${i}]: depends_on "${dep}" has no matching scope name`,
        );
      }
    }
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, plan: candidate as Plan };
}
