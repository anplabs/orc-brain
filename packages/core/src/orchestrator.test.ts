import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Options, Query } from "@anthropic-ai/claude-agent-sdk";
import { Store } from "./store/index.js";
import { NullAuditLog } from "./store/auditLog.js";
import { EventBus } from "./eventBus.js";
import { SafetyLayer } from "./safety/index.js";
import { BudgetTracker } from "./budgetTracker.js";
import { WorkerManager } from "./workerManager.js";
import { Planner } from "./planner.js";
import { EscalationManager } from "./escalation.js";
import { ReportingEngine } from "./reporting.js";
import { Backpressure } from "./backpressure.js";
import { Orchestrator } from "./orchestrator.js";
import { WorktreeManager } from "./worktrees.js";
import { DEFAULT_CONFIG } from "./config.js";
import type { BusEvent } from "@orc-brain/shared";

/** A fake SDK query stream: init → assistant(tool_use + text) → result. */
function fakeQuery(cost: number) {
  const messages = [
    { type: "system", subtype: "init", session_id: "sess-123", model: "haiku" },
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
          { type: "text", text: "all done" },
        ],
      },
    },
    {
      type: "result",
      subtype: "success",
      total_cost_usd: cost,
      num_turns: 2,
      usage: { input_tokens: 100, output_tokens: 50 },
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

function buildSystem(
  repoRoot: string,
  opts: {
    capture?: (o: Options) => void;
    queryFn?: (p: { prompt: string; options?: Options }) => Query;
  } = {},
) {
  const store = new Store(":memory:");
  const audit = new NullAuditLog();
  const bus = new EventBus(store);
  const safety = new SafetyLayer(DEFAULT_CONFIG, audit);
  const budget = new BudgetTracker(store, bus, DEFAULT_CONFIG.budget);
  const queryFn =
    opts.queryFn ??
    ((params: { prompt: string; options?: Options }) => {
      if (opts.capture && params.options) opts.capture(params.options);
      return fakeQuery(0.02);
    });
  const escalation = new EscalationManager(store, bus, DEFAULT_CONFIG);
  const workers = new WorkerManager(safety, bus, store, budget, queryFn);
  const planner = new Planner(DEFAULT_CONFIG);
  const reporting = new ReportingEngine(
    store,
    bus,
    DEFAULT_CONFIG,
    mkdtempSync(join(tmpdir(), "orc-reports-")),
  );
  const backpressure = new Backpressure(bus, DEFAULT_CONFIG.limits);
  const orchestrator = new Orchestrator({
    store,
    bus,
    config: DEFAULT_CONFIG,
    safety,
    workers,
    budget,
    audit,
    planner,
    escalation,
    reporting,
    backpressure,
    worktrees: new WorktreeManager(mkdtempSync(join(tmpdir(), "orc-wt-"))),
  });
  const events: BusEvent[] = [];
  bus.subscribe((e) => events.push(e));
  return {
    store,
    bus,
    safety,
    budget,
    workers,
    orchestrator,
    escalation,
    reporting,
    backpressure,
    audit,
    events,
  };
}

async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("Orchestrator — benign task end-to-end (Phase-1 exit test)", () => {
  it("dispatches, runs, records cost, and finishes the run", async () => {
    // Non-git temp dir so the env classifier stays 'development'.
    const repoRoot = mkdtempSync(join(tmpdir(), "orc-test-"));
    let capturedOptions: Options | undefined;
    const sys = buildSystem(repoRoot, {
      capture: (o) => (capturedOptions = o),
    });

    const goal = sys.orchestrator.createGoal({
      title: "demo",
      objective: "run one benign task",
      success_criteria: [],
      constraints: [],
      out_of_scope: [],
      repo_root: repoRoot,
    });
    const scope = sys.orchestrator.createScope({
      goal_id: goal.id,
      name: "s",
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
    const task = sys.orchestrator.createTask({
      scope_id: scope.id,
      title: "echo",
      prompt: "echo hi",
      task_type: "mechanical",
      depends_on: [],
    });

    const run = sys.orchestrator.startRun(goal.id, { budget_usd: 10 });

    await waitFor(() => sys.store.getTask(task.id)?.status === "done");
    await waitFor(() => sys.store.getRun(run.id)?.state === "done");

    const finalTask = sys.store.getTask(task.id)!;
    expect(finalTask.status).toBe("done");
    expect(finalTask.session_id).toBe("sess-123");
    expect(finalTask.model_used).toBe("haiku"); // R4 mechanical → haiku

    // Cost appears in the ledger / run (exit test: "cost appears in orc status").
    expect(sys.store.sumCostForRun(run.id)).toBeCloseTo(0.02);
    expect(sys.store.getRun(run.id)?.budget_spent_usd).toBeCloseTo(0.02);

    // The worker was launched with credentials stripped and safety wired (§2, §8).
    expect(capturedOptions?.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(capturedOptions?.hooks?.PreToolUse).toBeDefined();
    expect(capturedOptions?.canUseTool).toBeDefined();
    expect(capturedOptions?.maxBudgetUsd).toBeGreaterThan(0);

    // Events were emitted (dispatch, tool.call, task.state done, budget.tick).
    const types = new Set(sys.events.map((e) => e.type));
    expect(types.has("dispatch")).toBe(true);
    expect(types.has("tool.call")).toBe(true);
    expect(types.has("budget.tick")).toBe(true);
    sys.store.close();
  });

  it("never spawns a worker with bypassPermissions (§8.3)", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "orc-test-"));
    const sys = buildSystem(repoRoot);
    expect(() =>
      sys.workers.spawn({
        run_id: "r",
        task_id: "t",
        cwd: repoRoot,
        environment: "production",
        path_allowlist: [],
        path_denylist: [],
        allowed_tools: [],
        disallowed_tools: [],
        // deliberately invalid — must throw before any child spawns
        permission_mode: "bypassPermissions" as never,
        model: "haiku",
        max_turns: 1,
        max_budget_usd: 1,
        prompt: "x",
      }),
    ).toThrow(/not permitted/);
    sys.store.close();
  });
});

/** A query that ends in a failure result (drives the retry path). */
function failingQuery() {
  const messages = [
    { type: "system", subtype: "init", session_id: "s-fail", model: "sonnet" },
    {
      type: "result",
      subtype: "error_during_execution",
      total_cost_usd: 0.01,
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  ];
  async function* gen() {
    for (const m of messages) yield m;
  }
  return Object.assign(gen(), {
    interrupt: async () => {},
  }) as unknown as Query;
}

/** A query that streams until interrupted, then ends aborted (drives resume). */
function gatedQuery(sessionId: string) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  async function* gen() {
    yield {
      type: "system",
      subtype: "init",
      session_id: sessionId,
      model: "sonnet",
    };
    yield {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "Bash",
            input: { command: "sleep" },
          },
        ],
      },
    };
    await gate;
    yield {
      type: "result",
      subtype: "error_during_execution",
      total_cost_usd: 0.005,
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 5 },
    };
  }
  return Object.assign(gen(), {
    interrupt: async () => release(),
  }) as unknown as Query;
}

