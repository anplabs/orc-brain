/**
 * Project registry + feature-flow + worktree-dispatch + pacing integration
 * tests (spec 002 §R1–§R5, §R8–§R10, §R13–§R16). Fake SDK workers throughout;
 * real git in temp repos for the worktree paths.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Options, Query } from "@anthropic-ai/claude-agent-sdk";
import type { BusEvent, OrchestratorConfig } from "@orc-brain/shared";
import { Store } from "./store/index.js";
import { NullAuditLog } from "./store/auditLog.js";
import { EventBus } from "./eventBus.js";
import { SafetyLayer } from "./safety/index.js";
import { BudgetTracker } from "./budgetTracker.js";
import { WorkerManager, type WorkerSpec } from "./workerManager.js";
import { Planner } from "./planner.js";
import { EscalationManager } from "./escalation.js";
import { ReportingEngine } from "./reporting.js";
import { Backpressure } from "./backpressure.js";
import { Orchestrator } from "./orchestrator.js";
import { WorktreeManager } from "./worktrees.js";
import { DEFAULT_CONFIG } from "./config.js";

/** Creates a git repo on branch `main` with one commit. */
function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "orc-repo-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "test@local");
  git("config", "user.name", "test");
  writeFileSync(join(repo, "README.md"), "hello\n");
  git("add", "-A");
  git("commit", "-m", "initial");
  return repo;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A fake SDK stream: init → result. `ok: false` yields a failed result. */
function fakeQuery(opts: { ok?: boolean; gate?: Promise<void> } = {}): Query {
  async function* gen() {
    yield {
      type: "system",
      subtype: "init",
      session_id: `sess-${Math.random().toString(36).slice(2)}`,
      model: "haiku",
    };
    if (opts.gate) await opts.gate;
    yield {
      type: "result",
      subtype: opts.ok === false ? "error_during_execution" : "success",
      total_cost_usd: 0.01,
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 5 },
      result: "completed",
    };
  }
  return Object.assign(gen(), {
    interrupt: async () => {},
  }) as unknown as Query;
}

function buildSystem(
  opts: {
    config?: OrchestratorConfig;
    stateDir?: string;
    queryFn?: (p: { prompt: string; options?: Options }) => Query;
  } = {},
) {
  const config = opts.config ?? DEFAULT_CONFIG;
  const stateDir = opts.stateDir ?? mkdtempSync(join(tmpdir(), "orc-state-"));
  const store = new Store(":memory:");
  const audit = new NullAuditLog();
  const bus = new EventBus(store);
  const safety = new SafetyLayer(config, audit);
  const budget = new BudgetTracker(store, bus, config.budget);
  const queryFn = opts.queryFn ?? (() => fakeQuery());
  const escalation = new EscalationManager(store, bus, config);
  const workers = new WorkerManager(safety, bus, store, budget, queryFn);
  // Spy on spawn to capture the full WorkerSpec (cwd, environment, prompt).
  const specs: WorkerSpec[] = [];
  const origSpawn = workers.spawn.bind(workers);
  workers.spawn = (spec: WorkerSpec) => {
    specs.push(spec);
    return origSpawn(spec);
  };
  const orchestrator = new Orchestrator({
    store,
    bus,
    config,
    safety,
    workers,
    budget,
    audit,
    planner: new Planner(config),
    escalation,
    reporting: new ReportingEngine(
      store,
      bus,
      config,
      mkdtempSync(join(tmpdir(), "orc-reports-")),
    ),
    backpressure: new Backpressure(bus, config.limits),
    worktrees: new WorktreeManager(stateDir),
  });
  const events: BusEvent[] = [];
  bus.subscribe((e) => events.push(e));
  return { store, orchestrator, events, specs, stateDir };
}

type Sys = ReturnType<typeof buildSystem>;

function makeGoalWithTask(
  sys: Sys,
  repoRoot: string,
  opts: { projectId?: string; taskCount?: number; scopeName?: string } = {},
) {
  const goal = sys.store.createGoal({
    title: "demo goal",
    objective: "do the thing",
    success_criteria: [],
    constraints: [],
    out_of_scope: [],
    project_id: opts.projectId ?? null,
    repo_root: repoRoot,
  });
  const scope = sys.store.createScope({
    goal_id: goal.id,
    name: opts.scopeName ?? "scope-a",
    description: "",
    path_allowlist: ["**"],
    path_denylist: [],
    allowed_tools: ["Bash"],
    disallowed_tools: [],
    model_tier: "auto",
    environment: "development",
    permission_mode: "default",
    forbidden_actions: [],
    success_criteria: [],
    max_budget_usd: 2,
    depends_on: [],
    status: "approved",
  });
  const tasks = [];
  for (let i = 0; i < (opts.taskCount ?? 1); i++) {
    tasks.push(
      sys.store.createTask({
        scope_id: scope.id,
        title: `task-${i}`,
        prompt: `do part ${i}`,
        task_type: "mechanical",
        depends_on: [],
      }),
    );
  }
  return { goal, scope, tasks };
}

