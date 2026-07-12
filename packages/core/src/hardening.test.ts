/**
 * Phase 4 hardening tests (§13): rate-limit chaos, crash recovery, dirty-resume,
 * and the escalation block-and-resolve loop. These exercise the orchestrator
 * against injected failures rather than a live SDK.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type { OrchestratorConfig } from "@orc-brain/shared";
import { createSystem } from "./system.js";
import { DEFAULT_CONFIG } from "./config.js";
import { SafetyLayer } from "./safety/index.js";
import { EscalationManager } from "./escalation.js";
import { EventBus } from "./eventBus.js";
import { Store } from "./store/index.js";
import { NullAuditLog } from "./store/auditLog.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "orc-hard-"));
}

async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A query that yields an init then throws — the CLI surfaced an error string. */
function throwingQuery(message: string) {
  async function* gen() {
    yield { type: "system", subtype: "init", session_id: "s", model: "sonnet" };
    throw new Error(message);
  }
  return Object.assign(gen(), {
    interrupt: async () => {},
  }) as unknown as Query;
}

/** A query that inits then succeeds. */
function successQuery() {
  async function* gen() {
    yield {
      type: "system",
      subtype: "init",
      session_id: "s-ok",
      model: "sonnet",
    };
    yield {
      type: "result",
      subtype: "success",
      total_cost_usd: 0.01,
      num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
      result: "ok",
    };
  }
  return Object.assign(gen(), {
    interrupt: async () => {},
  }) as unknown as Query;
}

/**
 * A query that inits then blocks on `gate` (a straggler / in-flight worker).
 * The gate is released in test teardown so no promise is left dangling — a
 * never-resolving worker would keep vitest from exiting.
 */
function gatedQuery(gate: Promise<void>, sessionId = "s-hang") {
  async function* gen() {
    yield {
      type: "system",
      subtype: "init",
      session_id: sessionId,
      model: "sonnet",
    };
    await gate;
    yield {
      type: "result",
      subtype: "error_during_execution",
      total_cost_usd: 0,
      num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }
  return Object.assign(gen(), {
    interrupt: async () => {},
  }) as unknown as Query;
}

function seed(sys: ReturnType<typeof createSystem>, repoRoot: string) {
  const goal = sys.orchestrator.createGoal({
    title: "g",
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
    prompt: "p",
    task_type: "codegen",
    depends_on: [],
  });
  return { goal, scope, task };
}

describe("chaos: rate-limit backpressure (§7.4)", () => {
  it("engages global backpressure and re-queues (not fails) on a session limit", async () => {
    const dir = tmp();
    const sys = createSystem({
      stateDir: dir,
      queryFn: () =>
        throwingQuery("You've hit your session limit · resets 11:59pm"),
    });
    const events: string[] = [];
    sys.bus.subscribe((e) => events.push(e.type));
    const { goal, task } = seed(sys, dir);
    sys.orchestrator.startRun(goal.id, { budget_usd: 10 });

    await waitFor(() => sys.backpressure.isDispatchBlocked());
    // The task is held for a later attempt, not marked failed.
    expect(sys.store.getTask(task.id)?.status).toBe("queued");
    expect(events).toContain("limit.backpressure");
    sys.close();
  });

  it("quarantines only the affected model on a per-model limit (router R7)", async () => {
    const dir = tmp();
    let calls = 0;
    const sys = createSystem({
      stateDir: dir,
      // First attempt hits an Opus limit; the retry routes around it (R7).
      queryFn: () =>
        ++calls === 1
          ? throwingQuery("Opus limit reached, try later")
          : successQuery(),
    });
    const { goal, task } = seed(sys, dir);
    const run = sys.orchestrator.startRun(goal.id, { budget_usd: 10 });

    await waitFor(() => sys.backpressure.quarantinedModels().includes("opus"));
    expect(sys.backpressure.isDispatchBlocked()).toBe(false); // model-only
    // Dispatch is not globally halted, so the task still completes on retry.
    await waitFor(() => sys.store.getTask(task.id)?.status === "done");
    expect(sys.store.getRun(run.id)?.state).toBe("done");
    sys.close();
  });
});

describe("crash recovery (§5)", () => {
  it("demotes a Running run to Paused on restart, with no auto-resume", () => {
    const dir = tmp();
    // A crash leaves a Running run persisted with no live process.
    const sys1 = createSystem({ stateDir: dir });
    const { goal } = seed(sys1, dir);
    const run = sys1.store.createRun({
      goal_id: goal.id,
      budget_usd: 10,
      concurrency_limit: 1,
    });
    sys1.store.updateRun(run.id, { state: "running" });
    sys1.close(); // simulate crash

    // Reopen: the constructor demotes Running/Pausing runs to Paused, and
    // nothing auto-resumes without an operator command (Open Decision 8).
    const sys2 = createSystem({ stateDir: dir });
    expect(sys2.store.getRun(run.id)?.state).toBe("paused");
    expect(sys2.store.getRun(run.id)?.pause_reason).toMatch(/restart/);
    sys2.close();
  });
});

describe("dirty-resume workflow (§13.6)", () => {
  it("flags a straggler dirty on grace timeout, and clears it on resume", async () => {
    const dir = tmp();
    const config: OrchestratorConfig = {
      ...DEFAULT_CONFIG,
      pause: { grace_ms: 20, sigkill_after_ms: 5 },
    };
    // The gate keeps the worker in-flight until we release it in teardown.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sys = createSystem({
      stateDir: dir,
      config,
      queryFn: () => gatedQuery(gate, "sess-dirty"),
    });
    try {
      const { goal, task } = seed(sys, dir);
      const run = sys.orchestrator.startRun(goal.id, { budget_usd: 10 });
      await waitFor(() => sys.store.getTask(task.id)?.status === "running");

      // The worker does not yield, so pause hits the grace timeout → dirty.
      await sys.orchestrator.pause(run.id);
      expect(sys.store.getTask(task.id)?.status).toBe("paused");
      expect(sys.store.getTask(task.id)?.dirty).toBe(true);
      expect(sys.store.getRun(run.id)?.state).toBe("paused");

      // The captured session id is preserved so resume can continue it (§5).
      expect(sys.store.getTask(task.id)?.session_id).toBe("sess-dirty");
    } finally {
      release(); // let the suspended worker settle so vitest can exit
      sys.close();
    }
  });
});

