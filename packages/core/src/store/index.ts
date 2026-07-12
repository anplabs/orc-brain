/**
 * State store (§4, §12): better-sqlite3 (WAL) for entities, indexes, and
 * resumable state, plus bus-event persistence for SSE replay. Synchronous
 * writes give trivially correct event ordering. The append-only JSONL audit
 * log is separate ({@link ./auditLog.ts}).
 */

import Database from "better-sqlite3";
import { ulid } from "ulid";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type {
  BudgetLedgerEntry,
  BusEvent,
  Escalation,
  Goal,
  Project,
  Report,
  Run,
  RunState,
  Scope,
  SubagentRecord,
  Task,
  TaskStatus,
} from "@orc-brain/shared";
import { MIGRATION_COLUMNS, SCHEMA_SQL } from "./schema.js";

type Row = Record<string, unknown>;

/** A kanban card row from the board join (spec 002 §R17). */
export interface BoardCardRow {
  task_id: string;
  title: string;
  status: TaskStatus;
  model_used: string | null;
  priority: number;
  attempt: number;
  cost_usd: number;
  scope_name: string;
  goal_id: string;
  goal_title: string;
  project_id: string;
  project_name: string;
}

const JSON_FIELDS = {
  goals: ["success_criteria", "constraints", "out_of_scope"],
  scopes: [
    "path_allowlist",
    "path_denylist",
    "allowed_tools",
    "disallowed_tools",
    "forbidden_actions",
    "success_criteria",
    "depends_on",
  ],
  tasks: ["depends_on", "result_summary", "error"],
  subagents: ["last_tool_call"],
} as const;

function nowIso(): string {
  return new Date().toISOString();
}

/** Serializes JSON columns of an entity into a flat row for SQLite. */
function serialize(obj: Row, jsonFields: readonly string[]): Row {
  const out: Row = { ...obj };
  for (const f of jsonFields) {
    if (f in out) out[f] = JSON.stringify(out[f] ?? null);
  }
  return out;
}

/** Parses JSON columns of a row back into an entity. */
function deserialize<T>(
  row: Row | undefined,
  jsonFields: readonly string[],
): T | null {
  if (!row) return null;
  const out: Row = { ...row };
  for (const f of jsonFields) {
    if (typeof out[f] === "string") out[f] = JSON.parse(out[f] as string);
  }
  return out as T;
}

