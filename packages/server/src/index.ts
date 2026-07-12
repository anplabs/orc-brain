/**
 * Local HTTP API + SSE server (§8, §10). REST for commands, SSE for the event
 * stream; also serves the SPA. Binds `127.0.0.1` only (§2). This is a thin
 * transport over the in-process {@link System} composition root.
 */

import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import type {
  BusEvent,
  ProjectExecutionMode,
  TaskQuery,
} from "@orc-brain/shared";
import {
  createSystem,
  registerSecretValue,
  registerStrippedEnvKeys,
  runDoctorSync,
  type System,
} from "@orc-brain/core";

/** Expands a leading `~` and resolves to an absolute path (spec 002 §R3). */
function resolveRepoRoot(input: string): string {
  const expanded =
    input === "~" || input.startsWith("~/")
      ? join(homedir(), input.slice(1))
      : input;
  return resolve(expanded);
}

/** True when `dir` is inside a git repository (spec 002 §R3). */
function isGitRepo(dir: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: dir,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Appends `.orc/` to the repo's `.gitignore` when one exists, so orc state
 * written inside a registered repo is never committed. A repo without a
 * `.gitignore` is left untouched — registration must not create files.
 */
function ensureOrcIgnored(repoRoot: string): void {
  const gitignore = join(repoRoot, ".gitignore");
  if (!existsSync(gitignore)) return;
  const content = readFileSync(gitignore, "utf8");
  const ignored = content
    .split("\n")
    .some((line) => /^\/?\.orc\/?$/.test(line.trim()));
  if (ignored) return;
  const sep = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  appendFileSync(gitignore, `${sep}.orc/\n`);
}

/** Options for {@link createServer}. */
export interface ServerOptions {
  /** Pre-built system; one is created from `stateDir` when omitted. */
  system?: System;
  /** State directory for SQLite + audit + reports. */
  stateDir?: string;
  /** Path to the built UI (`packages/ui/dist`), served as the SPA when present. */
  uiDist?: string;
  logger?: boolean;
}

/** Serializes a bus event as an SSE frame. */
function sseFrame(event: BusEvent): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Caps a provider call so an unresponsive tracker yields a readable 502, not
 * a hang (spec 003 §R7 — upstream timeout ≤ 15 s).
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`provider timed out after ${ms / 1000}s`)),
      ms,
    );
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Timeout for outbound provider calls (spec 003 §R7). */
const PROVIDER_TIMEOUT_MS = 15_000;

