import { describe, expect, it } from "vitest";
import { Store } from "./index.js";

function seed(store: Store) {
  const goal = store.createGoal({
    title: "Migrate auth",
    objective: "done when auth uses new lib",
    success_criteria: [],
    constraints: [],
    out_of_scope: [],
    repo_root: "/repo",
  });
  const scope = store.createScope({
    goal_id: goal.id,
    name: "core",
    description: "",
    path_allowlist: ["/repo/src"],
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
  const task = store.createTask({
    scope_id: scope.id,
    title: "t",
    prompt: "do it",
    task_type: "mechanical",
    depends_on: [],
  });
  return { goal, scope, task };
}

describe("Store round-trip", () => {
  it("persists and re-hydrates entities with JSON columns", () => {
    const store = new Store(":memory:");
    const { goal, scope, task } = seed(store);

    expect(store.getGoal(goal.id)?.title).toBe("Migrate auth");
    expect(store.getScope(scope.id)?.path_allowlist).toEqual(["/repo/src"]);
    expect(store.getTask(task.id)?.task_type).toBe("mechanical");
    expect(store.listTasksByGoal(goal.id)).toHaveLength(1);
    store.close();
  });

  it("aggregates the budget ledger by run and task (§7.1)", () => {
    const store = new Store(":memory:");
    const { goal, task } = seed(store);
    const run = store.createRun({
      goal_id: goal.id,
      budget_usd: 10,
      concurrency_limit: 3,
    });

    store.insertLedgerEntry({
      run_id: run.id,
      task_id: task.id,
      session_id: "s1",
      cost_usd: 0.02,
      num_turns: 2,
      model: "haiku",
      tokens_in: 100,
      tokens_out: 50,
      cache_read: 0,
      cache_write: 0,
      recorded_at: new Date().toISOString(),
    });
    store.insertLedgerEntry({
      run_id: run.id,
      task_id: task.id,
      session_id: "s1",
      cost_usd: 0.03,
      num_turns: 1,
      model: "haiku",
      tokens_in: 10,
      tokens_out: 5,
      cache_read: 0,
      cache_write: 0,
      recorded_at: new Date().toISOString(),
    });

    expect(store.sumCostForRun(run.id)).toBeCloseTo(0.05);
    expect(store.sumCostForTask(task.id)).toBeCloseTo(0.05);
    store.close();
  });

  it("updates tasks and counts by status", () => {
    const store = new Store(":memory:");
    const { goal, task } = seed(store);
    store.updateTask(task.id, { status: "done", cost_usd: 1 });
    expect(store.getTask(task.id)?.status).toBe("done");
    expect(store.countTasksByStatus(goal.id).done).toBe(1);
    store.close();
  });

  it("assigns monotonic seq to events for SSE replay (§10)", () => {
    const store = new Store(":memory:");
    const s1 = store.appendEvent({
      ts: new Date().toISOString(),
      run_id: "r1",
      type: "run.state",
      payload: { state: "running" },
    });
    const s2 = store.appendEvent({
      ts: new Date().toISOString(),
      run_id: "r1",
      type: "budget.tick",
      payload: {
        budget_usd: 10,
        spent_usd: 1,
        state: "ok",
        warn_at: 0.7,
        stop_at: 0.9,
      },
    });
    expect(s2).toBeGreaterThan(s1);
    expect(store.listEventsSince(s1, "r1")).toHaveLength(1);
    store.close();
  });

  it("demotes running runs on startup (§5 crash recovery)", () => {
    const store = new Store(":memory:");
    const { goal } = seed(store);
    const run = store.createRun({
      goal_id: goal.id,
      budget_usd: 10,
      concurrency_limit: 3,
    });
    expect(store.getRun(run.id)?.state).toBe("running");
    store.demoteActiveRunsOnStartup();
    expect(store.getRun(run.id)?.state).toBe("paused");
    store.close();
  });
});