async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("Store — projects (spec 002 §R1)", () => {
  it("CRUD round-trip and unique repo_root", () => {
    const { store } = buildSystem();
    const p = store.createProject({
      name: "dogfood",
      repo_root: "/tmp/x/dogfood-app",
      execution_mode: "worktree",
      default_budget_usd: 10,
      default_concurrency: 2,
    });
    expect(store.getProject(p.id)?.name).toBe("dogfood");
    expect(store.getProjectByRepoRoot("/tmp/x/dogfood-app")?.id).toBe(p.id);
    expect(() =>
      store.createProject({
        name: "dup",
        repo_root: "/tmp/x/dogfood-app",
        execution_mode: "in_repo",
        default_budget_usd: 5,
        default_concurrency: 1,
      }),
    ).toThrow(/UNIQUE/);
    store.updateProject(p.id, { execution_mode: "in_repo" });
    expect(store.getProject(p.id)?.execution_mode).toBe("in_repo");
    store.deleteProject(p.id);
    expect(store.getProject(p.id)).toBeNull();
  });

  it("run auto_loop persists as a boolean (0/1 coercion)", () => {
    const { store } = buildSystem();
    const g = store.createGoal({
      title: "g",
      objective: "o",
      success_criteria: [],
      constraints: [],
      out_of_scope: [],
      repo_root: "/tmp/r",
    });
    const run = store.createRun({
      goal_id: g.id,
      budget_usd: 5,
      concurrency_limit: 1,
      base_branch: "main",
      auto_loop: true,
    });
    const loaded = store.getRun(run.id)!;
    expect(loaded.auto_loop).toBe(true);
    expect(loaded.base_branch).toBe("main");
    store.updateRun(run.id, { auto_loop: false });
    expect(store.getRun(run.id)!.auto_loop).toBe(false);
  });

  it("listBoardCards joins tasks → scopes → goals → projects (§R17)", () => {
    const sys = buildSystem();
    const p = sys.store.createProject({
      name: "proj",
      repo_root: "/tmp/proj",
      execution_mode: "in_repo",
      default_budget_usd: 10,
      default_concurrency: 2,
    });
    makeGoalWithTask(sys, "/tmp/proj", { projectId: p.id, taskCount: 2 });
    makeGoalWithTask(sys, "/tmp/legacy"); // no project → excluded
    const cards = sys.store.listBoardCards();
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({
      project_id: p.id,
      project_name: "proj",
      scope_name: "scope-a",
      goal_title: "demo goal",
      status: "pending",
    });
    expect(sys.store.listBoardCards("nonexistent")).toHaveLength(0);
  });
});

