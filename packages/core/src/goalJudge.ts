/**
 * Hybrid goal-satisfaction evaluator (.specs/active/autonomous-loop.md §3.4, G3;
 * spec §4 success_criteria). Decides whether a run's success criteria are met so
 * the autonomous controller can finish (or trigger another re-plan cycle),
 * replacing the DAG-exhaustion-only check in `Orchestrator.maybeFinish`.
 *
 * Two passes:
 *   1. Deterministic — criteria written as `` `$ <cmd>` `` are shell checks. Each
 *      is routed through the SAME {@link SafetyLayer} as a worker (Golden Rule 2,
 *      R3): a denied command is NEVER executed — it is recorded as unmet and
 *      audited. An allowed command runs; exit 0 = met.
 *   2. Judge — remaining prose criteria go to an Opus plan-mode (read-only)
 *      session that inspects the repo and returns met/unmet + rationale.
 *
 * Deterministic failures are authoritative: the judge can never flip a failing
 * command check to satisfied (AC4).
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  Environment,
  OrchestratorConfig,
  AuditEvent,
} from "@orc-brain/shared";
import { SafetyLayer } from "./safety/index.js";
import type { AuditSink, ScopeSafetyContext } from "./safety/index.js";
import type { DenyDecision } from "./safety/denyRules.js";
import { redactValue } from "./safety/redact.js";
import { buildSpawnEnv } from "./spawnEnv.js";
import type { PlanQueryFn } from "./planner.js";

/** Runs a shell command in `cwd`; returns its exit code (non-zero on failure). */
export type CommandRunner = (
  command: string,
  cwd: string,
) => { exitCode: number };

/** The evaluator's verdict for a run's criteria. */
export interface GoalVerdict {
  satisfied: boolean;
  /** Descriptions of the criteria still unmet (empty when satisfied). */
  unmet: string[];
  /** Human-readable explanation, joined across criteria. */
  rationale: string;
}

/** Inputs for one evaluation pass over a goal's aggregated criteria. */
export interface EvaluateInput {
  run_id: string | null;
  goal_id: string;
  title: string;
  objective: string;
  cwd: string;
  environment: Environment;
  /** Aggregated success-criteria descriptions (goal + verified scopes). */
  criteria: string[];
}

/** A per-criterion judge result. */
interface JudgeResult {
  met: boolean;
  rationale: string;
}

/**
 * Parses an executable criterion (Open Decision 2): a description of the form
 * `` `$ <cmd>` `` or `$ <cmd>` marks a deterministic shell check. Returns the
 * command, or null when the criterion is prose for the judge.
 */
export function parseCommandCriterion(description: string): string | null {
  const m = description.trim().match(/^`?\s*\$\s+([\s\S]+?)\s*`?$/);
  return m ? m[1]!.trim() : null;
}

/** Builds the judge prompt for prose criteria (read-only, plan-mode session). */
export function buildJudgePrompt(
  title: string,
  objective: string,
  criteria: string[],
): string {
  const list = criteria.map((c, i) => `${i}. ${c}`).join("\n");
  return [
    "You are the acceptance judge of a local orchestrator. Decide, for each",
    "success criterion below, whether it is MET by the CURRENT state of the",
    "repository. You are in read-only mode: inspect with Read/Glob/Grep; do not",
    "edit anything or run commands. Be strict — if you cannot verify a criterion,",
    "mark it not met.",
    "",
    `# Goal: ${title}`,
    "## Objective",
    objective,
    "",
    "## Criteria (index. text)",
    list,
    "",
    "Return JSON matching the schema: an object with a `results` array holding,",
    "for each criterion index in order, `{ met: boolean, rationale: string }`.",
  ].join("\n");
}

/** JSON schema for the judge's structured output (hand-written, no validator dep). */
const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          met: { type: "boolean" },
          rationale: { type: "string" },
        },
        required: ["met", "rationale"],
      },
    },
  },
  required: ["results"],
} as const;

/** Default runner: real shell via spawnSync, output discarded, 2-min ceiling. */
const defaultRunCommand: CommandRunner = (command, cwd) => {
  const res = spawnSync(command, {
    cwd,
    shell: true,
    stdio: "ignore",
    timeout: 120_000,
  });
  return { exitCode: res.status ?? 1 };
};

/** The hybrid evaluator (autonomous-loop.md §3.4). */
export class GoalJudge {
  private readonly runCommand: CommandRunner;
  private readonly judgeQueryFn?: PlanQueryFn;

  constructor(
    private readonly config: OrchestratorConfig,
    private readonly safety: SafetyLayer,
    private readonly audit: AuditSink,
    opts: { runCommand?: CommandRunner; judgeQueryFn?: PlanQueryFn } = {},
  ) {
    this.runCommand = opts.runCommand ?? defaultRunCommand;
    this.judgeQueryFn = opts.judgeQueryFn;
  }