/** Builds the orc-brain HTTP server over an in-process orchestrator system. */
export function createServer(opts: ServerOptions = {}): FastifyInstance {
  const system = opts.system ?? createSystem({ stateDir: opts.stateDir });
  const { store, orchestrator } = system;

  const app = Fastify({ logger: opts.logger ?? true });
  void app.register(cors, {
    origin: /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
  });

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/api/doctor", async () => {
    const checks = runDoctorSync();
    // Orphaned worktrees (spec 002 §R12): on disk but not referenced by any
    // scope. Cleaned per project with `orc project gc <id>`.
    const orphans = system.worktrees.listOrphans(
      new Set(store.listActiveWorktreePaths()),
    );
    checks.push({
      name: "orphaned worktrees",
      ok: orphans.length === 0,
      detail: orphans.length
        ? `${orphans.length} orphan(s): ${orphans.join(", ")}`
        : "none",
    });
    return { checks };
  });

  // --- Projects (spec 002 §R3–§R5) ------------------------------------------

  app.get("/api/projects", async () => ({ projects: store.listProjects() }));

  app.post("/api/projects", async (req, reply) => {
    const body = req.body as {
      name?: string;
      repo_root?: string;
      execution_mode?: string;
      default_budget_usd?: number;
      default_concurrency?: number;
      auto_merge?: boolean;
    };
    if (!body.repo_root || typeof body.repo_root !== "string") {
      return reply.code(400).send({ error: "repo_root required" });
    }
    const repoRoot = resolveRepoRoot(body.repo_root);
    if (!existsSync(repoRoot) || !statSync(repoRoot).isDirectory()) {
      return reply
        .code(400)
        .send({ error: `repo_root is not a directory: ${repoRoot}` });
    }
    // A project must be a git repo: the env classifier and worktrees need git.
    if (!isGitRepo(repoRoot)) {
      return reply
        .code(400)
        .send({ error: `repo_root is not a git repository: ${repoRoot}` });
    }
    if (
      body.execution_mode !== undefined &&
      body.execution_mode !== "worktree" &&
      body.execution_mode !== "in_repo"
    ) {
      return reply
        .code(400)
        .send({ error: "execution_mode must be 'worktree' or 'in_repo'" });
    }
    if (store.getProjectByRepoRoot(repoRoot)) {
      return reply
        .code(409)
        .send({ error: `project already registered for ${repoRoot}` });
    }
    ensureOrcIgnored(repoRoot);
    const project = store.createProject({
      name: body.name?.trim() || basename(repoRoot),
      repo_root: repoRoot,
      auto_merge: body.auto_merge === true,
      execution_mode: (body.execution_mode ??
        "in_repo") as ProjectExecutionMode,
      default_budget_usd:
        typeof body.default_budget_usd === "number" &&
        body.default_budget_usd > 0
          ? body.default_budget_usd
          : 10,
      default_concurrency:
        typeof body.default_concurrency === "number" &&
        body.default_concurrency >= 1
          ? Math.floor(body.default_concurrency)
          : system.config.concurrency_limit,
    });
    return { project };
  });

  app.get("/api/projects/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = store.getProject(id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    const goals = store.listGoals().filter((g) => g.project_id === id);
    return { project, goals };
  });

  app.patch("/api/projects/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = store.getProject(id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    const body = req.body as {
      name?: string;
      repo_root?: string;
      execution_mode?: string;
      default_budget_usd?: number;
      default_concurrency?: number;
      auto_merge?: boolean;
    };
    if (body.repo_root !== undefined) {
      return reply.code(400).send({
        error: "repo_root cannot be changed; delete and re-add the project",
      });
    }
    if (
      body.execution_mode !== undefined &&
      body.execution_mode !== "worktree" &&
      body.execution_mode !== "in_repo"
    ) {
      return reply
        .code(400)
        .send({ error: "execution_mode must be 'worktree' or 'in_repo'" });
    }
    store.updateProject(id, {
      ...(body.name?.trim() ? { name: body.name.trim() } : {}),
      ...(body.execution_mode
        ? { execution_mode: body.execution_mode as ProjectExecutionMode }
        : {}),
      ...(typeof body.default_budget_usd === "number" &&
      body.default_budget_usd > 0
        ? { default_budget_usd: body.default_budget_usd }
        : {}),
      ...(typeof body.default_concurrency === "number" &&
      body.default_concurrency >= 1
        ? { default_concurrency: Math.floor(body.default_concurrency) }
        : {}),
      ...(typeof body.auto_merge === "boolean"
        ? { auto_merge: body.auto_merge }
        : {}),
    });
    return { project: store.getProject(id) };
  });

  app.delete("/api/projects/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = store.getProject(id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    const active = store.getActiveRunForRepo(project.repo_root);
    if (active) {
      return reply.code(409).send({
        error: `run ${active.id} is still active for this project; stop it first`,
      });
    }
    store.deleteProject(id);
    return { ok: true };
  });

  // Orphaned-worktree cleanup for one project (spec 002 §R12). Removes
  // worktree directories no scope references; never deletes unmerged
  // branches. With `prune_merged: true` (v2) it also deletes `orc/*`
  // branches fully merged into the current checkout (`git branch -d` only).
  app.post("/api/projects/:id/gc", async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = store.getProject(id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    const body = (req.body ?? {}) as { prune_merged?: boolean };
    const live = new Set(store.listActiveWorktreePaths());
    const removed: string[] = [];
    for (const orphan of system.worktrees.listOrphans(live)) {
      // Only touch orphans belonging to this project's runs; directories whose
      // run is unknown (deleted state) are treated as this project's on match.
      const runId = basename(join(orphan, ".."));
      const run = store.getRun(runId);
      const goal = run ? store.getGoal(run.goal_id) : null;
      if (goal && goal.project_id !== id) continue;
      system.worktrees.removeOrphan(orphan, project.repo_root);
      removed.push(orphan);
    }
    const pruned_branches = body.prune_merged
      ? system.worktrees.pruneMergedBranches(project.repo_root, "HEAD")
      : [];
    return { removed, pruned_branches };
  });

  // Feature-request flow (spec 002 §R4): one objective in, planning kicks off
  // immediately; the goal surfaces as `awaiting_approval` when the plan lands.
  app.post("/api/projects/:id/goals", async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = store.getProject(id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    const body = req.body as { objective?: string; title?: string };
    const objective = body.objective?.trim();
    if (!objective) {
      return reply.code(400).send({ error: "objective required" });
    }
    // Shared feature-flow entrypoint (spec 003 §R4): plugin imports use the
    // same code path, so the two cannot drift. Planning is fire-and-forget.
    const goal = orchestrator.createFeatureGoal(project, {
      objective,
      title: body.title,
    });
    return reply.code(202).send({ goal });
  });

  // --- Goals / scopes / tasks ---------------------------------------------

  app.get("/api/goals", async () => ({ goals: store.listGoals() }));

  app.post("/api/goals", async (req) => {
    const body = req.body as Parameters<typeof orchestrator.createGoal>[0];
    return { goal: orchestrator.createGoal(body) };
  });

  app.get("/api/goals/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const goal = store.getGoal(id);
    if (!goal) return reply.code(404).send({ error: "goal not found" });
    return {
      goal,
      scopes: store.listScopesByGoal(id),
      tasks: store.listTasksByGoal(id),
    };
  });

  app.post("/api/goals/:id/scopes", async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as Omit<
      Parameters<typeof orchestrator.createScope>[0],
      "goal_id"
    >;
    return { scope: orchestrator.createScope({ ...body, goal_id: id }) };
  });

  app.post("/api/scopes/:id/tasks", async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as Omit<
      Parameters<typeof orchestrator.createTask>[0],
      "scope_id"
    >;
    return { task: orchestrator.createTask({ ...body, scope_id: id }) };
  });

  app.post("/api/scopes/:id/approve", async (req) => {
    const { id } = req.params as { id: string };
    orchestrator.approveScope(id);
    return { ok: true };
  });

  // Run the Planner (§3): produces proposed scopes + pending tasks to approve.
  app.post("/api/goals/:id/plan", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.getGoal(id)) {
      return reply.code(404).send({ error: "goal not found" });
    }
    try {
      const { scopes, tasks } = await orchestrator.planGoal(id);
      return { scopes, tasks };
    } catch (err) {
      return reply.code(422).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // Replace an edited plan (`orc plan edit`): re-validate + re-materialize.
  app.put("/api/goals/:id/plan", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.getGoal(id)) {
      return reply.code(404).send({ error: "goal not found" });
    }
    try {
      const { scopes, tasks } = orchestrator.replacePlan(id, req.body);
      return { scopes, tasks };
    } catch (err) {
      return reply.code(422).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // Cancel a proposed plan (`orc plan cancel`): drops proposed scopes/tasks
  // and returns the goal to draft so it can be re-planned.
  app.delete("/api/goals/:id/plan", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.getGoal(id)) {
      return reply.code(404).send({ error: "goal not found" });
    }
    orchestrator.cancelPlan(id);
    return { ok: true, goal: store.getGoal(id) };
  });

  // Approve every proposed scope of a goal at once (`orc approve <goal-id>`).
  // With `start_run: true` (spec 002 §R5) the approval is the single human
  // gate: a run starts immediately with the project's defaults, unattended.
  app.post("/api/goals/:id/approve", async (req, reply) => {
    const { id } = req.params as { id: string };
    const goal = store.getGoal(id);
    if (!goal) {
      return reply.code(404).send({ error: "goal not found" });
    }
    const body = (req.body ?? {}) as { start_run?: boolean };
    const approved = orchestrator.approveGoal(id).map((s) => s.id);
    if (!body.start_run) return { approved };

    const project = goal.project_id ? store.getProject(goal.project_id) : null;
    if (!project) {
      return reply.code(400).send({
        error: "start_run requires a goal that belongs to a project",
        approved,
      });
    }
    try {
      const run = orchestrator.startRun(id, {
        budget_usd: project.default_budget_usd,
        concurrency_limit: project.default_concurrency,
        auto_loop: true,
      });
      system.autoLoop.setMode(run.id, "unattended");
      return { approved, run };
    } catch (err) {
      return reply.code(409).send({
        error: err instanceof Error ? err.message : String(err),
        approved,
      });
    }
  });

  // --- Runs ----------------------------------------------------------------

  app.get("/api/runs", async () => ({ runs: store.listRuns() }));

  app.post("/api/runs", async (req, reply) => {
    const body = req.body as {
      goal_id: string;
      budget_usd: number;
      concurrency_limit?: number;
    };
    if (!body.goal_id || typeof body.budget_usd !== "number") {
      return reply.code(400).send({ error: "goal_id and budget_usd required" });
    }
    try {
      return { run: orchestrator.startRun(body.goal_id, body) };
    } catch (err) {
      // A concurrent run on the same repo (§13.11) is a conflict, not a 500.
      return reply.code(409).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get("/api/runs/:id/status", async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = store.getRun(id);
    if (!run) return reply.code(404).send({ error: "run not found" });
    const goal = store.getGoal(run.goal_id);
    return {
      run,
      goal,
      scopes: goal ? store.listScopesByGoal(goal.id) : [],
      tasks: goal ? store.listTasksByGoal(goal.id) : [],
      task_counts: goal ? store.countTasksByStatus(goal.id) : {},
      in_flight: orchestrator.inFlight,
      spent_usd: store.sumCostForRun(id),
      open_escalations: store.listOpenEscalations(id).length,
      backpressure: {
        engaged: system.backpressure.isDispatchBlocked(),
        resets_at: system.backpressure.globalResetsAt() ?? null,
        quarantined: system.backpressure.quarantinedModels(),
      },
    };
  });

  app.get("/api/runs/:id/tasks", async (req) => {
    const { id } = req.params as { id: string };
    const { state } = req.query as { state?: string };
    const run = store.getRun(id);
    if (!run) return { tasks: [] };
    let tasks = store.listTasksByGoal(run.goal_id);
    if (state) tasks = tasks.filter((t) => t.status === state);
    return { tasks };
  });

  // Budget adjustment (§9 `orc budget set`). Thresholds stay config-level.
  app.post("/api/runs/:id/budget", async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = store.getRun(id);
    if (!run) return reply.code(404).send({ error: "run not found" });
    const body = req.body as { usd?: number };
    if (typeof body.usd === "number" && body.usd > 0) {
      store.updateRun(id, { budget_usd: body.usd });
      system.budget.refresh(id); // recompute budget_state against the new ceiling
    }
    return { run: store.getRun(id) };
  });

  // Autonomous-loop mode toggle (autonomous-loop.md §3.5, G6). `supervised`
  // keeps the human approval gate for re-planned scopes; `unattended` auto-
  // approves them (still bound by the safety layer, budget, and escalations).
  app.post("/api/runs/:id/mode", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.getRun(id))
      return reply.code(404).send({ error: "run not found" });
    const body = req.body as { mode?: string };
    if (body.mode !== "supervised" && body.mode !== "unattended") {
      return reply
        .code(400)
        .send({ error: "mode must be 'supervised' or 'unattended'" });
    }
    system.autoLoop.setMode(id, body.mode);
    return { run_id: id, mode: body.mode };
  });

  // --- Reports (§11) -------------------------------------------------------

  app.get("/api/runs/:id/reports", async (req) => {
    const { id } = req.params as { id: string };
    return { reports: store.listReports(id) };
  });

  app.post("/api/runs/:id/reports", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.getRun(id))
      return reply.code(404).send({ error: "run not found" });
    return { report: system.reporting.generate(id, "manual") };
  });

  app.get("/api/reports/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const report = store.getReport(id);
    if (!report) return reply.code(404).send({ error: "report not found" });
    return { report };
  });

  // --- Escalations / blocked queue (§8.5) ----------------------------------

  app.get("/api/blocked", async (req) => {
    const { run_id } = req.query as { run_id?: string };
    return { escalations: store.listOpenEscalations(run_id) };
  });

  app.post("/api/escalations/:id/resolve", async (req, reply) => {
    const { id } = req.params as { id: string };
    const esc = store.getEscalation(id);
    if (!esc) return reply.code(404).send({ error: "escalation not found" });
    const body = req.body as {
      action?: "deny_instruct" | "approve_once" | "skip_task";
      message?: string;
    };
    if (
      body.action !== "deny_instruct" &&
      body.action !== "approve_once" &&
      body.action !== "skip_task"
    ) {
      return reply.code(400).send({ error: "invalid action" });
    }
    orchestrator.resolveEscalation(id, body.action, body.message);
    return { ok: true };
  });

  app.post("/api/runs/:id/pause", async (req) => {
    const { id } = req.params as { id: string };
    await orchestrator.pause(id);
    return { ok: true };
  });

  app.post("/api/runs/:id/resume", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.getRun(id)) {
      return reply.code(404).send({ error: "run not found" });
    }
    orchestrator.resume(id);
    return { ok: true };
  });

  app.post("/api/panic", async () => {
    const runs = store
      .listRuns()
      .filter((r) => r.state === "running" || r.state === "pausing");
    await Promise.allSettled(runs.map((r) => orchestrator.panic(r.id)));
    return { ok: true, aborted: runs.map((r) => r.id) };
  });

  // Wipes the orc database (`orc purge`). Refused while any run is active or
  // workers are in flight — they would settle into deleted rows.
  app.post("/api/purge", async (req, reply) => {
    const active = store
      .listRuns()
      .filter((r) => r.state === "running" || r.state === "pausing");
    if (active.length > 0 || orchestrator.inFlight > 0) {
      return reply.code(409).send({
        error:
          `cannot purge: ${active.length} active run(s), ` +
          `${orchestrator.inFlight} worker(s) in flight — pause or panic first`,
      });
    }
    const body = (req.body ?? {}) as { keep_projects?: boolean };
    const deleted = store.purge({ keep_projects: body.keep_projects === true });
    return { deleted };
  });

  // --- Kanban board (spec 002 §R17) -----------------------------------------
  // Cards for every task of project goals whose run is non-terminal, plus the
  // most recent terminal run per project so finished work stays visible.
  app.get("/api/board", async (req) => {
    const { project_id } = req.query as { project_id?: string };
    const projects = store
      .listProjects()
      .filter((p) => !project_id || p.id === project_id);
    const goals = store.listGoals();
    const projectOfGoal = new Map(
      goals.filter((g) => g.project_id).map((g) => [g.id, g.project_id!]),
    );
    const runs = store.listRuns(); // newest first
    const terminal = (s: string) => s === "done" || s === "failed";

    // Allowed runs per spec: all non-terminal + newest terminal per project.
    const allowedRuns = new Set<string>();
    const seenTerminalOfProject = new Set<string>();
    for (const r of runs) {
      const pid = projectOfGoal.get(r.goal_id);
      if (!pid) continue;
      if (!terminal(r.state)) {
        allowedRuns.add(r.id);
      } else if (!seenTerminalOfProject.has(pid)) {
        seenTerminalOfProject.add(pid);
        allowedRuns.add(r.id);
      }
    }
    // Newest allowed run per goal carries the card's run association.
    const runOfGoal = new Map<string, string>();
    for (const r of runs) {
      if (!allowedRuns.has(r.id)) continue;
      if (!runOfGoal.has(r.goal_id)) runOfGoal.set(r.goal_id, r.id);
    }
    const cards = store
      .listBoardCards(project_id)
      .filter((c) => runOfGoal.has(c.goal_id))
      .map((c) => ({ ...c, run_id: runOfGoal.get(c.goal_id)! }));
    return { projects, cards };
  });

  // --- Tasks ---------------------------------------------------------------

  // Kanban reprioritization (spec 002 v2): higher priority dispatches first.
  // Only meaningful for tasks that have not started; others are refused.
  app.post("/api/tasks/:id/priority", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = store.getTask(id);
    if (!task) return reply.code(404).send({ error: "task not found" });
    const body = req.body as { priority?: number };
    if (typeof body.priority !== "number" || !Number.isFinite(body.priority)) {
      return reply.code(400).send({ error: "priority (number) required" });
    }
    if (task.status !== "pending" && task.status !== "queued") {
      return reply
        .code(409)
        .send({ error: `task is ${task.status}; only pending/queued reorder` });
    }
    store.setTaskPriority(id, Math.trunc(body.priority));
    // A running run picks the new order up on its next tick; kick it now.
    const scope = store.getScope(task.scope_id);
    const run = scope ? store.getActiveRunForGoal(scope.goal_id) : null;
    if (run?.state === "running") void orchestrator.tick(run.id);
    return { task: store.getTask(id) };
  });

  app.get("/api/tasks/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = store.getTask(id);
    if (!task) return reply.code(404).send({ error: "task not found" });
    return { task, subagents: store.listSubagentsByTask(id) };
  });

  // --- Plugins & task providers (spec 003 §R7, §R8) -------------------------

  app.get("/api/plugins", async () => {
    await system.plugins.ready;
    return { plugins: system.plugins.list() };
  });

  // Plugin secret set/unset (spec 003 §R8): value arrives in the body (never
  // argv), localhost-only like everything else. Newly set values are
  // registered for redaction/stripping immediately — no restart needed.
  app.post("/api/plugins/:name/secrets", async (req, reply) => {
    await system.plugins.ready;
    const { name } = req.params as { name: string };
    if (!system.plugins.has(name)) {
      return reply.code(404).send({ error: `unknown plugin "${name}"` });
    }
    const body = req.body as { key?: string; value?: string };
    if (!body.key || typeof body.value !== "string" || !body.value) {
      return reply.code(400).send({ error: "key and value required" });
    }
    try {
      system.secrets.set(body.key, body.value);
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
    registerStrippedEnvKeys([body.key]);
    registerSecretValue(body.value);
    return { ok: true, keys: system.secrets.listKeys() };
  });

  app.delete("/api/plugins/:name/secrets/:key", async (req, reply) => {
    await system.plugins.ready;
    const { name, key } = req.params as { name: string; key: string };
    if (!system.plugins.has(name)) {
      return reply.code(404).send({ error: `unknown plugin "${name}"` });
    }
    try {
      system.secrets.unset(key);
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return { ok: true, keys: system.secrets.listKeys() };
  });

  app.get("/api/providers", async () => {
    await system.plugins.ready;
    return { providers: system.plugins.listTaskProviders() };
  });

  app.get("/api/providers/:name/tasks", async (req, reply) => {
    await system.plugins.ready;
    const { name } = req.params as { name: string };
    const provider = system.plugins.getTaskProvider(name);
    if (!provider) {
      return reply.code(404).send({ error: `unknown provider "${name}"` });
    }
    const q = req.query as {
      search?: string;
      assigned_to_me?: string;
      state?: string;
      team?: string;
      limit?: string;
    };
    const query: TaskQuery = {
      ...(q.search ? { search: q.search } : {}),
      ...(q.assigned_to_me === "true" ? { assigned_to_me: true } : {}),
      ...(q.state ? { state: q.state } : {}),
      ...(q.team ? { team: q.team } : {}),
      ...(q.limit && Number.isFinite(Number(q.limit))
        ? { limit: Number(q.limit) }
        : {}),
    };
    try {
      const tasks = await withTimeout(
        provider.listTasks(query),
        PROVIDER_TIMEOUT_MS,
      );
      return { tasks };
    } catch (err) {
      // Upstream failure (bad token, outage, timeout) is a 502, never a hang.
      return reply.code(502).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // Import an external task as a goal (spec 003 §R7): resolves the task,
  // guards against duplicate imports, and funnels into the feature flow.
  app.post("/api/providers/:name/import", async (req, reply) => {
    await system.plugins.ready;
    const { name } = req.params as { name: string };
    const provider = system.plugins.getTaskProvider(name);
    if (!provider) {
      return reply.code(404).send({ error: `unknown provider "${name}"` });
    }
    const body = req.body as { external_id?: string; project_id?: string };
    if (!body.external_id || !body.project_id) {
      return reply
        .code(400)
        .send({ error: "external_id and project_id required" });
    }
    const project = store.getProject(body.project_id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    let task;
    try {
      task = await withTimeout(
        provider.getTask(body.external_id),
        PROVIDER_TIMEOUT_MS,
      );
    } catch (err) {
      return reply.code(502).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (!task) {
      return reply
        .code(404)
        .send({ error: `task "${body.external_id}" not found in ${name}` });
    }
    const existing = store.findActiveGoalByExternalRef(task.provider, task.id);
    if (existing) {
      return reply.code(409).send({
        error: `task ${task.identifier} is already imported as goal ${existing.id} (${existing.status})`,
        goal: existing,
      });
    }
    const goal = await system.plugins.importTask(name, task, project.id);
    return reply.code(202).send({ goal });
  });

  // --- SSE event stream (§10) ---------------------------------------------

  app.get("/api/events", (req, reply) => {
    const q = req.query as { run_id?: string; lastEventId?: string };
    const lastId = Number(req.headers["last-event-id"] ?? q.lastEventId ?? 0);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.hijack();

    // Replay anything the client missed since Last-Event-ID (§10 resume).
    for (const e of store.listEventsSince(lastId, q.run_id)) {
      reply.raw.write(sseFrame(e));
    }

    const unsubscribe = system.bus.subscribe((e) => {
      if (q.run_id && e.run_id !== q.run_id) return;
      reply.raw.write(sseFrame(e));
    });
    const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 15_000);

    req.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // --- Audit tail ----------------------------------------------------------

  app.get("/api/audit/:runId", async (req) => {
    const { runId } = req.params as { runId: string };
    const path = system.audit.filePathFor(runId);
    if (!existsSync(path)) return { events: [] };
    const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
    return { events: lines.map((l) => JSON.parse(l)) };
  });

  // --- SPA static hosting --------------------------------------------------

  const uiDist = opts.uiDist ?? join(process.cwd(), "packages/ui/dist");
  if (existsSync(join(uiDist, "index.html"))) {
    void app.register(fastifyStatic, { root: uiDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api") || req.url.startsWith("/health")) {
        return reply.code(404).send({ error: "not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}