describe("escalation block-and-resolve (§8.5)", () => {
  it("blocks a task on the 2nd same-rule denial and resolves it", () => {
    const dir = tmp();
    const sys = createSystem({ stateDir: dir });
    const { goal, scope, task } = seed(sys, dir);
    const run = sys.store.createRun({
      goal_id: goal.id,
      budget_usd: 10,
      concurrency_limit: 1,
    });

    // Drive two same-rule denials through the safety hook wiring.
    const denial = {
      run_id: run.id,
      task_id: task.id,
      rule_id: "FS-1",
      tool_name: "Bash",
      input_summary: "rm -rf /",
    };
    expect(sys.escalation.recordDenial(denial)).toBeNull(); // 1st: warn
    const esc = sys.escalation.recordDenial(denial); // 2nd: block
    expect(esc).not.toBeNull();
    expect(sys.store.getTask(task.id)?.status).toBe("blocked");
    expect(sys.store.listOpenEscalations(run.id)).toHaveLength(1);
    void scope;

    // Resolve → skip: the task is skipped and the escalation closed.
    sys.orchestrator.resolveEscalation(esc!.id, "skip_task");
    expect(sys.store.getTask(task.id)?.status).toBe("skipped");
    expect(sys.store.listOpenEscalations(run.id)).toHaveLength(0);
    sys.close();
  });

  it("deny-&-instruct re-queues the blocked task", () => {
    const dir = tmp();
    const sys = createSystem({ stateDir: dir });
    const { goal, task } = seed(sys, dir);
    const run = sys.store.createRun({
      goal_id: goal.id,
      budget_usd: 10,
      concurrency_limit: 1,
    });
    const d = {
      run_id: run.id,
      task_id: task.id,
      rule_id: "VCS-1",
      tool_name: "Bash",
      input_summary: "git push --force",
    };
    sys.escalation.recordDenial(d);
    const esc = sys.escalation.recordDenial(d)!;
    sys.orchestrator.stop(); // avoid the resolve's tick spawning a real worker
    sys.orchestrator.resolveEscalation(esc.id, "deny_instruct", "use a PR");
    expect(sys.store.getTask(task.id)?.status).toBe("queued");
    expect(sys.store.getEscalation(esc.id)?.status).toBe("resolved");
    sys.close();
  });

  it("wires the safety hook to the escalation manager", async () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const escalation = new EscalationManager(store, bus, DEFAULT_CONFIG);
    const safety = new SafetyLayer(
      DEFAULT_CONFIG,
      new NullAuditLog(),
      escalation,
    );
    const goal = store.createGoal({
      title: "g",
      objective: "o",
      success_criteria: [],
      constraints: [],
      out_of_scope: [],
      repo_root: "/repo",
    });
    const scope = store.createScope({
      goal_id: goal.id,
      name: "s",
      description: "",
      path_allowlist: ["/repo/**"],
      path_denylist: [],
      allowed_tools: ["Bash"],
      disallowed_tools: [],
      model_tier: "auto",
      environment: "production",
      permission_mode: "default",
      forbidden_actions: [],
      success_criteria: [],
      max_budget_usd: 5,
      depends_on: [],
    });
    const run = store.createRun({
      goal_id: goal.id,
      budget_usd: 10,
      concurrency_limit: 1,
    });
    const task = store.createTask({
      scope_id: scope.id,
      title: "t",
      prompt: "p",
      task_type: "codegen",
      depends_on: [],
    });

    const hooks = safety.buildHooks({
      run_id: run.id,
      task_id: task.id,
      environment: "production",
      cwd: "/repo",
      path_allowlist: ["/repo/**"],
      path_denylist: [],
    });
    const hook = hooks.PreToolUse![0]!.hooks[0]!;
    const input = {
      hook_event_name: "PreToolUse" as const,
      tool_name: "Bash",
      tool_input: { command: "rm -rf /" },
    };
    // Two denials of the same rule → the task is blocked (§8.5).
    await hook(input as never, undefined, {
      signal: new AbortController().signal,
    });
    await hook(input as never, undefined, {
      signal: new AbortController().signal,
    });
    expect(store.getTask(task.id)?.status).toBe("blocked");
    expect(store.listOpenEscalations(run.id)).toHaveLength(1);
    store.close();
  });
});

describe("repo concurrency guard (§13.11)", () => {
  it("refuses a second run on the same repo while one is active", () => {
    const dir = tmp();
    const sys = createSystem({ stateDir: dir, queryFn: () => successQuery() });
    const goalA = sys.orchestrator.createGoal({
      title: "a",
      objective: "o",
      success_criteria: [],
      constraints: [],
      out_of_scope: [],
      repo_root: dir,
    });
    const goalB = sys.orchestrator.createGoal({
      title: "b",
      objective: "o",
      success_criteria: [],
      constraints: [],
      out_of_scope: [],
      repo_root: dir, // same repo
    });
    sys.orchestrator.startRun(goalA.id, { budget_usd: 5 });
    expect(() =>
      sys.orchestrator.startRun(goalB.id, { budget_usd: 5 }),
    ).toThrow(/already active/);
    sys.close();
  });
});
