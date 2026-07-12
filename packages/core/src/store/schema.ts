/**
 * SQLite schema (§4, §12). WAL mode is enabled by the store for trivially
 * correct write ordering. JSON-typed columns are stored as TEXT and parsed on
 * read. The append-only audit log lives in JSONL, not here (§8.6).
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  name TEXT NOT NULL,
  repo_root TEXT NOT NULL UNIQUE,
  execution_mode TEXT NOT NULL,
  default_budget_usd REAL NOT NULL,
  default_concurrency INTEGER NOT NULL,
  auto_merge INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  success_criteria TEXT NOT NULL,
  constraints TEXT NOT NULL,
  out_of_scope TEXT NOT NULL,
  project_id TEXT,
  repo_root TEXT NOT NULL,
  status TEXT NOT NULL,
  external_ref TEXT
);
CREATE INDEX IF NOT EXISTS idx_goals_project ON goals(project_id);

CREATE TABLE IF NOT EXISTS scopes (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  goal_id TEXT NOT NULL REFERENCES goals(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  path_allowlist TEXT NOT NULL,
  path_denylist TEXT NOT NULL,
  allowed_tools TEXT NOT NULL,
  disallowed_tools TEXT NOT NULL,
  model_tier TEXT NOT NULL,
  environment TEXT NOT NULL,
  permission_mode TEXT NOT NULL,
  forbidden_actions TEXT NOT NULL,
  success_criteria TEXT NOT NULL,
  max_budget_usd REAL NOT NULL,
  status TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  worktree_path TEXT,
  branch_name TEXT
);
CREATE INDEX IF NOT EXISTS idx_scopes_goal ON scopes(goal_id);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  scope_id TEXT NOT NULL REFERENCES scopes(id),
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  task_type TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL,
  model_used TEXT,
  routing_reason TEXT,
  session_id TEXT,
  cost_usd REAL NOT NULL,
  result_summary TEXT,
  error TEXT,
  dirty INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tasks_scope ON tasks(scope_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS subagents (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  session_id TEXT,
  model TEXT NOT NULL,
  pid INTEGER,
  state TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  num_turns INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  last_tool_call TEXT,
  transcript_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_subagents_task ON subagents(task_id);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  goal_id TEXT NOT NULL REFERENCES goals(id),
  state TEXT NOT NULL,
  budget_usd REAL NOT NULL,
  budget_spent_usd REAL NOT NULL,
  budget_state TEXT NOT NULL,
  concurrency_limit INTEGER NOT NULL,
  started_at TEXT,
  paused_at TEXT,
  finished_at TEXT,
  pause_reason TEXT,
  base_branch TEXT,
  auto_loop INTEGER NOT NULL DEFAULT 0,
  replan_cycle INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_runs_goal ON runs(goal_id);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id),
  trigger TEXT NOT NULL,
  content_md TEXT NOT NULL,
  path TEXT
);
CREATE INDEX IF NOT EXISTS idx_reports_run ON reports(run_id);

CREATE TABLE IF NOT EXISTS budget_ledger (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  session_id TEXT,
  cost_usd REAL NOT NULL,
  num_turns INTEGER NOT NULL,
  model TEXT NOT NULL,
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  cache_read INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_run ON budget_ledger(run_id);
CREATE INDEX IF NOT EXISTS idx_ledger_task ON budget_ledger(task_id);

CREATE TABLE IF NOT EXISTS escalations (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  rule_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input_summary TEXT NOT NULL,
  stated_intent TEXT,
  status TEXT NOT NULL,
  action TEXT,
  message TEXT,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_escalations_run ON escalations(run_id);
CREATE INDEX IF NOT EXISTS idx_escalations_status ON escalations(status);

-- Bus events, persisted before fan-out for SSE Last-Event-ID replay (§3, §10).
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  run_id TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id);
`;

/**
 * Columns added after the initial DDL (spec 002 §5, A1). `CREATE TABLE IF NOT
 * EXISTS` skips existing tables, so a pre-002 database needs guarded ALTERs.
 * Each is applied best-effort; "duplicate column" failures are expected.
 */
export const MIGRATION_COLUMNS: ReadonlyArray<{
  table: string;
  column: string;
  ddl: string;
}> = [
  { table: "goals", column: "project_id", ddl: "TEXT" },
  { table: "scopes", column: "worktree_path", ddl: "TEXT" },
  { table: "scopes", column: "branch_name", ddl: "TEXT" },
  { table: "runs", column: "base_branch", ddl: "TEXT" },
  { table: "runs", column: "auto_loop", ddl: "INTEGER NOT NULL DEFAULT 0" },
  {
    table: "projects",
    column: "auto_merge",
    ddl: "INTEGER NOT NULL DEFAULT 0",
  },
  { table: "tasks", column: "priority", ddl: "INTEGER NOT NULL DEFAULT 0" },
  { table: "goals", column: "external_ref", ddl: "TEXT" },
];
