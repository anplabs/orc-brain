import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type { OrchestratorConfig, Plan } from "@orc-brain/shared";
import { createSystem, type CreateSystemOptions } from "./system.js";
import { DEFAULT_CONFIG } from "./config.js";

/** A worker stream: init → tool_use + text → success result. */
function fakeWorkerQuery() {
  const messages = [
    { type: "system", subtype: "init", session_id: "w", model: "haiku" },
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "Bash",
            input: { command: "echo hi" },
          },
          { type: "text", text: "done" },
        ],
      },
    },
    {
      type: "result",
      subtype: "success",
      total_cost_usd: 0.01,
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 5 },
      result: "completed",
    },
  ];
  async function* gen() {
    for (const m of messages) yield m;
  }
  return Object.assign(gen(), {
    interrupt: async () => {},
  }) as unknown as Query;
}

/** A planner/judge stream whose result carries `structured_output`. */
function structuredQuery(output: unknown) {
  async function* gen() {
    yield { type: "system", subtype: "init", session_id: "p", model: "opus" };
    yield {
      type: "result",
      subtype: "success",
      total_cost_usd: 0.01,
      num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
      result: "ok",
      structured_output: output,
    };
  }
  return Object.assign(gen(), {
    interrupt: async () => {},
  }) as unknown as Query;
}

/** A one-scope, one-task re-plan result (development scope, benign task). */
function replanPlan(name: string): Plan {
  return {
    scopes: [
      {
        name,
        description: "more work",
        path_allowlist: ["**"],
        allowed_tools: ["Bash"],
        model_tier: "auto",
        environment: "development",
        permission_mode: "default",
        max_budget_usd: 5,
        tasks: [
          { title: `${name}-t`, prompt: "do it", task_type: "mechanical" },
        ],
      },
    ],
  };
}

function autoConfig(
  over: Partial<OrchestratorConfig["autoLoop"]>,
): OrchestratorConfig {
  return {
    ...DEFAULT_CONFIG,
    autoLoop: {
      enabled: true,
      mode: "unattended",
      replan_on: "scope",
      max_replan_cycles: 5,
      ...over,
    },
  };
}

function buildAuto(opts: CreateSystemOptions) {
  const stateDir = mkdtempSync(join(tmpdir(), "orc-auto-"));
  return createSystem({ stateDir, ...opts });
}

