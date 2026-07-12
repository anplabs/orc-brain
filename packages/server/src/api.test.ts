/**
 * Server API tests for the project registry + feature flow (spec 002 §R3–§R5)
 * and the kanban board endpoint (§R17). Fastify `inject` — no sockets; fake
 * SDK streams — no real workers.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type { Goal, Plan, Project, Run } from "@orc-brain/shared";
import { createSystem, type System } from "@orc-brain/core";
import { createServer } from "./index.js";

/** Creates a git repo on branch `main` with one commit. */
function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "orc-repo-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "test@local");
  git("config", "user.name", "test");
  writeFileSync(join(repo, "README.md"), "hi\n");
  git("add", "-A");
  git("commit", "-m", "initial");
  return repo;
}

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
      tasks: [{ title: "do it", prompt: "do it", task_type: "mechanical" }],
    },
  ],
};

function fakeStream(extra: Record<string, unknown> = {}): Query {
  async function* gen() {
    yield { type: "system", subtype: "init", session_id: "s1", model: "haiku" };
    yield {
      type: "result",
      subtype: "success",
      total_cost_usd: 0.01,
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 5 },
      result: "ok",
      ...extra,
    };
  }
  return Object.assign(gen(), {
    interrupt: async () => {},
  }) as unknown as Query;
}

const systems: System[] = [];
afterEach(async () => {
  while (systems.length) systems.pop()!.close();
});

function buildApp() {
  const system = createSystem({
    stateDir: mkdtempSync(join(tmpdir(), "orc-state-")),
    queryFn: () => fakeStream(),
    planQueryFn: () => fakeStream({ structured_output: SAMPLE_PLAN }),
  });
  systems.push(system);
  const app = createServer({ system, logger: false, uiDist: "/nonexistent" });
  return { app, system };
}

async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("Projects API (spec 002 §R3)", () => {
  it("registers, lists, patches, and refuses duplicates / non-git paths", async () => {
    const { app } = buildApp();
    const repo = makeRepo();

    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { repo_root: repo, execution_mode: "worktree" },
    });
    expect(created.statusCode).toBe(200);
    const project = created.json().project as Project;
    expect(project.repo_root).toBe(repo);
    expect(project.execution_mode).toBe("worktree");
    expect(project.name.length).toBeGreaterThan(0);

    const dup = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { repo_root: repo },
    });
    expect(dup.statusCode).toBe(409);

    const notGit = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { repo_root: mkdtempSync(join(tmpdir(), "not-git-")) },
    });
    expect(notGit.statusCode).toBe(400);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      payload: { execution_mode: "in_repo", default_budget_usd: 20 },
    });
    expect(patched.json().project).toMatchObject({
      execution_mode: "in_repo",
      default_budget_usd: 20,
    });

    const list = await app.inject({ method: "GET", url: "/api/projects" });
    expect(list.json().projects).toHaveLength(1);

    const gone = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}`,
    });
    expect(gone.statusCode).toBe(200);
  });
});

describe("Feature flow (spec 002 §R4–§R5)", () => {
  it("objective → auto-plan → approve with start_run → unattended run", async () => {
    const { app, system } = buildApp();
    const repo = makeRepo();

    const projectRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        repo_root: repo,
        default_budget_usd: 7,
        default_concurrency: 1,
      },
    });
    const project = projectRes.json().project as Project;

    const goalRes = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/goals`,
      payload: { objective: "add a health endpoint" },
    });
    expect(goalRes.statusCode).toBe(202);
    const goal = goalRes.json().goal as Goal;
    expect(goal.project_id).toBe(project.id);
    expect(goal.repo_root).toBe(repo);

    // Planning was kicked fire-and-forget; the goal reaches awaiting_approval.
    await waitFor(
      () => system.store.getGoal(goal.id)?.status === "awaiting_approval",
    );

    const approve = await app.inject({
      method: "POST",
      url: `/api/goals/${goal.id}/approve`,
      payload: { start_run: true },
    });
    expect(approve.statusCode).toBe(200);
    const run = approve.json().run as Run;
    expect(run.budget_usd).toBe(7);
    expect(run.concurrency_limit).toBe(1);
    expect(run.auto_loop).toBe(true);

    // Board shows the project's cards (spec 002 §R17).
    const board = await app.inject({ method: "GET", url: "/api/board" });
    expect(board.json().cards.length).toBeGreaterThan(0);
    expect(board.json().cards[0]).toMatchObject({
      project_id: project.id,
      run_id: run.id,
    });
  });

  it("approve without a project refuses start_run", async () => {
    const { app, system } = buildApp();
    const goal = system.store.createGoal({
      title: "legacy",
      objective: "o",
      success_criteria: [],
      constraints: [],
      out_of_scope: [],
      repo_root: "/tmp/legacy",
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/goals/${goal.id}/approve`,
      payload: { start_run: true },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("v2: priority + gc prune_merged", () => {
  it("reprioritizes pending tasks and refuses settled ones", async () => {
    const { app, system } = buildApp();
    const goal = system.store.createGoal({
      title: "g",
      objective: "o",
      success_criteria: [],
      constraints: [],
      out_of_scope: [],
      repo_root: "/tmp/prio",
    });
    const scope = system.store.createScope({
      goal_id: goal.id,
      name: "s",
      description: "",
      path_allowlist: ["**"],
      path_denylist: [],
      allowed_tools: [],
      disallowed_tools: [],
      model_tier: "auto",
      environment: "development",
      permission_mode: "default",
      forbidden_actions: [],
      success_criteria: [],
      max_budget_usd: 1,
      depends_on: [],
    });
    const task = system.store.createTask({
      scope_id: scope.id,
      title: "t",
      prompt: "p",
      task_type: "mechanical",
      depends_on: [],
    });

    const ok = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/priority`,
      payload: { priority: 7 },
    });
    expect(ok.statusCode).toBe(200);
    expect(system.store.getTask(task.id)?.priority).toBe(7);

    system.store.updateTask(task.id, { status: "done" });
    const refused = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/priority`,
      payload: { priority: 1 },
    });
    expect(refused.statusCode).toBe(409);
  });

  it("gc with prune_merged deletes merged orc/* branches only", async () => {
    const { app } = buildApp();
    const repo = makeRepo();
    const projectRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { repo_root: repo },
    });
    const project = projectRes.json().project as Project;
    // A branch at HEAD is fully merged by definition.
    execFileSync("git", ["branch", "orc/g/merged"], { cwd: repo });

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/gc`,
      payload: { prune_merged: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().pruned_branches).toEqual(["orc/g/merged"]);
  });
});