describe("Worktree dispatch (spec 002 §R8–§R10)", () => {
  it("worktree project: cwd is the scope worktree, branch kept after release, base-branch classification", async () => {
    const repo = makeRepo();
    const sys = buildSystem({
      queryFn: (p) => {
        // Simulate a worker leaving uncommitted work in its cwd.
        const cwd = (p.options as { cwd?: string } | undefined)?.cwd;
        if (cwd) writeFileSync(join(cwd, "work.txt"), "wip\n");
        return fakeQuery();
      },
    });
    const project = sys.store.createProject({
      name: "wt-proj",
      repo_root: repo,
      execution_mode: "worktree",
      default_budget_usd: 10,
      default_concurrency: 2,
    });
    const { goal, scope } = makeGoalWithTask(sys, repo, {
      projectId: project.id,
      scopeName: "backend",
    });

    const run = sys.orchestrator.startRun(goal.id, { budget_usd: 5 });
    expect(run.base_branch).toBe("main");
    await waitFor(() => sys.store.getRun(run.id)?.state === "done");

    // Worker ran inside the scope worktree with the §R9 prompt suffix.
    const spec = sys.specs[0]!;
    expect(spec.cwd).toBe(join(sys.stateDir, "worktrees", run.id, scope.id));
    expect(spec.prompt).toContain("dedicated git worktree");
    // §R10: repo is on `main` (a prod branch) — classification must follow
    // the base branch, not the non-prod `orc/…` worktree branch.
    expect(spec.environment).toBe("production");

    // Scope settled: worktree removed, branch kept with the safety-net commit.
    const settled = sys.store.getScope(scope.id)!;
    expect(settled.status).toBe("done");
    expect(settled.worktree_path).toBeNull();
    expect(settled.branch_name).toBe("orc/demo-goal/backend");
    expect(existsSync(spec.cwd)).toBe(false);
    expect(git(repo, "branch", "--list", "orc/*")).toContain(
      "orc/demo-goal/backend",
    );
    expect(git(repo, "log", "--oneline", "orc/demo-goal/backend")).toContain(
      "orc: auto-commit remaining changes",
    );
  });

  it("in_repo project: behavior is unchanged (regression)", async () => {
    const repo = makeRepo();
    const sys = buildSystem();
    const project = sys.store.createProject({
      name: "plain",
      repo_root: repo,
      execution_mode: "in_repo",
      default_budget_usd: 10,
      default_concurrency: 2,
    });
    const { goal } = makeGoalWithTask(sys, repo, { projectId: project.id });

    const run = sys.orchestrator.startRun(goal.id, { budget_usd: 5 });
    await waitFor(() => sys.store.getRun(run.id)?.state === "done");

    const spec = sys.specs[0]!;
    expect(spec.cwd).toBe(repo);
    expect(spec.prompt).not.toContain("worktree");
    expect(git(repo, "branch", "--list", "orc/*").trim()).toBe("");
  });

  it("keeps the worktree on scope failure for debugging (§R8)", async () => {
    const repo = makeRepo();
    const sys = buildSystem({ queryFn: () => fakeQuery({ ok: false }) });
    const project = sys.store.createProject({
      name: "wt-fail",
      repo_root: repo,
      execution_mode: "worktree",
      default_budget_usd: 10,
      default_concurrency: 2,
    });
    const { goal, scope } = makeGoalWithTask(sys, repo, {
      projectId: project.id,
    });

    const run = sys.orchestrator.startRun(goal.id, { budget_usd: 5 });
    await waitFor(() => sys.store.getRun(run.id)?.state === "failed");

    const settled = sys.store.getScope(scope.id)!;
    expect(settled.status).toBe("failed");
    expect(settled.worktree_path).not.toBeNull();
    expect(existsSync(settled.worktree_path!)).toBe(true);
  });
});

describe("Pacing (spec 002 §R13–§R16)", () => {
  it("caps simultaneous workers across runs at global_concurrency_limit", async () => {
    const config: OrchestratorConfig = {
      ...DEFAULT_CONFIG,
      global_concurrency_limit: 2,
    };
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sys = buildSystem({
      config,
      queryFn: () => {
        active++;
        maxActive = Math.max(maxActive, active);
        const q = fakeQuery({ gate: gate.then(() => void active--) });
        return q;
      },
    });
    const a = makeGoalWithTask(sys, "/tmp/repo-a", { taskCount: 2 });
    const b = makeGoalWithTask(sys, "/tmp/repo-b", { taskCount: 2 });

    const runA = sys.orchestrator.startRun(a.goal.id, {
      budget_usd: 5,
      concurrency_limit: 2,
    });
    const runB = sys.orchestrator.startRun(b.goal.id, {
      budget_usd: 5,
      concurrency_limit: 2,
    });

    try {
      await waitFor(() => sys.orchestrator.inFlight === 2);
      // Both runs want 2 each; the fleet-wide cap holds at 2 and the hold is
      // announced once (edge-triggered).
      expect(maxActive).toBe(2);
      expect(
        sys.events.some(
          (e) =>
            e.type === "pacing.hold" &&
            e.payload.reason === "global_concurrency",
        ),
      ).toBe(true);
    } finally {
      release();
    }

    await waitFor(
      () =>
        sys.store.getRun(runA.id)?.state === "done" &&
        sys.store.getRun(runB.id)?.state === "done",
      10_000,
    );
    expect(maxActive).toBe(2);
  });

  it("defers the N+1-th dispatch within the hour and publishes pacing.hold", async () => {
    const config: OrchestratorConfig = {
      ...DEFAULT_CONFIG,
      budget: { ...DEFAULT_CONFIG.budget, max_tasks_per_hour: 1 },
    };
    const sys = buildSystem({ config });
    const { goal, tasks } = makeGoalWithTask(sys, "/tmp/repo-h", {
      taskCount: 2,
    });

    const run = sys.orchestrator.startRun(goal.id, { budget_usd: 5 });
    await waitFor(() =>
      sys.events.some(
        (e) =>
          e.type === "pacing.hold" && e.payload.reason === "tasks_per_hour",
      ),
    );
    const hold = sys.events.find((e) => e.type === "pacing.hold")!;
    expect((hold.payload as { resume_at?: string }).resume_at).toBeDefined();

    // Exactly one task dispatched; the run stays running, the other waits.
    await waitFor(() => sys.store.getTask(tasks[0]!.id)?.status === "done");
    expect(sys.store.getRun(run.id)?.state).toBe("running");
    const second = sys.store.getTask(tasks[1]!.id)!;
    expect(["pending", "queued"]).toContain(second.status);
  });

  it("parks the run at the max_tasks_per_run ceiling with a distinct reason (§R15)", async () => {
    const config: OrchestratorConfig = {
      ...DEFAULT_CONFIG,
      budget: { ...DEFAULT_CONFIG.budget, max_tasks_per_run: 0 },
    };
    const sys = buildSystem({ config });
    const { goal } = makeGoalWithTask(sys, "/tmp/repo-cap");

    const run = sys.orchestrator.startRun(goal.id, { budget_usd: 5 });
    await waitFor(() => sys.store.getRun(run.id)?.state === "paused");
    expect(sys.store.getRun(run.id)?.pause_reason).toBe("tasks_per_run_cap");
    expect(
      sys.events.some(
        (e) => e.type === "pacing.hold" && e.payload.reason === "tasks_per_run",
      ),
    ).toBe(true);
  });
});

