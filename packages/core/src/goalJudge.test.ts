import { describe, expect, it, vi } from "vitest";
import type { Options, Query } from "@anthropic-ai/claude-agent-sdk";
import type { AuditEvent } from "@orc-brain/shared";
import { SafetyLayer } from "./safety/index.js";
import type { AuditSink } from "./safety/index.js";
import { DEFAULT_CONFIG } from "./config.js";
import {
  GoalJudge,
  parseCommandCriterion,
  parseJudgeResults,
  type CommandRunner,
  type EvaluateInput,
} from "./goalJudge.js";

/** Audit sink that captures events for assertions. */
class CapturingAudit implements AuditSink {
  readonly events: AuditEvent[] = [];
  record(event: AuditEvent): void {
    this.events.push(event);
  }
}

/** A judge session whose result carries a `results` array in structured_output. */
function fakeJudgeQuery(results: { met: boolean; rationale: string }[]) {
  return (params: { prompt: string; options?: Options }) => {
    void params;
    async function* gen() {
      yield { type: "system", subtype: "init", session_id: "j", model: "opus" };
      yield {
        type: "result",
        subtype: "success",
        total_cost_usd: 0.01,
        num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1 },
        result: "judged",
        structured_output: { results },
      };
    }
    return Object.assign(gen(), {
      interrupt: async () => {},
    }) as unknown as Query;
  };
}

function baseInput(over: Partial<EvaluateInput> = {}): EvaluateInput {
  return {
    run_id: "r",
    goal_id: "g",
    title: "demo",
    objective: "ship it",
    cwd: "/repo",
    environment: "development",
    criteria: [],
    ...over,
  };
}

describe("parseCommandCriterion (Open Decision 2)", () => {
  it("parses `$ cmd`, backtick-wrapped, and rejects prose", () => {
    expect(parseCommandCriterion("$ pnpm test")).toBe("pnpm test");
    expect(parseCommandCriterion("`$ pnpm run build`")).toBe("pnpm run build");
    expect(parseCommandCriterion("  $ ls -la ")).toBe("ls -la");
    expect(parseCommandCriterion("the tests pass")).toBeNull();
    expect(parseCommandCriterion("costs $5 to run")).toBeNull();
  });
});

describe("GoalJudge — deterministic pass (autonomous-loop.md §3.4, G3)", () => {
  it("is satisfied when a `$` command exits 0 and the judge confirms prose", async () => {
    const audit = new CapturingAudit();
    const safety = new SafetyLayer(DEFAULT_CONFIG, audit);
    const runCommand: CommandRunner = () => ({ exitCode: 0 });
    const judge = new GoalJudge(DEFAULT_CONFIG, safety, audit, {
      runCommand,
      judgeQueryFn: fakeJudgeQuery([{ met: true, rationale: "looks done" }]),
    });

    const verdict = await judge.evaluate(
      baseInput({ criteria: ["$ pnpm test", "docs are updated"] }),
    );
    expect(verdict.satisfied).toBe(true);
    expect(verdict.unmet).toEqual([]);
  });

  it("AC4: a failing `$` command keeps the run unsatisfied even if the judge says met", async () => {
    const audit = new CapturingAudit();
    const safety = new SafetyLayer(DEFAULT_CONFIG, audit);
    const runCommand: CommandRunner = () => ({ exitCode: 1 }); // tests fail
    const judge = new GoalJudge(DEFAULT_CONFIG, safety, audit, {
      runCommand,
      judgeQueryFn: fakeJudgeQuery([{ met: true, rationale: "all good" }]),
    });

    const verdict = await judge.evaluate(
      baseInput({ criteria: ["$ pnpm test", "feature works"] }),
    );
    expect(verdict.satisfied).toBe(false);
    expect(verdict.unmet).toContain("$ pnpm test");
    // Judge's "met" for the prose criterion cannot rescue the failed command.
    expect(verdict.unmet).not.toContain("feature works");
  });

  it("marks a prose criterion unmet when the judge does not confirm it", async () => {
    const audit = new CapturingAudit();
    const safety = new SafetyLayer(DEFAULT_CONFIG, audit);
    const judge = new GoalJudge(DEFAULT_CONFIG, safety, audit, {
      runCommand: () => ({ exitCode: 0 }),
      judgeQueryFn: fakeJudgeQuery([
        { met: false, rationale: "no tests found" },
      ]),
    });
    const verdict = await judge.evaluate(
      baseInput({ criteria: ["comprehensive tests exist"] }),
    );
    expect(verdict.satisfied).toBe(false);
    expect(verdict.unmet).toEqual(["comprehensive tests exist"]);
  });

  it("AC5: a destructive `$` command in a production scope is denied + audited, never executed", async () => {
    const audit = new CapturingAudit();
    const safety = new SafetyLayer(DEFAULT_CONFIG, audit);
    const runCommand = vi.fn<CommandRunner>(() => ({ exitCode: 0 }));
    const judge = new GoalJudge(DEFAULT_CONFIG, safety, audit, { runCommand });

    const verdict = await judge.evaluate(
      baseInput({
        environment: "production",
        criteria: ["`$ rm -rf /`"],
      }),
    );

    // Never executed.
    expect(runCommand).not.toHaveBeenCalled();
    // Unmet + audited as a block.
    expect(verdict.satisfied).toBe(false);
    expect(verdict.unmet).toEqual(["`$ rm -rf /`"]);
    const blocked = audit.events.find((e) => e.kind === "hook_block");
    expect(blocked).toBeDefined();
    expect(blocked?.decision).toBe("deny");
    expect((blocked?.detail as { source: string }).source).toBe(
      "goal_judge_criterion",
    );
  });
});

describe("parseJudgeResults", () => {
  it("reads structured results and falls back to fenced JSON", () => {
    expect(
      parseJudgeResults({ results: [{ met: true, rationale: "ok" }] }, ""),
    ).toEqual([{ met: true, rationale: "ok" }]);
    const fenced =
      "here:\n```json\n" +
      JSON.stringify({ results: [{ met: false, rationale: "nope" }] }) +
      "\n```";
    expect(parseJudgeResults(undefined, fenced)).toEqual([
      { met: false, rationale: "nope" },
    ]);
    expect(parseJudgeResults(undefined, "no json here")).toEqual([]);
  });
});
