import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Options, Query } from "@anthropic-ai/claude-agent-sdk";
import type { Plan } from "@orc-brain/shared";
import { Store } from "./store/index.js";
import { NullAuditLog } from "./store/auditLog.js";
import { EventBus } from "./eventBus.js";
import { SafetyLayer } from "./safety/index.js";
import { BudgetTracker } from "./budgetTracker.js";
import { WorkerManager } from "./workerManager.js";
import { Planner, buildPlanPrompt, buildReplanPrompt } from "./planner.js";
import { EscalationManager } from "./escalation.js";
import { ReportingEngine } from "./reporting.js";
import { Backpressure } from "./backpressure.js";
import { Orchestrator } from "./orchestrator.js";
import { WorktreeManager } from "./worktrees.js";
import { DEFAULT_CONFIG } from "./config.js";

const SAMPLE_PLAN: Plan = {
  scopes: [
    {
      name: "core",
      description: "core work",
      path_allowlist: ["src/**"],
      allowed_tools: ["Read", "Edit"],
      model_tier: "auto",
      environment: "development",
      permission_mode: "default",
      max_budget_usd: 3,
      tasks: [
        { title: "scaffold", prompt: "scaffold it", task_type: "codegen" },
        {
          title: "test",
          prompt: "test it",
          task_type: "test",
          depends_on: ["scaffold"],
        },
      ],
    },
    {
      name: "docs",
      description: "documentation",
      path_allowlist: ["docs/**"],
      allowed_tools: ["Read", "Edit"],
      model_tier: "haiku",
      environment: "development",
      permission_mode: "default",
      max_budget_usd: 1,
      depends_on: ["core"],
      tasks: [
        { title: "write", prompt: "write docs", task_type: "mechanical" },
      ],
    },
  ],
};

/** A plan-only stream whose result carries `structured_output`. */
function fakePlanQuery(plan: unknown, capture?: (o: Options) => void) {
  return (params: { prompt: string; options?: Options }) => {
    if (capture && params.options) capture(params.options);
    async function* gen() {
      yield {
        type: "system",
        subtype: "init",
        session_id: "plan-1",
        model: "opus",
      };
      yield {
        type: "result",
        subtype: "success",
        total_cost_usd: 0.04,
        num_turns: 3,
        usage: { input_tokens: 200, output_tokens: 100 },
        result: "here is the plan",
        structured_output: plan,
      };
    }
    return Object.assign(gen(), {
      interrupt: async () => {},
    }) as unknown as Query;
  };
}

function buildSystem(
  repoRoot: string,
  planQueryFn: ReturnType<typeof fakePlanQuery>,
) {
  const store = new Store(":memory:");
  const audit = new NullAuditLog();
  const bus = new EventBus(store);
  const safety = new SafetyLayer(DEFAULT_CONFIG, audit);
  const budget = new BudgetTracker(store, bus, DEFAULT_CONFIG.budget);
  const workers = new WorkerManager(safety, bus, store, budget, () => {
    throw new Error("workers must not spawn during planning");
  });
  const planner = new Planner(DEFAULT_CONFIG, planQueryFn);
  const orchestrator = new Orchestrator({
    store,
    bus,
    config: DEFAULT_CONFIG,
    safety,
    workers,
    budget,
    audit,
    planner,
    escalation: new EscalationManager(store, bus, DEFAULT_CONFIG),
    reporting: new ReportingEngine(
      store,
      bus,
      DEFAULT_CONFIG,
      mkdtempSync(join(tmpdir(), "orc-reports-")),
    ),
    backpressure: new Backpressure(bus, DEFAULT_CONFIG.limits),
    worktrees: new WorktreeManager(mkdtempSync(join(tmpdir(), "orc-wt-"))),
  });
  return { store, orchestrator, planner };
}

function makeGoal(sys: ReturnType<typeof buildSystem>, repoRoot: string) {
  return sys.orchestrator.createGoal({
    title: "migrate auth",
    objective: "swap the auth provider",
    success_criteria: [{ description: "tests pass" }],
    constraints: ["no prod writes"],
    out_of_scope: ["billing"],
    repo_root: repoRoot,
  });
}