describe("Feature-flow runs (spec 002 §R5)", () => {
  it("auto_loop runs hand off to the controller even with global autoLoop off", async () => {
    const sys = buildSystem(); // DEFAULT_CONFIG: autoLoop.enabled = false
    const quiesced: string[] = [];
    sys.orchestrator.setAutoLoop({ onRunQuiesced: (id) => quiesced.push(id) });

    const a = makeGoalWithTask(sys, "/tmp/repo-auto");
    const runAuto = sys.orchestrator.startRun(a.goal.id, {
      budget_usd: 5,
      auto_loop: true,
    });
    await waitFor(() => quiesced.includes(runAuto.id));
    // The controller owns the decision — the orchestrator did not finalize.
    expect(sys.store.getRun(runAuto.id)?.state).toBe("running");

    // Control: a plain run with global autoLoop off finalizes as before.
    const b = makeGoalWithTask(sys, "/tmp/repo-static");
    const runStatic = sys.orchestrator.startRun(b.goal.id, { budget_usd: 5 });
    await waitFor(() => sys.store.getRun(runStatic.id)?.state === "done");
    // Quiesce may notify more than once (cross-run re-ticks) — the controller
    // is idempotent. What matters: only the auto_loop run ever hands off.
    expect(new Set(quiesced)).toEqual(new Set([runAuto.id]));
  });
});

describe("Auto-merge on scope settlement (spec 002 v2)", () => {
  it("merges the scope branch into the base branch when project.auto_merge", async () => {
    const repo = makeRepo();
    const sys = buildSystem({
      queryFn: (p) => {
        const cwd = (p.options as { cwd?: string } | undefined)?.cwd;
        if (cwd) writeFileSync(join(cwd, "feature.txt"), "done\n");
        return fakeQuery();
      },
    });
    const project = sys.store.createProject({
      name: "am",
      repo_root: repo,
      execution_mode: "worktree",
      auto_merge: true,
      default_budget_usd: 10,
      default_concurrency: 2,
    });
    const { goal } = makeGoalWithTask(sys, repo, { projectId: project.id });

    const run = sys.orchestrator.startRun(goal.id, { budget_usd: 5 });
    await waitFor(() => sys.store.getRun(run.id)?.state === "done");

    // The scope's work landed on main via a --no-ff merge; branch kept.
    expect(existsSync(join(repo, "feature.txt"))).toBe(true);
    expect(git(repo, "log", "--oneline", "-1", "main")).toContain("orc: merge");
    expect(git(repo, "branch", "--list", "orc/*")).toContain("orc/demo-goal");
  });

  it("leaves the branch unmerged when the checkout is dirty", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "local-wip.txt"), "wip\n"); // dirty checkout
    const sys = buildSystem();
    const project = sys.store.createProject({
      name: "am2",
      repo_root: repo,
      execution_mode: "worktree",
      auto_merge: true,
      default_budget_usd: 10,
      default_concurrency: 2,
    });
    const { goal } = makeGoalWithTask(sys, repo, { projectId: project.id });

    const run = sys.orchestrator.startRun(goal.id, { budget_usd: 5 });
    await waitFor(() => sys.store.getRun(run.id)?.state === "done");

    expect(git(repo, "log", "--oneline", "-1", "main")).not.toContain(
      "orc: merge",
    );
    expect(git(repo, "branch", "--list", "orc/*")).toContain("orc/demo-goal");
  });
});