function newGoalScopeTask(
  sys: ReturnType<typeof buildSystem>,
  repoRoot: string,
) {
  const goal = sys.orchestrator.createGoal({
    title: "demo",
    objective: "o",
    success_criteria: [],
    constraints: [],
    out_of_scope: [],
    repo_root: repoRoot,
  });
  const scope = sys.orchestrator.createScope({
    goal_id: goal.id,
    name: "s",
    description: "",
    path_allowlist: [join(repoRoot, "**")],
    path_denylist: [],
    allowed_tools: ["Bash"],
    disallowed_tools: [],
    model_tier: "sonnet",
    environment: "development",
    permission_mode: "default",
    forbidden_actions: [],
    success_criteria: [],
    max_budget_usd: 5,
    depends_on: [],
  });
  sys.orchestrator.approveScope(scope.id);
  const task = sys.orchestrator.createTask({
    scope_id: scope.id,
    title: "t",
    prompt: "do the thing",
    task_type: "codegen",
    depends_on: [],
  });
  return { goal, scope, task };
}

describe("Orchestrator — bounded retry (§5, §13)", () => {
  it("retries a failed task, then succeeds", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "orc-test-"));
    let calls = 0;
    const sys = buildSystem(repoRoot, {
      queryFn: () => {
        calls += 1;
        return calls === 1 ? failingQuery() : fakeQuery(0.02);
      },
    });
    const { goal, task } = newGoalScopeTask(sys, repoRoot);
    const run = sys.orchestrator.startRun(goal.id, { budget_usd: 10 });

    await waitFor(() => sys.store.getTask(task.id)?.status === "done");
    await waitFor(() => sys.store.getRun(run.id)?.state === "done");

    const finalTask = sys.store.getTask(task.id)!;
    expect(finalTask.status).toBe("done");
    expect(finalTask.attempt).toBe(1); // one retry consumed
    expect(calls).toBe(2); // failed once, then succeeded
    sys.store.close();
  });

  it("fails the run after retries are exhausted", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "orc-test-"));
    const sys = buildSystem(repoRoot, { queryFn: () => failingQuery() });
    const { goal, task } = newGoalScopeTask(sys, repoRoot);
    const run = sys.orchestrator.startRun(goal.id, { budget_usd: 10 });

    await waitFor(() => sys.store.getRun(run.id)?.state === "failed");
    const finalTask = sys.store.getTask(task.id)!;
    expect(finalTask.status).toBe("failed");
    // max_attempts = 3 → attempt index reaches 2 on the last try.
    expect(finalTask.attempt).toBe(2);
    sys.store.close();
  });
});