/** The persistent state store. */
export class Store {
  private readonly db: Database.Database;
  /** Whether the store is initialized and ready for reads/writes. */
  readonly ready: boolean;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA_SQL);
    // Guarded ALTERs for pre-002 databases (spec 002 §5, A1): CREATE TABLE IF
    // NOT EXISTS skips existing tables, so late columns are added here.
    for (const m of MIGRATION_COLUMNS) {
      try {
        this.db.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.ddl}`);
      } catch {
        // Column already exists — expected on every start after the first.
      }
    }
    this.ready = true;
  }

  close(): void {
    this.db.close();
  }

  // --- Projects (spec 002 §R1) ---------------------------------------------

  createProject(
    input: Omit<Project, "id" | "created_at" | "updated_at" | "auto_merge"> &
      Partial<Pick<Project, "auto_merge">>,
  ): Project {
    const project: Project = {
      id: ulid(),
      created_at: nowIso(),
      updated_at: nowIso(),
      auto_merge: input.auto_merge ?? false,
      ...input,
    };
    const row = { ...project } as unknown as Row;
    row.auto_merge = project.auto_merge ? 1 : 0; // SQLite cannot bind booleans.
    this.db
      .prepare(
        `INSERT INTO projects (id, created_at, updated_at, name, repo_root,
          execution_mode, default_budget_usd, default_concurrency, auto_merge)
         VALUES (@id, @created_at, @updated_at, @name, @repo_root,
          @execution_mode, @default_budget_usd, @default_concurrency, @auto_merge)`,
      )
      .run(row);
    return project;
  }

  /** Deserializes a project row, coercing the integer `auto_merge` to boolean. */
  private rowToProject(row: Row | undefined): Project | null {
    if (!row) return null;
    const project = { ...row } as unknown as Project;
    project.auto_merge = !!row.auto_merge;
    return project;
  }

  getProject(id: string): Project | null {
    return this.rowToProject(
      this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row,
    );
  }

  getProjectByRepoRoot(repoRoot: string): Project | null {
    return this.rowToProject(
      this.db
        .prepare("SELECT * FROM projects WHERE repo_root = ?")
        .get(repoRoot) as Row,
    );
  }

  listProjects(): Project[] {
    return (
      this.db
        .prepare("SELECT * FROM projects ORDER BY created_at DESC")
        .all() as Row[]
    ).map((r) => this.rowToProject(r)!);
  }

  updateProject(id: string, patch: Partial<Project>): void {
    const current = this.getProject(id);
    if (!current) throw new Error(`updateProject: project ${id} not found`);
    const merged = { ...current, ...patch, updated_at: nowIso() };
    const row = { ...merged } as unknown as Row;
    row.auto_merge = merged.auto_merge ? 1 : 0; // SQLite cannot bind booleans.
    this.db
      .prepare(
        `UPDATE projects SET updated_at=@updated_at, name=@name,
          execution_mode=@execution_mode, default_budget_usd=@default_budget_usd,
          default_concurrency=@default_concurrency, auto_merge=@auto_merge
          WHERE id=@id`,
      )
      .run(row);
  }

  deleteProject(id: string): void {
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }

  // --- Goals ---------------------------------------------------------------

  createGoal(
    input: Omit<
      Goal,
      "id" | "created_at" | "updated_at" | "status" | "project_id"
    > &
      Partial<Pick<Goal, "status" | "project_id">>,
  ): Goal {
    const goal: Goal = {
      id: ulid(),
      created_at: nowIso(),
      updated_at: nowIso(),
      status: input.status ?? "draft",
      project_id: input.project_id ?? null,
      ...input,
    };
    this.db
      .prepare(
        `INSERT INTO goals (id, created_at, updated_at, title, objective,
          success_criteria, constraints, out_of_scope, project_id, repo_root, status)
         VALUES (@id, @created_at, @updated_at, @title, @objective,
          @success_criteria, @constraints, @out_of_scope, @project_id, @repo_root, @status)`,
      )
      .run(serialize(goal as unknown as Row, JSON_FIELDS.goals));
    return goal;
  }

  getGoal(id: string): Goal | null {
    return deserialize<Goal>(
      this.db.prepare("SELECT * FROM goals WHERE id = ?").get(id) as Row,
      JSON_FIELDS.goals,
    );
  }

  listGoals(): Goal[] {
    return (
      this.db
        .prepare("SELECT * FROM goals ORDER BY created_at DESC")
        .all() as Row[]
    ).map((r) => deserialize<Goal>(r, JSON_FIELDS.goals)!);
  }

  updateGoalStatus(id: string, status: Goal["status"]): void {
    this.db
      .prepare("UPDATE goals SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, nowIso(), id);
  }

  // --- Scopes --------------------------------------------------------------

  createScope(
    input: Omit<
      Scope,
      | "id"
      | "created_at"
      | "updated_at"
      | "status"
      | "worktree_path"
      | "branch_name"
    > &
      Partial<Pick<Scope, "status" | "worktree_path" | "branch_name">>,
  ): Scope {
    const scope: Scope = {
      id: ulid(),
      created_at: nowIso(),
      updated_at: nowIso(),
      status: input.status ?? "proposed",
      worktree_path: input.worktree_path ?? null,
      branch_name: input.branch_name ?? null,
      ...input,
    };
    this.db
      .prepare(
        `INSERT INTO scopes (id, created_at, updated_at, goal_id, name, description,
          path_allowlist, path_denylist, allowed_tools, disallowed_tools, model_tier,
          environment, permission_mode, forbidden_actions, success_criteria,
          max_budget_usd, status, depends_on, worktree_path, branch_name)
         VALUES (@id, @created_at, @updated_at, @goal_id, @name, @description,
          @path_allowlist, @path_denylist, @allowed_tools, @disallowed_tools, @model_tier,
          @environment, @permission_mode, @forbidden_actions, @success_criteria,
          @max_budget_usd, @status, @depends_on, @worktree_path, @branch_name)`,
      )
      .run(serialize(scope as unknown as Row, JSON_FIELDS.scopes));
    return scope;
  }

  getScope(id: string): Scope | null {
    return deserialize<Scope>(
      this.db.prepare("SELECT * FROM scopes WHERE id = ?").get(id) as Row,
      JSON_FIELDS.scopes,
    );
  }

  listScopesByGoal(goalId: string): Scope[] {
    return (
      this.db
        .prepare("SELECT * FROM scopes WHERE goal_id = ? ORDER BY created_at")
        .all(goalId) as Row[]
    ).map((r) => deserialize<Scope>(r, JSON_FIELDS.scopes)!);
  }

  updateScopeStatus(id: string, status: Scope["status"]): void {
    this.db
      .prepare("UPDATE scopes SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, nowIso(), id);
  }

  /** Records/clears a scope's worktree binding (spec 002 §R8). */
  setScopeWorktree(
    id: string,
    worktreePath: string | null,
    branchName: string | null,
  ): void {
    this.db
      .prepare(
        "UPDATE scopes SET worktree_path = ?, branch_name = ?, updated_at = ? WHERE id = ?",
      )
      .run(worktreePath, branchName, nowIso(), id);
  }

  /** Rewrites a scope's `depends_on` edges (used when materializing a plan). */
  setScopeDependsOn(id: string, dependsOn: string[]): void {
    this.db
      .prepare("UPDATE scopes SET depends_on = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(dependsOn), nowIso(), id);
  }

  listProposedScopesByGoal(goalId: string): Scope[] {
    return this.listScopesByGoal(goalId).filter((s) => s.status === "proposed");
  }

  /**
   * One row per task of every project goal, joined for the kanban board
   * (spec 002 §R17). One SQL join — the server adds run association on top.
   */
  listBoardCards(projectId?: string): BoardCardRow[] {
    return this.db
      .prepare(
        `SELECT t.id AS task_id, t.title AS title, t.status AS status,
           t.model_used AS model_used, t.priority AS priority,
           t.attempt AS attempt, t.cost_usd AS cost_usd,
           s.name AS scope_name, g.id AS goal_id, g.title AS goal_title,
           p.id AS project_id, p.name AS project_name
         FROM tasks t
         JOIN scopes s ON t.scope_id = s.id
         JOIN goals g ON s.goal_id = g.id
         JOIN projects p ON g.project_id = p.id
         WHERE (@pid IS NULL OR p.id = @pid)
         ORDER BY t.priority DESC, t.created_at`,
      )
      .all({ pid: projectId ?? null }) as BoardCardRow[];
  }

  /** Worktree paths still referenced by a scope — the non-orphans (spec 002 §R12). */
  listActiveWorktreePaths(): string[] {
    return (
      this.db
        .prepare(
          "SELECT worktree_path FROM scopes WHERE worktree_path IS NOT NULL",
        )
        .all() as { worktree_path: string }[]
    ).map((r) => r.worktree_path);
  }

  /**
   * Deletes every `proposed` scope of a goal and its tasks (used by `orc plan
   * edit` to re-materialize an edited plan). Only proposed scopes are touched,
   * so an approved/running plan is never disturbed.
   */
  deleteProposedPlan(goalId: string): void {
    const proposed = this.listProposedScopesByGoal(goalId);
    const delTasks = this.db.prepare("DELETE FROM tasks WHERE scope_id = ?");
    const delScope = this.db.prepare("DELETE FROM scopes WHERE id = ?");
    const tx = this.db.transaction((scopeIds: string[]) => {
      for (const id of scopeIds) {
        delTasks.run(id);
        delScope.run(id);
      }
    });
    tx(proposed.map((s) => s.id));
  }

  // --- Tasks ---------------------------------------------------------------

  createTask(
    input: Omit<
      Task,
      | "id"
      | "created_at"
      | "updated_at"
      | "status"
      | "priority"
      | "attempt"
      | "model_used"
      | "routing_reason"
      | "session_id"
      | "cost_usd"
      | "result_summary"
      | "error"
      | "dirty"
    > &
      Partial<Task>,
  ): Task {
    const task: Task = {
      id: ulid(),
      created_at: nowIso(),
      updated_at: nowIso(),
      status: "pending",
      priority: input.priority ?? 0,
      attempt: 0,
      model_used: null,
      routing_reason: null,
      session_id: null,
      cost_usd: 0,
      result_summary: null,
      error: null,
      dirty: false,
      ...input,
    };
    const row = serialize(task as unknown as Row, JSON_FIELDS.tasks);
    row.dirty = task.dirty ? 1 : 0; // SQLite cannot bind booleans.
    this.db
      .prepare(
        `INSERT INTO tasks (id, created_at, updated_at, scope_id, title, prompt,
          task_type, depends_on, status, priority, attempt, model_used, routing_reason,
          session_id, cost_usd, result_summary, error, dirty)
         VALUES (@id, @created_at, @updated_at, @scope_id, @title, @prompt,
          @task_type, @depends_on, @status, @priority, @attempt, @model_used, @routing_reason,
          @session_id, @cost_usd, @result_summary, @error, @dirty)`,
      )
      .run(row);
    return task;
  }

  /** Deserializes a task row, coercing the integer `dirty` column to boolean. */
  private rowToTask(row: Row | undefined): Task | null {
    const t = deserialize<Task>(row, JSON_FIELDS.tasks);
    if (t) t.dirty = !!(row as Row).dirty;
    return t;
  }

  getTask(id: string): Task | null {
    return this.rowToTask(
      this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row,
    );
  }

  listTasksByScope(scopeId: string): Task[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM tasks WHERE scope_id = ? ORDER BY priority DESC, created_at",
        )
        .all(scopeId) as Row[]
    ).map((r) => this.rowToTask(r)!);
  }

  // Priority-first ordering feeds the dispatch loop directly (spec 002 v2):
  // the kanban drag persists `priority` and the next tick honors it.
  listTasksByGoal(goalId: string): Task[] {
    return (
      this.db
        .prepare(
          `SELECT t.* FROM tasks t JOIN scopes s ON t.scope_id = s.id
           WHERE s.goal_id = ? ORDER BY t.priority DESC, t.created_at`,
        )
        .all(goalId) as Row[]
    ).map((r) => this.rowToTask(r)!);
  }

  /** Persists a kanban reprioritization (spec 002 v2). */
  setTaskPriority(id: string, priority: number): void {
    this.db
      .prepare("UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ?")
      .run(priority, nowIso(), id);
  }

  /** Partial task update. `result_summary`/`error` are JSON-serialized. */
  updateTask(id: string, patch: Partial<Task>): void {
    const current = this.getTask(id);
    if (!current) throw new Error(`updateTask: task ${id} not found`);
    const merged = { ...current, ...patch, updated_at: nowIso() };
    const row = serialize(merged as unknown as Row, JSON_FIELDS.tasks);
    row.dirty = merged.dirty ? 1 : 0; // SQLite cannot bind booleans.
    this.db
      .prepare(
        `UPDATE tasks SET updated_at=@updated_at, status=@status, priority=@priority, attempt=@attempt,
          model_used=@model_used, routing_reason=@routing_reason, session_id=@session_id,
          cost_usd=@cost_usd, result_summary=@result_summary, error=@error,
          dirty=@dirty WHERE id=@id`,
      )
      .run(row);
  }

  /** Rewrites a task's `depends_on` edges (used when materializing a plan). */
  setTaskDependsOn(id: string, dependsOn: string[]): void {
    this.db
      .prepare("UPDATE tasks SET depends_on = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(dependsOn), nowIso(), id);
  }

  countTasksByStatus(goalId: string): Partial<Record<TaskStatus, number>> {
    const rows = this.db
      .prepare(
        `SELECT t.status AS status, COUNT(*) AS n FROM tasks t
         JOIN scopes s ON t.scope_id = s.id WHERE s.goal_id = ? GROUP BY t.status`,
      )
      .all(goalId) as { status: TaskStatus; n: number }[];
    const out: Partial<Record<TaskStatus, number>> = {};
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  // --- Runs ----------------------------------------------------------------

  createRun(input: {
    goal_id: string;
    budget_usd: number;
    concurrency_limit: number;
    base_branch?: string | null;
    auto_loop?: boolean;
  }): Run {
    const run: Run = {
      id: ulid(),
      created_at: nowIso(),
      updated_at: nowIso(),
      goal_id: input.goal_id,
      state: "running",
      budget_usd: input.budget_usd,
      budget_spent_usd: 0,
      budget_state: "ok",
      concurrency_limit: input.concurrency_limit,
      started_at: nowIso(),
      paused_at: null,
      finished_at: null,
      pause_reason: null,
      base_branch: input.base_branch ?? null,
      auto_loop: input.auto_loop ?? false,
      replan_cycle: 0,
    };
    const row = { ...run } as Row;
    row.auto_loop = run.auto_loop ? 1 : 0; // SQLite cannot bind booleans.
    this.db
      .prepare(
        `INSERT INTO runs (id, created_at, updated_at, goal_id, state, budget_usd,
          budget_spent_usd, budget_state, concurrency_limit, started_at, paused_at,
          finished_at, pause_reason, base_branch, auto_loop, replan_cycle)
         VALUES (@id, @created_at, @updated_at, @goal_id, @state, @budget_usd,
          @budget_spent_usd, @budget_state, @concurrency_limit, @started_at, @paused_at,
          @finished_at, @pause_reason, @base_branch, @auto_loop, @replan_cycle)`,
      )
      .run(row);
    return run;
  }

  /** Deserializes a run row, coercing the integer `auto_loop` column to boolean. */
  private rowToRun(row: Row | undefined): Run | null {
    if (!row) return null;
    const run = { ...row } as unknown as Run;
    run.auto_loop = !!row.auto_loop;
    return run;
  }

  getRun(id: string): Run | null {
    return this.rowToRun(
      this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Row,
    );
  }

  getActiveRunForGoal(goalId: string): Run | null {
    return this.rowToRun(
      this.db
        .prepare(
          `SELECT * FROM runs WHERE goal_id = ? AND state IN
           ('running','pausing','paused','awaiting_approval','planning','draft')
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(goalId) as Row,
    );
  }

  listRuns(): Run[] {
    return (
      this.db
        .prepare("SELECT * FROM runs ORDER BY created_at DESC")
        .all() as Row[]
    ).map((r) => this.rowToRun(r)!);
  }

  /**
   * Returns an active run touching the same `repo_root` (§13.11): two runs on
   * one repo would race. `excludeRunId` skips the run being started.
   */
  getActiveRunForRepo(repoRoot: string, excludeRunId?: string): Run | null {
    const rows = (
      this.db
        .prepare(
          `SELECT r.* FROM runs r JOIN goals g ON r.goal_id = g.id
           WHERE g.repo_root = ? AND r.state IN ('running','pausing','paused')
           ORDER BY r.created_at DESC`,
        )
        .all(repoRoot) as Row[]
    ).map((r) => this.rowToRun(r)!);
    return rows.find((r) => r.id !== excludeRunId) ?? null;
  }

  updateRun(id: string, patch: Partial<Run>): void {
    const current = this.getRun(id);
    if (!current) throw new Error(`updateRun: run ${id} not found`);
    const merged = { ...current, ...patch, updated_at: nowIso() };
    const row = { ...merged } as unknown as Row;
    row.auto_loop = merged.auto_loop ? 1 : 0; // SQLite cannot bind booleans.
    this.db
      .prepare(
        `UPDATE runs SET updated_at=@updated_at, state=@state, budget_usd=@budget_usd,
          budget_spent_usd=@budget_spent_usd, budget_state=@budget_state,
          concurrency_limit=@concurrency_limit, started_at=@started_at, paused_at=@paused_at,
          finished_at=@finished_at, pause_reason=@pause_reason, base_branch=@base_branch,
          auto_loop=@auto_loop, replan_cycle=@replan_cycle
          WHERE id=@id`,
      )
      .run(row);
  }

  /** Demotes any Running/Pausing run to Paused on startup (§5 crash recovery). */
  demoteActiveRunsOnStartup(): Run[] {
    const active = this.db
      .prepare("SELECT * FROM runs WHERE state IN ('running','pausing')")
      .all() as Run[];
    for (const r of active) {
      this.updateRun(r.id, {
        state: "paused" as RunState,
        paused_at: nowIso(),
        pause_reason: "demoted after orchestrator restart (§5)",
      });
    }
    return active;
  }

  // --- Subagents -----------------------------------------------------------

  upsertSubagent(rec: SubagentRecord): void {
    this.db
      .prepare(
        `INSERT INTO subagents (id, created_at, updated_at, task_id, session_id, model,
          pid, state, started_at, ended_at, num_turns, cost_usd, last_tool_call, transcript_path)
         VALUES (@id, @created_at, @updated_at, @task_id, @session_id, @model,
          @pid, @state, @started_at, @ended_at, @num_turns, @cost_usd, @last_tool_call, @transcript_path)
         ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, session_id=excluded.session_id,
          pid=excluded.pid, state=excluded.state, started_at=excluded.started_at,
          ended_at=excluded.ended_at, num_turns=excluded.num_turns, cost_usd=excluded.cost_usd,
          last_tool_call=excluded.last_tool_call, transcript_path=excluded.transcript_path`,
      )
      .run(serialize(rec as unknown as Row, JSON_FIELDS.subagents));
  }

  listSubagentsByTask(taskId: string): SubagentRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM subagents WHERE task_id = ? ORDER BY created_at",
        )
        .all(taskId) as Row[]
    ).map((r) => deserialize<SubagentRecord>(r, JSON_FIELDS.subagents)!);
  }

  // --- Budget ledger -------------------------------------------------------

  insertLedgerEntry(
    input: Omit<BudgetLedgerEntry, "id" | "created_at" | "updated_at">,
  ): BudgetLedgerEntry {
    const entry: BudgetLedgerEntry = {
      id: ulid(),
      created_at: nowIso(),
      updated_at: nowIso(),
      ...input,
    };
    this.db
      .prepare(
        `INSERT INTO budget_ledger (id, created_at, updated_at, run_id, task_id, session_id,
          cost_usd, num_turns, model, tokens_in, tokens_out, cache_read, cache_write, recorded_at)
         VALUES (@id, @created_at, @updated_at, @run_id, @task_id, @session_id,
          @cost_usd, @num_turns, @model, @tokens_in, @tokens_out, @cache_read, @cache_write, @recorded_at)`,
      )
      .run(entry as unknown as Row);
    return entry;
  }

  sumCostForRun(runId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM budget_ledger WHERE run_id = ?",
      )
      .get(runId) as { total: number };
    return row.total;
  }

  sumCostForTask(taskId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM budget_ledger WHERE task_id = ?",
      )
      .get(taskId) as { total: number };
    return row.total;
  }

  // --- Reports -------------------------------------------------------------

  insertReport(
    input: Omit<Report, "id" | "created_at" | "updated_at">,
  ): Report {
    const report: Report = {
      id: ulid(),
      created_at: nowIso(),
      updated_at: nowIso(),
      ...input,
    };
    this.db
      .prepare(
        `INSERT INTO reports (id, created_at, updated_at, run_id, trigger, content_md, path)
         VALUES (@id, @created_at, @updated_at, @run_id, @trigger, @content_md, @path)`,
      )
      .run(report as unknown as Row);
    return report;
  }

  listReports(runId: string): Report[] {
    return this.db
      .prepare(
        "SELECT * FROM reports WHERE run_id = ? ORDER BY created_at DESC",
      )
      .all(runId) as Report[];
  }

  getReport(id: string): Report | null {
    return (
      (this.db
        .prepare("SELECT * FROM reports WHERE id = ?")
        .get(id) as Report) ?? null
    );
  }

  latestReport(runId: string): Report | null {
    return (
      (this.db
        .prepare(
          "SELECT * FROM reports WHERE run_id = ? ORDER BY created_at DESC LIMIT 1",
        )
        .get(runId) as Report) ?? null
    );
  }

  // --- Escalations (§8.5) --------------------------------------------------

  insertEscalation(
    input: Omit<
      Escalation,
      | "id"
      | "created_at"
      | "updated_at"
      | "status"
      | "action"
      | "message"
      | "resolved_at"
    >,
  ): Escalation {
    const esc: Escalation = {
      id: ulid(),
      created_at: nowIso(),
      updated_at: nowIso(),
      status: "open",
      action: null,
      message: null,
      resolved_at: null,
      ...input,
    };
    this.db
      .prepare(
        `INSERT INTO escalations (id, created_at, updated_at, run_id, task_id, rule_id,
          tool_name, input_summary, stated_intent, status, action, message, resolved_at)
         VALUES (@id, @created_at, @updated_at, @run_id, @task_id, @rule_id,
          @tool_name, @input_summary, @stated_intent, @status, @action, @message, @resolved_at)`,
      )
      .run(esc as unknown as Row);
    return esc;
  }

  getEscalation(id: string): Escalation | null {
    return (
      (this.db
        .prepare("SELECT * FROM escalations WHERE id = ?")
        .get(id) as Escalation) ?? null
    );
  }

  listOpenEscalations(runId?: string): Escalation[] {
    return (
      runId
        ? this.db
            .prepare(
              "SELECT * FROM escalations WHERE status = 'open' AND run_id = ? ORDER BY created_at",
            )
            .all(runId)
        : this.db
            .prepare(
              "SELECT * FROM escalations WHERE status = 'open' ORDER BY created_at",
            )
            .all()
    ) as Escalation[];
  }

  resolveEscalation(
    id: string,
    action: Escalation["action"],
    message: string | null,
  ): void {
    this.db
      .prepare(
        `UPDATE escalations SET status='resolved', action=?, message=?, resolved_at=?,
          updated_at=? WHERE id=?`,
      )
      .run(action, message, nowIso(), nowIso(), id);
  }

  // --- Events (SSE replay) -------------------------------------------------

  /** Persists a bus event before fan-out and returns its assigned `seq` (§3). */
  appendEvent(event: Omit<BusEvent, "seq">): number {
    const info = this.db
      .prepare(
        "INSERT INTO events (ts, run_id, type, payload) VALUES (?, ?, ?, ?)",
      )
      .run(event.ts, event.run_id, event.type, JSON.stringify(event.payload));
    return Number(info.lastInsertRowid);
  }

  /**
   * Dispatch events recorded for a run — the durable base of the per-run task
   * ceiling (spec 002 §R15). Counts every attempt, including retries.
   */
  countDispatchesForRun(runId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = 'dispatch'",
      )
      .get(runId) as { n: number };
    return row.n;
  }

  /** Returns persisted events with `seq` greater than `afterSeq` for SSE replay. */
  listEventsSince(afterSeq: number, runId?: string): BusEvent[] {
    const rows = (
      runId
        ? this.db
            .prepare(
              "SELECT * FROM events WHERE seq > ? AND run_id = ? ORDER BY seq",
            )
            .all(afterSeq, runId)
        : this.db
            .prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq")
            .all(afterSeq)
    ) as Row[];
    return rows.map((r) => ({
      seq: r.seq as number,
      ts: r.ts as string,
      run_id: (r.run_id as string) ?? null,
      type: r.type as BusEvent["type"],
      payload: JSON.parse(r.payload as string),
    })) as BusEvent[];
  }
}

/** Constructs the state store at `dbPath` (§4). */
export function createStore(dbPath: string): Store {
  return new Store(dbPath);
}

export { AuditLog, NullAuditLog, auditDirFor } from "./auditLog.js";