function seedGoal(sys: ReturnType<typeof buildAuto>, repoRoot: string) {
  const goal = sys.orchestrator.createGoal({
    title: "auto demo",
    objective: "build the thing",
    success_criteria: [{ description: "feature complete" }],
    constraints: [],
    out_of_scope: [],
    repo_root: repoRoot,
  });
  const scope = sys.orchestrator.createScope({
    goal_id: goal.id,
    name: "seed",
    description: "",
    path_allowlist: [join(repoRoot, "**")],
    path_denylist: [],
    allowed_tools: ["Bash"],
    disallowed_tools: [],
    model_tier: "auto",
    environment: "development",
    permission_mode: "default",
    forbidden_actions: [],
    success_criteria: [],
    max_budget_usd: 5,
    depends_on: [],
  });
  sys.orchestrator.approveScope(scope.id);
  sys.orchestrator.createTask({
    scope_id: scope.id,
    title: "seed-t",
    prompt: "start",
    task_type: "mechanical",
    depends_on: [],
  });
  return goal;
}

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("AutoLoop — control loop (autonomous-loop.md §3.1)", () => {
  it("AC1: with autoLoop disabled, a run finishes on DAG exhaustion and never calls the judge", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "orc-repo-"));
    const judgeQueryFn = vi.fn(() => structuredQuery({ results: [] }));
    const sys = buildAuto({
      config: DEFAULT_CONFIG, // enabled: false
      queryFn: () => fakeWorkerQuery(),
      judgeQueryFn,
    });
    const goal = seedGoal(sys, repoRoot);
    const run = sys.orchestrator.startRun(goal.id, { budget_usd: 10 });

    await waitFor(() => sys.store.getRun(run.id)?.state === "done");
    expect(judgeQueryFn).not.toHaveBeenCalled(); // no goal-satisfaction path
    sys.close();
  });

  it("AC2: re-plans one cycle (appends a task), then finishes done when criteria are met", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "orc-repo-"));
    let judgeCalls = 0;
    const sys = buildAuto({
      config: autoConfig({ mode: "unattended" }),
      queryFn: () => fakeWorkerQuery(),
      // First evaluation: unmet → triggers a re-plan. Second: satisfied → done.
      judgeQueryFn: () => {
        judgeCalls += 1;
        const met = judgeCalls >= 2;
        return structuredQuery({
          results: [{ met, rationale: met ? "ok" : "not yet" }],
        });
      },
      // The re-plan proposes one new scope+task.
      planQueryFn: () => structuredQuery(replanPlan("cycle1")),
    });
    const goal = seedGoal(sys, repoRoot);
    const run = sys.orchestrator.startRun(goal.id, { budget_usd: 10 });

    await waitFor(() => sys.store.getRun(run.id)?.state === "done");

    // One re-plan cycle ran and appended the new scope's task.
    expect(sys.store.getRun(run.id)?.replan_cycle).toBe(1);
    const scopeNames = sys.store.listScopesByGoal(goal.id).map((s) => s.name);
    expect(scopeNames).toContain("cycle1");
    expect(sys.store.listTasksByGoal(goal.id)).toHaveLength(2);
    expect(judgeCalls).toBe(2);
    sys.close();
  });

  it("AC6: the max_replan_cycles guard pauses the run", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "orc-repo-"));
    let n = 0;
    const sys = buildAuto({
      config: autoConfig({ max_replan_cycles: 2 }),
      queryFn: () => fakeWorkerQuery(),
      judgeQueryFn: () =>
        structuredQuery({ results: [{ met: false, rationale: "never" }] }),
      planQueryFn: () => structuredQuery(replanPlan(`c${n++}`)),
    });
    const goal = seedGoal(sys, repoRoot);
    const run = sys.orchestrator.startRun(goal.id, { budget_usd: 10 });

    await waitFor(
      () =>
        sys.store.getRun(run.id)?.state === "paused" &&
        sys.store.getRun(run.id)?.pause_reason === "cycle_cap",
    );
    expect(sys.store.getRun(run.id)?.replan_cycle).toBe(2);
    sys.close();
  });

  it("AC6: the no-progress guard pauses the run when a cycle adds no tasks", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "orc-repo-"));
    const sys = buildAuto({
      config: autoConfig({ max_replan_cycles: 5 }),
      queryFn: () => fakeWorkerQuery(),
      judgeQueryFn: () =>
        structuredQuery({ results: [{ met: false, rationale: "never" }] }),
      // Re-plan proposes nothing new → no progress.
      planQueryFn: () => structuredQuery({ scopes: [] }),
    });
    const goal = seedGoal(sys, repoRoot);
    const run = sys.orchestrator.startRun(goal.id, { budget_usd: 10 });

    await waitFor(
      () =>
        sys.store.getRun(run.id)?.state === "paused" &&
        sys.store.getRun(run.id)?.pause_reason === "no_progress",
    );
    expect(sys.store.getRun(run.id)?.replan_cycle).toBe(0); // never advanced
    sys.close();
  });

  it("supervised mode pauses for approval instead of auto-approving re-planned scopes", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "orc-repo-"));
    const sys = buildAuto({
      config: autoConfig({ mode: "supervised" }),
      queryFn: () => fakeWorkerQuery(),
      judgeQueryFn: () =>
        structuredQuery({ results: [{ met: false, rationale: "no" }] }),
      planQueryFn: () => structuredQuery(replanPlan("needs-approval")),
    });
    const goal = seedGoal(sys, repoRoot);
    const run = sys.orchestrator.startRun(goal.id, { budget_usd: 10 });

    await waitFor(
      () =>
        sys.store.getRun(run.id)?.state === "paused" &&
        sys.store.getRun(run.id)?.pause_reason === "awaiting_replan_approval",
    );
    // The new scope exists but is still proposed (awaiting the operator).
    const added = sys.store
      .listScopesByGoal(goal.id)
      .find((s) => s.name === "needs-approval");
    expect(added?.status).toBe("proposed");
    sys.close();
  });
});
