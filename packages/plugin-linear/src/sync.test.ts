/**
 * Linear status-sync tests (spec 003 §R12): run.state reactions, once-per-run
 * guards, provider filtering, completion opt-in, and failure swallowing —
 * against a fake host and a recording fake client. No network.
 */

import { describe, expect, it } from "vitest";
import type {
  BusEvent,
  ExternalRef,
  Goal,
  PluginHost,
  Run,
  RunState,
  Scope,
} from "@orc-brain/shared";
import type { LinearClient } from "./api.js";
import { attachSync } from "./sync.js";
import createLinearPlugin from "./index.js";

const REF: ExternalRef = {
  provider: "linear",
  id: "uuid-1",
  identifier: "ENG-123",
  url: "https://linear.app/acme/issue/ENG-123",
  title: "Fix drift",
};

function makeGoal(ref: ExternalRef | null): Goal {
  return {
    id: "goal-1",
    created_at: "",
    updated_at: "",
    title: "ENG-123: Fix drift",
    objective: "fix it",
    success_criteria: [],
    constraints: [],
    out_of_scope: [],
    project_id: "proj-1",
    repo_root: "/tmp/repo",
    status: "active",
    external_ref: ref,
  };
}

function makeRun(): Run {
  return {
    id: "run-1",
    created_at: "",
    updated_at: "",
    goal_id: "goal-1",
    state: "running",
    budget_usd: 10,
    budget_spent_usd: 1.2345,
    budget_state: "ok",
    concurrency_limit: 2,
    started_at: null,
    paused_at: null,
    finished_at: null,
    pause_reason: null,
    base_branch: "main",
    auto_loop: false,
    replan_cycle: 0,
  };
}

/** Recording fake of the LinearClient surface `attachSync` uses. */
function fakeClient(opts: { fail?: boolean } = {}) {
  const comments: string[] = [];
  const moves: string[] = [];
  const client = {
    createComment: async (_issueId: string, body: string) => {
      if (opts.fail) throw new Error("linear is down");
      comments.push(body);
    },
    moveIssueToStateType: async (_issueId: string, type: string) => {
      if (opts.fail) throw new Error("linear is down");
      moves.push(type);
      return { id: "s1", name: type, type, position: 1 };
    },
  } as unknown as LinearClient;
  return { client, comments, moves };
}

function fakeHost(goal: Goal | null, scopes: Scope[] = []) {
  const subscribers: Array<(e: BusEvent) => void> = [];
  const synced: Array<{ action: string; ok: boolean; detail?: string }> = [];
  const host: PluginHost = {
    log: () => {},
    audit: () => {},
    reportSync: (action, info) =>
      synced.push({ action, ok: info.ok, detail: info.detail }),
    getSecret: () => "lin_key_1234",
    settings: {},
    subscribe: (fn) => {
      subscribers.push(fn);
      return () => {};
    },
    listProjects: async () => [],
    getGoal: async (id) => (goal && id === goal.id ? goal : null),
    getRun: async (id) => (id === "run-1" ? makeRun() : null),
    listScopesByGoal: async () => scopes,
    createGoalFromExternalTask: async () => {
      throw new Error("unused");
    },
  };
  const emit = (state: RunState, reason?: string) => {
    for (const fn of subscribers) {
      fn({
        seq: 1,
        ts: "",
        run_id: "run-1",
        type: "run.state",
        payload: { state, ...(reason ? { reason } : {}) },
      } as BusEvent);
    }
  };
  return { host, synced, emit };
}

/** Lets the fire-and-forget handlers settle. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10));
}

describe("Linear sync (spec 003 §R12)", () => {
  it("run start: moves to a started-type state and comments, once per run", async () => {
    const { client, comments, moves } = fakeClient();
    const { host, synced, emit } = fakeHost(makeGoal(REF));
    attachSync({ host, client, completeOnSuccess: false });

    emit("running");
    emit("running"); // resume — must not double-sync
    await settle();

    expect(moves).toEqual(["started"]);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("run `run-1`");
    expect(synced).toEqual([
      { action: "run_started", ok: true, detail: expect.any(String) },
    ]);
  });

  it("run done: summary comment with cost + branches; no state change by default", async () => {
    const { client, comments, moves } = fakeClient();
    const scope = { branch_name: "orc/goal/core" } as Scope;
    const { host, synced, emit } = fakeHost(makeGoal(REF), [scope]);
    attachSync({ host, client, completeOnSuccess: false });

    emit("done");
    emit("done");
    await settle();

    expect(moves).toEqual([]); // complete_on_success defaults off
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("$1.23");
    expect(comments[0]).toContain("`orc/goal/core`");
    expect(synced.map((s) => s.action)).toEqual(["run_succeeded"]);
  });

  it("run done with complete_on_success: moves to a completed-type state", async () => {
    const { client, moves } = fakeClient();
    const { host, emit } = fakeHost(makeGoal(REF));
    attachSync({ host, client, completeOnSuccess: true });
    emit("done");
    await settle();
    expect(moves).toEqual(["completed"]);
  });

  it("run failed: comments the reason and never changes state", async () => {
    const { client, comments, moves } = fakeClient();
    const { host, synced, emit } = fakeHost(makeGoal(REF));
    attachSync({ host, client, completeOnSuccess: true });

    emit("failed", "budget exceeded");
    await settle();

    expect(moves).toEqual([]);
    expect(comments[0]).toContain("failed: budget exceeded");
    expect(synced).toEqual([{ action: "run_failed", ok: true }]);
  });

  it("ignores runs whose goal has no linear external_ref", async () => {
    const { client, comments } = fakeClient();
    const other = makeGoal({ ...REF, provider: "jira" });
    const { host, synced, emit } = fakeHost(other);
    attachSync({ host, client, completeOnSuccess: false });

    emit("running");
    emit("done");
    await settle();

    expect(comments).toEqual([]);
    expect(synced).toEqual([]);
  });

  it("a Linear outage is swallowed and reported, never thrown (§R12)", async () => {
    const { client } = fakeClient({ fail: true });
    const { host, synced, emit } = fakeHost(makeGoal(REF));
    attachSync({ host, client, completeOnSuccess: false });

    emit("running");
    await settle();

    expect(synced).toEqual([
      { action: "run_started", ok: false, detail: "linear is down" },
    ]);
  });
});

describe("Linear plugin factory (spec 003 §R10)", () => {
  it("declares the manifest and comments on import via onTaskImported", async () => {
    const bodies: string[] = [];
    const fetchFn = (async (_url: unknown, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => {
        const parsed = JSON.parse(String(init?.body));
        bodies.push(parsed.variables?.body ?? "");
        return { data: { commentCreate: { success: true } } };
      },
    })) as unknown as typeof fetch;
    const plugin = createLinearPlugin({ fetchFn });
    expect(plugin.manifest).toMatchObject({
      name: "linear",
      apiVersion: 1,
      capabilities: ["task-provider"],
      secrets: ["LINEAR_API_KEY"],
    });

    const { host } = fakeHost(makeGoal(REF));
    await plugin.init(host);
    await plugin.onTaskImported?.(
      {
        provider: "linear",
        id: "uuid-1",
        identifier: "ENG-123",
        title: "Fix drift",
        description: "",
        url: REF.url,
        state: "Todo",
        labels: [],
        updated_at: "",
      },
      makeGoal(REF),
    );
    expect(bodies[0]).toContain("imported this issue as goal `goal-1`");
  });
});