describe("Multiple runs per repo (spec 002 v2)", () => {
  it("allows concurrent runs on one repo for worktree projects, refuses in_repo", async () => {
    const repo = makeRepo();
    const sys = buildSystem();
    const wtProject = sys.store.createProject({
      name: "multi",
      repo_root: repo,
      execution_mode: "worktree",
      default_budget_usd: 10,
      default_concurrency: 1,
    });
    const a = makeGoalWithTask(sys, repo, {
      projectId: wtProject.id,
      scopeName: "scope-one",
    });
    const b = makeGoalWithTask(sys, repo, {
      projectId: wtProject.id,
      scopeName: "scope-two",
    });

    const runA = sys.orchestrator.startRun(a.goal.id, { budget_usd: 5 });
    // Second goal, same repo, worktree mode → allowed.
    const runB = sys.orchestrator.startRun(b.goal.id, { budget_usd: 5 });
    await waitFor(
      () =>
        sys.store.getRun(runA.id)?.state === "done" &&
        sys.store.getRun(runB.id)?.state === "done",
    );

    // Same GOAL is still locked while its run is active.
    const c = makeGoalWithTask(sys, repo, { projectId: wtProject.id });
    let releaseC!: () => void;
    const gateC = new Promise<void>((r) => (releaseC = r));
    const sys2 = buildSystem({ queryFn: () => fakeQuery({ gate: gateC }) });
    const p2 = sys2.store.createProject({
      name: "multi2",
      repo_root: repo,
      execution_mode: "worktree",
      default_budget_usd: 10,
      default_concurrency: 1,
    });
    void c;
    const d = makeGoalWithTask(sys2, repo, { projectId: p2.id });
    sys2.orchestrator.startRun(d.goal.id, { budget_usd: 5 });
    expect(() =>
      sys2.orchestrator.startRun(d.goal.id, { budget_usd: 5 }),
    ).toThrow(/already active for this goal/);
    releaseC();

    // in_repo project on a busy repo still refuses (repo-level lock).
    const repo2 = makeRepo();
    let release2!: () => void;
    const gate2 = new Promise<void>((r) => (release2 = r));
    const sys3 = buildSystem({ queryFn: () => fakeQuery({ gate: gate2 }) });
    const inRepo = sys3.store.createProject({
      name: "plain2",
      repo_root: repo2,
      execution_mode: "in_repo",
      default_budget_usd: 10,
      default_concurrency: 1,
    });
    const e1 = makeGoalWithTask(sys3, repo2, { projectId: inRepo.id });
    const e2 = makeGoalWithTask(sys3, repo2, { projectId: inRepo.id });
    const runE = sys3.orchestrator.startRun(e1.goal.id, { budget_usd: 5 });
    expect(() =>
      sys3.orchestrator.startRun(e2.goal.id, { budget_usd: 5 }),
    ).toThrow(/already active for/);
    release2();
    await waitFor(() => sys3.store.getRun(runE.id)?.state === "done");
  });
});

describe("Task priority (spec 002 v2 kanban drag)", () => {
  it("dispatches higher-priority tasks first", async () => {
    const sys = buildSystem();
    const { goal, tasks } = makeGoalWithTask(sys, "/tmp/repo-prio", {
      taskCount: 3,
    });
    // Reverse the natural order: last task gets the highest priority.
    sys.store.setTaskPriority(tasks[2]!.id, 10);
    sys.store.setTaskPriority(tasks[1]!.id, 5);

    const run = sys.orchestrator.startRun(goal.id, {
      budget_usd: 5,
      concurrency_limit: 1,
    });
    await waitFor(() => sys.store.getRun(run.id)?.state === "done");

    const dispatched = sys.specs.map((s) => s.task_id);
    expect(dispatched).toEqual([tasks[2]!.id, tasks[1]!.id, tasks[0]!.id]);
  });
});