  /**
   * Evaluates a run's criteria (autonomous-loop.md §3.4). Deterministic command
   * checks run first through the safety layer; remaining prose criteria go to
   * the judge. `satisfied` is true only when EVERY criterion is met.
   */
  async evaluate(input: EvaluateInput): Promise<GoalVerdict> {
    const ctx: ScopeSafetyContext = {
      run_id: input.run_id,
      task_id: null,
      environment: input.environment,
      cwd: input.cwd,
      path_allowlist: [join(input.cwd, "**")],
      path_denylist: [],
    };
    const unmet: string[] = [];
    const notes: string[] = [];
    const prose: string[] = [];

    // Pass 1 — deterministic, safety-gated shell checks (R3).
    for (const desc of input.criteria) {
      const command = parseCommandCriterion(desc);
      if (command === null) {
        prose.push(desc);
        continue;
      }
      const decision = this.safety.evaluateToolCall("Bash", { command }, ctx);
      if (
        decision.verdict === "deny" ||
        decision.verdict === "require_approval"
      ) {
        // Blocked commands are NEVER executed (Golden Rule 2/3) — audited + unmet.
        this.auditDenied(ctx, command, decision);
        unmet.push(desc);
        notes.push(
          `"${desc}" blocked by safety rule ` +
            `${decision.match?.rule_id ?? "policy"} — not executed`,
        );
        continue;
      }
      const { exitCode } = this.runCommand(command, input.cwd);
      if (exitCode !== 0) {
        unmet.push(desc);
        notes.push(`"${desc}" exited ${exitCode}`);
      }
    }

    // Pass 2 — judge the prose criteria (only if any and a session is available).
    if (prose.length > 0) {
      const results = await this.judgeProse(input, prose);
      prose.forEach((desc, i) => {
        const r = results[i];
        if (!r || !r.met) {
          unmet.push(desc);
          notes.push(`"${desc}": ${r?.rationale ?? "judge did not confirm"}`);
        }
      });
    }

    return {
      satisfied: unmet.length === 0,
      unmet,
      rationale: notes.join("; ") || "all criteria met",
    };
  }

  /** Records a blocked criterion command in the audit log (§8.6, AC5). */
  private auditDenied(
    ctx: ScopeSafetyContext,
    command: string,
    decision: DenyDecision,
  ): void {
    const event: AuditEvent = {
      ts: new Date().toISOString(),
      run_id: ctx.run_id,
      task_id: ctx.task_id,
      session_id: null,
      kind: "hook_block",
      tool_name: "Bash",
      tool_input_hash: null,
      tool_input: redactValue({ command }),
      decision: "deny",
      rule_id: decision.match?.rule_id ?? "policy",
      detail: {
        source: "goal_judge_criterion",
        reason: decision.match?.reason ?? "policy",
      },
    };
    this.audit.record(event);
  }

  /**
   * Runs the read-only judge session over prose criteria and returns one result
   * per criterion (in order). If no judge session is wired, or the session
   * yields nothing usable, every prose criterion defaults to NOT met (strict).
   */
  private async judgeProse(
    input: EvaluateInput,
    criteria: string[],
  ): Promise<JudgeResult[]> {
    if (!this.judgeQueryFn)
      return criteria.map(() => notMet("no judge session"));

    const options: Options = {
      cwd: input.cwd,
      model: this.config.planner.model,
      permissionMode: "plan",
      allowedTools: this.config.planner.allowed_tools,
      maxTurns: this.config.planner.max_turns,
      outputFormat: { type: "json_schema", schema: JUDGE_SCHEMA },
      env: buildSpawnEnv() as Record<string, string | undefined>,
    };
    const prompt = buildJudgePrompt(input.title, input.objective, criteria);
    const q = this.judgeQueryFn({ prompt, options });

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
          return criteria.map(() => notMet(`judge session failed`));
        }
        structured = (message as { structured_output?: unknown })
          .structured_output;
        finalText = (message as { result?: string }).result ?? finalText;
      }
    }

    const parsed = parseJudgeResults(structured, finalText);
    // Missing entries default to not met (strict): align by index.
    return criteria.map(
      (_, i) => parsed[i] ?? notMet("judge omitted this criterion"),
    );
  }
}

function notMet(rationale: string): JudgeResult {
  return { met: false, rationale };
}

/**
 * Extracts judge results from an SDK stream: prefers `structured_output.results`,
 * falls back to a fenced/loose JSON object with a `results` array. Defensive
 * (no validation library): anything unparseable yields an empty array so callers
 * treat all criteria as not met.
 */
export function parseJudgeResults(
  structured: unknown,
  finalText: string,
): JudgeResult[] {
  const fromObj = (obj: unknown): JudgeResult[] => {
    const results = (obj as { results?: unknown } | null)?.results;
    if (!Array.isArray(results)) return [];
    return results.map((r) => ({
      met: (r as { met?: unknown })?.met === true,
      rationale:
        typeof (r as { rationale?: unknown })?.rationale === "string"
          ? (r as { rationale: string }).rationale
          : "",
    }));
  };

  if (structured && typeof structured === "object") {
    const r = fromObj(structured);
    if (r.length) return r;
  }
  const fenced = finalText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1]! : finalText;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return [];
  try {
    return fromObj(JSON.parse(raw.slice(start, end + 1)));
  } catch {
    return [];
  }
}
