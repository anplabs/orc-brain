/**
 * Server API tests for the project registry + feature flow (spec 002 §R3–§R5)
 * and the kanban board endpoint (§R17). Fastify `inject` — no sockets; fake
 * SDK streams — no real workers.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import {
  PLUGIN_API_VERSION,
  type ExternalTask,
  type Goal,
  type OrcPluginModule,
  type Plan,
  type Project,
  type Run,
} from "@orc-brain/shared";
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

  it("appends .orc/ to an existing .gitignore on registration", async () => {
    const { app } = buildApp();
    const repo = makeRepo();
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n");

    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { repo_root: repo },
    });
    expect(res.statusCode).toBe(200);
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toBe(
      "node_modules/\n.orc/\n",
    );

    // Idempotent: registering again (different repo state) must not duplicate.
    const again = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { repo_root: repo },
    });
    expect(again.statusCode).toBe(409); // duplicate project, gitignore untouched
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toBe(
      "node_modules/\n.orc/\n",
    );
  });

  it("already-ignored and missing .gitignore are left untouched", async () => {
    const { app } = buildApp();

    const ignoredRepo = makeRepo();
    writeFileSync(join(ignoredRepo, ".gitignore"), ".orc\n");
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { repo_root: ignoredRepo },
    });
    expect(res.statusCode).toBe(200);
    expect(readFileSync(join(ignoredRepo, ".gitignore"), "utf8")).toBe(
      ".orc\n",
    );

    const bareRepo = makeRepo();
    const res2 = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { repo_root: bareRepo },
    });
    expect(res2.statusCode).toBe(200);
    expect(existsSync(join(bareRepo, ".gitignore"))).toBe(false);
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

describe("Plan cancel (§10 plan review)", () => {
  it("drops the proposed scopes and returns the goal to draft", async () => {
    const { app, system } = buildApp();
    const goal = system.store.createGoal({
      title: "g",
      objective: "o",
      success_criteria: [],
      constraints: [],
      out_of_scope: [],
      repo_root: "/tmp/cancel",
    });

    const planned = await app.inject({
      method: "POST",
      url: `/api/goals/${goal.id}/plan`,
    });
    expect(planned.statusCode).toBe(200);
    expect(system.store.listScopesByGoal(goal.id)).toHaveLength(1);
    expect(system.store.getGoal(goal.id)?.status).toBe("awaiting_approval");

    const cancelled = await app.inject({
      method: "DELETE",
      url: `/api/goals/${goal.id}/plan`,
    });
    expect(cancelled.statusCode).toBe(200);
    expect(system.store.listScopesByGoal(goal.id)).toHaveLength(0);
    expect(system.store.getGoal(goal.id)?.status).toBe("draft");
  });
});

describe("Purge (§9 orc purge)", () => {
  it("refuses while a run is active, then wipes once paused", async () => {
    const { app, system } = buildApp();
    const goal = system.store.createGoal({
      title: "g",
      objective: "o",
      success_criteria: [],
      constraints: [],
      out_of_scope: [],
      repo_root: "/tmp/purge",
    });
    const run = system.store.createRun({
      goal_id: goal.id,
      budget_usd: 5,
      concurrency_limit: 1,
    });

    const refused = await app.inject({ method: "POST", url: "/api/purge" });
    expect(refused.statusCode).toBe(409);

    system.store.updateRun(run.id, { state: "paused" });
    const ok = await app.inject({
      method: "POST",
      url: "/api/purge",
      payload: { keep_projects: true },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().deleted.runs).toBe(1);
    expect(system.store.listGoals()).toHaveLength(0);
    expect(system.store.listRuns()).toHaveLength(0);
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

// --- Plugins & providers (spec 003 §R7, §R8) ---------------------------------

const EXTERNAL_TASK: ExternalTask = {
  provider: "fake",
  id: "issue-1",
  identifier: "ENG-1",
  title: "Add health endpoint",
  description: "GET /health.",
  url: "https://tracker.example/ENG-1",
  state: "Todo",
  labels: [],
  updated_at: "2026-07-12T00:00:00.000Z",
};

function fakeProviderModule(opts: { fail?: boolean } = {}): OrcPluginModule {
  return {
    default: () => ({
      manifest: {
        name: "fake",
        version: "1.0.0",
        apiVersion: PLUGIN_API_VERSION,
        capabilities: ["task-provider"],
      },
      init() {},
      taskProvider: {
        listTasks: async () => {
          if (opts.fail) throw new Error("bad token");
          return [EXTERNAL_TASK];
        },
        getTask: async (id) =>
          id === EXTERNAL_TASK.id || id === EXTERNAL_TASK.identifier
            ? EXTERNAL_TASK
            : null,
      },
    }),
  };
}

function buildPluginApp(opts: { fail?: boolean } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "orc-state-"));
  writeFileSync(
    join(stateDir, "plugins.json"),
    JSON.stringify({
      plugins: [{ name: "fake", specifier: "/x/fake.js", enabled: true }],
    }),
  );
  const system = createSystem({
    stateDir,
    queryFn: () => fakeStream(),
    planQueryFn: () => fakeStream({ structured_output: SAMPLE_PLAN }),
    pluginModules: { fake: fakeProviderModule(opts) },
  });
  systems.push(system);
  const app = createServer({ system, logger: false, uiDist: "/nonexistent" });
  return { app, system, stateDir };
}

describe("Plugins & providers API (spec 003 §R7, §R8)", () => {
  it("lists plugins and providers; empty without plugins.json", async () => {
    const bare = buildApp();
    const noPlugins = await bare.app.inject({ url: "/api/plugins" });
    expect(noPlugins.json().plugins).toEqual([]);
    const noProviders = await bare.app.inject({ url: "/api/providers" });
    expect(noProviders.json().providers).toEqual([]);

    const { app } = buildPluginApp();
    const plugins = await app.inject({ url: "/api/plugins" });
    expect(plugins.json().plugins[0]).toMatchObject({
      name: "fake",
      status: "active",
    });
    const providers = await app.inject({ url: "/api/providers" });
    expect(providers.json().providers).toEqual([
      { name: "fake", capabilities: ["task-provider"] },
    ]);
  });

  it("lists provider tasks; upstream failure is a readable 502", async () => {
    const { app } = buildPluginApp();
    const ok = await app.inject({
      url: "/api/providers/fake/tasks?search=health&assigned_to_me=true",
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().tasks[0]).toMatchObject({ identifier: "ENG-1" });

    const missing = await app.inject({ url: "/api/providers/nope/tasks" });
    expect(missing.statusCode).toBe(404);

    const broken = buildPluginApp({ fail: true });
    const failed = await broken.app.inject({
      url: "/api/providers/fake/tasks",
    });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error).toMatch(/bad token/);
  });

  it("imports a task as a goal (202), guards duplicates (409), 404s unknowns", async () => {
    const { app, system } = buildPluginApp();
    const repo = makeRepo();
    const projectRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { repo_root: repo },
    });
    const project = projectRes.json().project as Project;

    const imported = await app.inject({
      method: "POST",
      url: "/api/providers/fake/import",
      payload: { external_id: "ENG-1", project_id: project.id },
    });
    expect(imported.statusCode).toBe(202);
    const goal = imported.json().goal as Goal;
    expect(goal.external_ref).toMatchObject({
      provider: "fake",
      identifier: "ENG-1",
    });
    // Planning kicked off through the shared feature flow (§R4).
    await waitFor(
      () => system.store.getGoal(goal.id)?.status === "awaiting_approval",
    );

    const dup = await app.inject({
      method: "POST",
      url: "/api/providers/fake/import",
      payload: { external_id: "issue-1", project_id: project.id },
    });
    expect(dup.statusCode).toBe(409);

    // Terminal goal frees the guard (§R7).
    system.store.updateGoalStatus(goal.id, "abandoned");
    const again = await app.inject({
      method: "POST",
      url: "/api/providers/fake/import",
      payload: { external_id: "issue-1", project_id: project.id },
    });
    expect(again.statusCode).toBe(202);

    const noTask = await app.inject({
      method: "POST",
      url: "/api/providers/fake/import",
      payload: { external_id: "ENG-404", project_id: project.id },
    });
    expect(noTask.statusCode).toBe(404);

    const noProject = await app.inject({
      method: "POST",
      url: "/api/providers/fake/import",
      payload: { external_id: "ENG-1", project_id: "missing" },
    });
    expect(noProject.statusCode).toBe(404);
  });

  it("sets and unsets plugin secrets through the API (spec 003 §R8)", async () => {
    const { app, system } = buildPluginApp();
    const set = await app.inject({
      method: "POST",
      url: "/api/plugins/fake/secrets",
      payload: { key: "FAKE_TOKEN", value: "secret-value-123456" },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().keys).toEqual(["FAKE_TOKEN"]);
    expect(system.secrets.get("FAKE_TOKEN")).toBe("secret-value-123456");

    const badKey = await app.inject({
      method: "POST",
      url: "/api/plugins/fake/secrets",
      payload: { key: "not_a_key", value: "v-123456" },
    });
    expect(badKey.statusCode).toBe(400);

    const unknown = await app.inject({
      method: "POST",
      url: "/api/plugins/nope/secrets",
      payload: { key: "K", value: "v-123456" },
    });
    expect(unknown.statusCode).toBe(404);

    const unset = await app.inject({
      method: "DELETE",
      url: "/api/plugins/fake/secrets/FAKE_TOKEN",
    });
    expect(unset.statusCode).toBe(200);
    expect(system.secrets.get("FAKE_TOKEN")).toBeUndefined();
  });
});
