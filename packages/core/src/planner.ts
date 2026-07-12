/**
 * Planner (§3, §15 Phase 2). Decomposes a Goal into a proposed Scope/Task DAG
 * via a dedicated SDK session pinned to Opus, `permissionMode: "plan"`, with
 * read-only tools ({@link PlannerConfig.allowed_tools}) — it may inspect the
 * repo to plan but can never edit, run Bash, or dispatch. The plan is emitted
 * as structured output (`outputFormat: json_schema`), validated against the
 * data model, and returned inert for human approval. The Planner never executes
 * and never dispatches (that is the Orchestrator's job).
 */

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  Options,
  Query,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Goal, OrchestratorConfig, Plan } from "@orc-brain/shared";
import { PLAN_JSON_SCHEMA } from "@orc-brain/shared";
import { buildSpawnEnv } from "./spawnEnv.js";
import { validatePlan } from "./planValidation.js";

/** Injectable SDK entrypoint, so tests can substitute a fake planning stream. */
export type PlanQueryFn = (params: {
  prompt: string;
  options?: Options;
}) => Query;

/** Raised when the Planner session finished without a usable plan. */
export class PlannerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlannerError";
  }
}

/** Builds the plan-only session prompt from a Goal (§3 input: Goal + repo). */
export function buildPlanPrompt(goal: Goal): string {
  const criteria = goal.success_criteria
    .map((c) => `- ${c.description}`)
    .join("\n");
  const constraints = goal.constraints.map((c) => `- ${c}`).join("\n");
  const outOfScope = goal.out_of_scope.map((c) => `- ${c}`).join("\n");
  return [
    "You are the planning brain of a local orchestrator. Decompose the goal",
    "below into a DAG of bounded scopes, each holding one or more atomic tasks.",
    "You are in read-only plan mode: inspect the repository with Read/Glob/Grep",
    "to ground the plan, but do not edit anything or run commands.",
    "",
    `# Goal: ${goal.title}`,
    `Repository root: ${goal.repo_root}`,
    "",
    "## Objective",
    goal.objective,
    "",
    criteria ? `## Success criteria\n${criteria}` : "",
    constraints ? `## Constraints (must be honored)\n${constraints}` : "",
    outOfScope ? `## Out of scope (must not be touched)\n${outOfScope}` : "",
    "",
    "## Planning rules",
    "- Each scope is a unit of safety config: give it the tightest",
    "  `path_allowlist`, minimal `allowed_tools`, and correct `environment`",
    "  (use `development` only when certain; prefer `unknown` when unsure — it",
    "  is treated as production).",
    '- Prefer `permission_mode: "default"`; never request bypass.',
    "- Size tasks small and give each a precise, self-contained `prompt`.",
    "- Label each task's `task_type` so the model router can pick a model.",
    "- Express dependencies by name: scope `depends_on` references other scope",
    "  names; task `depends_on` references sibling task titles in the same scope.",
    "",
    "Return the plan as structured JSON matching the provided schema.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Context fed to a re-plan cycle (autonomous-loop.md §3.3, G2): a digest of
 * completed work and the criteria still unmet per the last evaluation.
 */
export interface ReplanContext {
  /** Human-readable lines of completed work (scope/task + result summary). */
  completedDigest: string[];
  /** Success criteria still unmet, from the last evaluator verdict. */
  unmetCriteria: string[];
}

/**
 * Builds the re-plan prompt (autonomous-loop.md §3.3). Same read-only plan-mode
 * framing as {@link buildPlanPrompt}, but asks for *additional* scopes/tasks to
 * close the gap to the unmet criteria, given what the completed scopes produced.
 * New scopes express `depends_on` only among themselves — earlier scopes are
 * already complete, so referencing them would be an always-satisfied no-op (and
 * the within-plan validator would reject a dangling reference).
 */
export function buildReplanPrompt(goal: Goal, context: ReplanContext): string {
  const digest = context.completedDigest.map((d) => `- ${d}`).join("\n");
  const unmet = context.unmetCriteria.map((c) => `- ${c}`).join("\n");
  return [
    "You are the planning brain of a local orchestrator, mid-run. Earlier scopes",
    "have completed; below is a digest of what they produced and which success",
    "criteria remain UNMET. Propose ONLY the additional scopes/tasks needed to",
    "close the remaining gap — do not repeat already-completed work.",
    "You are in read-only plan mode: inspect the repository with Read/Glob/Grep",
    "to ground the plan, but do not edit anything or run commands.",
    "",
    `# Goal: ${goal.title}`,
    `Repository root: ${goal.repo_root}`,
    "",
    "## Objective",
    goal.objective,
    "",
    digest
      ? `## Completed so far (results)\n${digest}`
      : "## Completed so far\n(none)",
    "",
    unmet ? `## Unmet success criteria (close these)\n${unmet}` : "",
    "",
    "## Planning rules",
    "- Emit ONLY new scopes/tasks; the DAG already contains the completed ones.",
    "- Express dependencies only among the NEW scopes you emit here (by name);",
    "  the earlier scopes are already complete, so do not reference them.",
    "- Same safety discipline as a fresh plan: tightest `path_allowlist`, minimal",
    "  `allowed_tools`, correct `environment`, never request bypass.",
    "- If no further work is needed to meet the criteria, return an empty scopes",
    "  list.",
    "",
    "Return the plan as structured JSON matching the provided schema.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Extracts a {@link Plan} candidate from an SDK stream: prefers the result
 * message's `structured_output`, and falls back to parsing a fenced JSON block
 * out of the final text so the Planner still works if structured output is
 * unavailable on a given CLI build.
 */
function parsePlanCandidate(structured: unknown, finalText: string): unknown {
  if (structured && typeof structured === "object") return structured;
  const fenced = finalText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1]! : finalText;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new PlannerError("planner produced no parseable plan JSON");
  }
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch (err) {
    throw new PlannerError(
      `planner JSON did not parse: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/** The plan-only Opus session (§3). */
export class Planner {
  private readonly queryFn: PlanQueryFn;

  constructor(
    private readonly config: OrchestratorConfig,
    queryFn?: PlanQueryFn,
  ) {
    this.queryFn = queryFn ?? (sdkQuery as unknown as PlanQueryFn);
  }

  /**
   * Runs the plan-only session for a goal and returns a validated {@link Plan}.
   * Throws {@link PlannerError} if the session yields no valid plan.
   */
  async plan(goal: Goal): Promise<Plan> {
    return this.runSession(goal.repo_root, buildPlanPrompt(goal), false);
  }

  /**
   * Runs a re-plan cycle (autonomous-loop.md §3.3, G2): a plan-only session that
   * proposes *additional* scopes/tasks to close the unmet criteria, given a
   * digest of completed work. Same read-only, subscription-only session as
   * {@link plan}; returns a validated {@link Plan} (possibly with zero scopes,
   * which the controller treats as the no-progress signal).
   */
  async replan(goal: Goal, context: ReplanContext): Promise<Plan> {
    return this.runSession(
      goal.repo_root,
      buildReplanPrompt(goal, context),
      true,
    );
  }

  /**
   * Shared plan-only session runner (§3): pinned to Opus, read-only tools,
   * structured output, provider credentials stripped so planning stays on the
   * subscription (§2). Streams the session, extracts the plan candidate, and
   * validates it. When `allowEmpty` (re-plan only), a `{ scopes: [] }` result is
   * accepted as the "no further work" signal instead of failing validation
   * (which requires a non-empty scopes array for a fresh plan).
   */
  private async runSession(
    cwd: string,
    prompt: string,
    allowEmpty: boolean,
  ): Promise<Plan> {
    const options: Options = {
      cwd,
      model: this.config.planner.model,
      permissionMode: "plan",
      allowedTools: this.config.planner.allowed_tools,
      maxTurns: this.config.planner.max_turns,
      outputFormat: { type: "json_schema", schema: PLAN_JSON_SCHEMA },
      // Strip provider credentials so planning also stays on subscription (§2).
      env: buildSpawnEnv() as Record<string, string | undefined>,
    };

    const q = this.queryFn({ prompt, options });

    let structured: unknown;
    let finalText = "";
    for await (const message of q as AsyncIterable<SDKMessage>) {
      if (message.type === "assistant") {
        for (const block of (message.message?.content ?? []) as unknown[]) {
          const b = block as { type: string; text?: string };
          if (b.type === "text" && b.text) finalText += b.text;
        }
      } else if (message.type === "result") {
        if (message.subtype !== "success") {
          throw new PlannerError(`planner session failed: ${message.subtype}`);
        }
        structured = (message as { structured_output?: unknown })
          .structured_output;
        finalText = (message as { result?: string }).result ?? finalText;
      }
    }

    const candidate = parsePlanCandidate(structured, finalText);
    // Re-plan may legitimately conclude "nothing more to do" (autonomous-loop.md
    // §3.3): accept an explicit empty scopes list without tripping the
    // non-empty-scopes rule that a fresh plan requires.
    if (
      allowEmpty &&
      candidate &&
      typeof candidate === "object" &&
      Array.isArray((candidate as { scopes?: unknown }).scopes) &&
      (candidate as { scopes: unknown[] }).scopes.length === 0
    ) {
      return { scopes: [] };
    }
    const validation = validatePlan(candidate);
    if (!validation.ok) {
      throw new PlannerError(
        `planner produced an invalid plan: ${validation.errors.join("; ")}`,
      );
    }
    return validation.plan;
  }
}