describe("Planner (§3)", () => {
  it("runs a plan-only Opus session with read-only tools", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "orc-plan-"));
    let opts: Options | undefined;
    const sys = buildSystem(
      repoRoot,
      fakePlanQuery(SAMPLE_PLAN, (o) => (opts = o)),
    );
    const goal = makeGoal(sys, repoRoot);

    const plan = await sys.planner.plan(goal);
    expect(plan.scopes).toHaveLength(2);

    // Pinned to Opus, plan mode, read-only tools, credentials stripped (§2, §3).
    expect(opts?.model).toBe("opus");
    expect(opts?.permissionMode).toBe("plan");
    expect(opts?.allowedTools).toEqual(["Read", "Glob", "Grep"]);
    expect(opts?.outputFormat).toEqual({
      type: "json_schema",
      schema: expect.any(Object),
    });
    expect(opts?.env?.ANTHROPIC_API_KEY).toBeUndefined();
    sys.store.close();
  });

  it("falls back to parsing a fenced JSON block when structured_output is absent", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "orc-plan-"));
    const fencedQuery = (params: { prompt: string; options?: Options }) => {
      async function* gen() {
        yield {
          type: "system",
          subtype: "init",
          session_id: "p",
          model: "opus",
        };
        yield {
          type: "result",
          subtype: "success",
          total_cost_usd: 0.01,
          num_turns: 1,
          usage: { input_tokens: 1, output_tokens: 1 },
          result: "Here:\n```json\n" + JSON.stringify(SAMPLE_PLAN) + "\n```\n",
        };
      }
      void params;
      return Object.assign(gen(), {
        interrupt: async () => {},
      }) as unknown as Query;
    };
    const sys = buildSystem(repoRoot, fencedQuery);
    const goal = makeGoal(sys, repoRoot);
    const plan = await sys.planner.plan(goal);
    expect(plan.scopes.map((s) => s.name)).toEqual(["core", "docs"]);
    sys.store.close();
  });

  it("rejects an invalid plan", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "orc-plan-"));
    const bad = { scopes: [{ name: "x", tasks: [] }] };
    const sys = buildSystem(repoRoot, fakePlanQuery(bad));
    const goal = makeGoal(sys, repoRoot);
    await expect(sys.planner.plan(goal)).rejects.toThrow(/invalid plan/);
    sys.store.close();
  });

  it("includes goal context in the plan prompt", () => {
    const repoRoot = "/tmp/x";
    const sys = buildSystem(repoRoot, fakePlanQuery(SAMPLE_PLAN));
    const goal = makeGoal(sys, repoRoot);
    const prompt = buildPlanPrompt(goal);
    expect(prompt).toContain("migrate auth");
    expect(prompt).toContain("swap the auth provider");
    expect(prompt).toContain("no prod writes");
    sys.store.close();
  });
});

describe("Orchestrator.planGoal — materialization (§3)", () => {
  it("materializes scopes/tasks and resolves name-based dependencies", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "orc-plan-"));
    const sys = buildSystem(repoRoot, fakePlanQuery(SAMPLE_PLAN));
    const goal = makeGoal(sys, repoRoot);

    const { scopes, tasks } = await sys.orchestrator.planGoal(goal.id);
    expect(scopes).toHaveLength(2);
    expect(tasks).toHaveLength(3);

    // Scopes land proposed; goal awaits approval.
    expect(scopes.every((s) => s.status === "proposed")).toBe(true);
    expect(sys.store.getGoal(goal.id)?.status).toBe("awaiting_approval");

    // Scope-level edge: docs depends_on core (resolved to a ULID).
    const core = scopes.find((s) => s.name === "core")!;
    const docs = sys.store.getScope(scopes.find((s) => s.name === "docs")!.id)!;
    expect(docs.depends_on).toEqual([core.id]);

    // Task-level edge: "test" depends_on "scaffold" within the core scope.
    const coreTasks = sys.store.listTasksByScope(core.id);
    const scaffold = coreTasks.find((t) => t.title === "scaffold")!;
    const test = coreTasks.find((t) => t.title === "test")!;
    expect(test.depends_on).toEqual([scaffold.id]);
    expect(scaffold.depends_on).toEqual([]);

    // approveGoal flips every proposed scope to approved and activates the goal.
    const approved = sys.orchestrator.approveGoal(goal.id);
    expect(approved).toHaveLength(2);
    expect(sys.store.getScope(core.id)?.status).toBe("approved");
    expect(sys.store.getGoal(goal.id)?.status).toBe("active");
    sys.store.close();
  });
});