describe("Orchestrator — pause/resume with session persistence (§5)", () => {
  it("pauses an in-flight task and resumes it on its captured session", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "orc-test-"));
    let calls = 0;
    const capturedResumes: (string | undefined)[] = [];
    const sys = buildSystem(repoRoot, {
      queryFn: (p) => {
        calls += 1;
        capturedResumes.push(p.options?.resume as string | undefined);
        return calls === 1 ? gatedQuery("sess-resume") : fakeQuery(0.03);
      },
    });
    const { goal, task } = newGoalScopeTask(sys, repoRoot);
    const run = sys.orchestrator.startRun(goal.id, { budget_usd: 10 });

    // Wait until the worker has captured its session id (running).
    await waitFor(() => !!sys.store.getTask(task.id)?.session_id);

    await sys.orchestrator.pause(run.id);
    await waitFor(() => sys.store.getTask(task.id)?.status === "paused");
    expect(sys.store.getTask(task.id)?.session_id).toBe("sess-resume");
    expect(sys.store.getRun(run.id)?.state).toBe("paused");

    // Resume: the task re-dispatches on its captured session and completes.
    sys.orchestrator.resume(run.id);
    await waitFor(() => sys.store.getTask(task.id)?.status === "done");
    await waitFor(() => sys.store.getRun(run.id)?.state === "done");

    // The second dispatch carried the resume session id (§5).
    expect(calls).toBe(2);
    expect(capturedResumes[1]).toBe("sess-resume");
    sys.store.close();
  });
});

describe("Orchestrator — scope completion detection (autonomous-loop.md §3.2, G1)", () => {
  it("marks a scope `done` and emits scope.done when all tasks succeed", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "orc-test-"));
    const sys = buildSystem(repoRoot);
    const { goal, scope, task } = newGoalScopeTask(sys, repoRoot);
    const run = sys.orchestrator.startRun(goal.id, { budget_usd: 10 });

    await waitFor(() => sys.store.getTask(task.id)?.status === "done");
    await waitFor(() => sys.store.getScope(scope.id)?.status === "done");

    expect(sys.store.getScope(scope.id)?.status).toBe("done");
    const done = sys.events.find((e) => e.type === "scope.done");
    expect(done).toBeDefined();
    expect((done?.payload as { scope_id: string }).scope_id).toBe(scope.id);
    expect((done?.payload as { failed_count: number }).failed_count).toBe(0);
    expect((done?.payload as { task_count: number }).task_count).toBe(1);
    void run;
    sys.store.close();
  });

  it("marks a scope `failed` and emits scope.failed when a task fails after retries", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "orc-test-"));
    const sys = buildSystem(repoRoot, { queryFn: () => failingQuery() });
    const { goal, scope, task } = newGoalScopeTask(sys, repoRoot);
    sys.orchestrator.startRun(goal.id, { budget_usd: 10 });

    await waitFor(() => sys.store.getScope(scope.id)?.status === "failed");
    expect(sys.store.getTask(task.id)?.status).toBe("failed");

    const failed = sys.events.find((e) => e.type === "scope.failed");
    expect(failed).toBeDefined();
    expect((failed?.payload as { failed_count: number }).failed_count).toBe(1);
    sys.store.close();
  });
});