/**
 * A re-plan result: one NEW self-contained scope. Per the replan contract, its
 * `depends_on` references only sibling new scopes (here, none) — earlier scopes
 * are already complete. Validatable by the Planner.
 */
const REPLAN_PLAN: Plan = {
  scopes: [
    {
      name: "hardening",
      description: "close the remaining gap",
      path_allowlist: ["src/**"],
      allowed_tools: ["Read", "Edit"],
      model_tier: "auto",
      environment: "development",
      permission_mode: "default",
      max_budget_usd: 2,
      tasks: [{ title: "harden", prompt: "harden it", task_type: "codegen" }],
    },
  ],
};

describe("Planner.replan (autonomous-loop.md §3.3, G2)", () => {
  it("builds a replan prompt from completed digest + unmet criteria", () => {
    const goal = {
      title: "migrate auth",
      objective: "swap the auth provider",
      repo_root: "/tmp/x",
    } as never;
    const prompt = buildReplanPrompt(goal, {
      completedDigest: ["core/scaffold: created module skeleton"],
      unmetCriteria: ["integration tests pass"],
    });
    expect(prompt).toContain("mid-run");
    expect(prompt).toContain("created module skeleton");
    expect(prompt).toContain("integration tests pass");
    expect(prompt).toContain("ONLY the additional");
  });

  it("returns a validated additional-scopes plan", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "orc-plan-"));
    const sys = buildSystem(repoRoot, fakePlanQuery(REPLAN_PLAN));
    const goal = makeGoal(sys, repoRoot);
    const plan = await sys.planner.replan(goal, {
      completedDigest: ["core done"],
      unmetCriteria: ["not yet hardened"],
    });
    expect(plan.scopes.map((s) => s.name)).toEqual(["hardening"]);
    sys.store.close();
  });

  it("accepts an empty scopes result as the no-progress signal", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "orc-plan-"));
    const sys = buildSystem(repoRoot, fakePlanQuery({ scopes: [] }));
    const goal = makeGoal(sys, repoRoot);
    const plan = await sys.planner.replan(goal, {
      completedDigest: [],
      unmetCriteria: [],
    });
    expect(plan.scopes).toHaveLength(0); // would throw on a fresh plan()
    sys.store.close();
  });
});

describe("Orchestrator.applyReplan — additive materialization (autonomous-loop.md §3.3)", () => {
  it("appends new scopes/tasks without deleting existing ones, resolving deps to a pre-existing scope", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "orc-plan-"));
    const sys = buildSystem(repoRoot, fakePlanQuery(SAMPLE_PLAN));
    const goal = makeGoal(sys, repoRoot);

    // Seed the DAG with the initial plan (core + docs, 3 tasks).
    await sys.orchestrator.planGoal(goal.id);
    const core = sys.store
      .listScopesByGoal(goal.id)
      .find((s) => s.name === "core")!;

    // Apply a re-plan additively. This plan's new scope depends_on the
    // pre-existing "core" scope — applyReplan takes an already-validated Plan,
    // so cross-plan resolution (not the planner's within-plan validator) is what
    // wires the edge.
    const replan: Plan = {
      scopes: [
        {
          ...REPLAN_PLAN.scopes[0]!,
          depends_on: ["core"], // pre-existing scope, resolved by appendPlan
        },
      ],
    };
    const { scopes, tasks } = sys.orchestrator.applyReplan(goal.id, replan);
    expect(scopes.map((s) => s.name)).toEqual(["hardening"]);
    expect(tasks).toHaveLength(1);

    // Existing scopes/tasks are untouched: 3 scopes total now, 4 tasks total.
    expect(sys.store.listScopesByGoal(goal.id)).toHaveLength(3);
    expect(sys.store.listTasksByGoal(goal.id)).toHaveLength(4);

    // The new scope's depends_on resolved to the pre-existing "core" scope id.
    const hardening = sys.store
      .listScopesByGoal(goal.id)
      .find((s) => s.name === "hardening")!;
    expect(hardening.depends_on).toEqual([core.id]);
    sys.store.close();
  });
});
