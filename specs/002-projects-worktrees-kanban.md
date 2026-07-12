<!--
  SPEC — for Claude Code / agent execution.
  Written for an executor who has NOT seen the originating conversation.
-->

# Spec: Projects, Worktree Isolation, Kanban Board & Subscription Pacing

> **Status:** Draft · **Owner:** Paulo Lima · **Date:** 2026-07-12 · **Target:** orc-brain monorepo (all packages)

## 1. Goal

Turn orc-brain from a single-repo, run-centric orchestrator into a **project-centric local
agent fleet**: the operator registers local repositories as _projects_, types a feature
objective ("I want feature X"), approves the generated plan once, and orc autonomously
executes it — in git worktrees when the project is configured for isolation — while the UI
shows a global kanban board of every agent's queue and live activity, and dispatch is paced
by a global concurrency cap and a tasks-per-hour throttle so the Claude Code subscription
is never hammered.

Subscription-only billing is already enforced and **must not regress** — this spec adds no
API-key paths.

## 2. Context & Background

- **Where this lives:** `/Users/paulo/git/anplabs/orc-brain` — pnpm monorepo,
  packages `shared ← core ← {server, cli}`, `ui ← shared`. Read `CLAUDE.md` first; its
  golden rules (subscription-only billing, constructor-injected safety, deny-first
  production, spec-wins) all apply here.
- **Read first:**
  - `packages/core/src/orchestrator.ts` — dispatch loop (`tick`), `dispatch()` (cwd is
    currently hard-wired to `goal.repo_root`, line ~523), run state machine, `startRun`
    (one-active-run-per-repo lock via `getActiveRunForRepo`).
  - `packages/core/src/workerManager.ts` — `WorkerSpec` (already has a `cwd` field),
    `spawn()`, env stripping via `buildSpawnEnv()` (`spawnEnv.ts`).
  - `packages/core/src/system.ts` — composition root (`createSystem`); wire new
    components here. Injectables: `queryFn`, `planQueryFn`, `judgeQueryFn`,
    `commandRunner`.
  - `packages/shared/src/{entities.ts,events.ts,config.ts,enums.ts}` — entity shapes, the
    `BusEvent` union (bump `SHARED_SCHEMA_VERSION` when it changes), `OrchestratorConfig`.
  - `packages/core/src/store/{schema.ts,index.ts}` — SQLite DDL + `Store` CRUD. Booleans
    are stored as `0/1` (see `rowToTask`).
  - `packages/core/src/{backpressure.ts,budgetTracker.ts,config.ts}` — existing reactive
    rate-limit holds, cost ledger, `DEFAULT_CONFIG`.
  - `packages/server/src/index.ts` — all REST routes + `/api/events` SSE.
  - `packages/ui/src/{App.tsx,dashboard.tsx,live.ts,api.ts}` — tab shell, flow-graph
    dashboard + inspector, SSE reducer (`liveReducer`, `EVENT_TYPES`), API client.
  - `git show HEAD:specs/001-orchestrator-spec.md` — the original spec (deleted from the
    working tree but in history). Its §8.4 designed worktree-per-scope isolation; this
    spec implements that design.
- **Current behavior:**
  - No "project" concept. A repo is registered implicitly by creating a Goal with
    `repo_root` (defaults to cwd). Goal lifecycle: `orc goal new` → `plan run` (Opus
    plan-only session → validated `Plan` → materialized scopes/tasks) → `approve` →
    `run start` → dispatch loop → optional auto-replan loop (`autoLoop.ts`).
  - Every worker, the planner, and the judge run with `cwd = goal.repo_root`. No
    worktrees anywhere in the code.
  - Concurrency is per-run only (`run.concurrency_limit`, checked in `tick`). There is
    **no global cap across runs** and **no proactive pacing**;
    `budget.max_tasks_per_run` / `max_tasks_per_hour` exist in config but are dead
    (defined, never enforced). `Backpressure` is reactive only (engages after a limit
    signal). `max_turns: 30` is hard-coded at dispatch (orchestrator.ts ~603).
  - UI: 5 tabs (Run dashboard / Plan / Reports / Audit / Settings). The dashboard already
    shows per-task live activity (status, `currentTool`, streaming transcript in the
    inspector). No kanban, no cross-run view. SSE is per-run
    (`/api/events?run_id=…` with `Last-Event-ID` replay).
  - Subscription-only auth is fully enforced: `buildSpawnEnv()` strips
    `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/Bedrock/Vertex vars from every child env;
    `checkProviderEnv` makes `orc serve` refuse to start if any is set;
    `liveAuthCheck` verifies `apiKeySource` via `orc doctor --live`.
- **Motivation:** The operator wants to point orc at several local repos, feed it feature
  objectives, and let agents work autonomously overnight on a Claude Code subscription —
  with visibility (kanban + live activity), isolation (worktrees so agents never trash a
  checked-out working tree), and pacing (so parallel fleets don't burn the subscription's
  rate limits).

## 3. Scope

**In scope**

1. **Project registry** — new `Project` entity, SQLite table, REST CRUD, CLI commands, UI
   screen; per-project execution mode (`worktree` | `in_repo`) and per-project run
   defaults (budget, concurrency).
2. **Feature-request flow** — create a goal _under a project_ from a single objective
   string; planning auto-starts; approving the plan auto-starts the run in unattended
   mode (single human gate).
3. **Worktree isolation** — new `WorktreeManager`: scope-level worktrees on
   `orc/<goal>/<scope>` branches when the project's mode is `worktree`; worktree removed
   on scope success, branch always kept for manual merge; worktree kept on failure for
   debugging.
4. **Pacing** — global concurrency cap across all runs + enforcement of the existing
   `max_tasks_per_hour` and `max_tasks_per_run` knobs; a new bus event so the UI can show
   "paced" state.
5. **Kanban board** — new global UI tab: status columns, cards for every task across
   active runs, project filter, click-through to the existing inspector; global SSE
   subscription (no `run_id`).

**Out of scope (explicit non-goals)**

- **No API-key / Bedrock / Vertex billing path.** Do not add any auth configuration.
- No auto-merge of scope branches (operator merges manually). No PR creation, no push to
  remotes.
- No drag-and-drop on the kanban (read-only v1; click opens inspector).
- No relaxation of the one-active-run-per-repo lock (worktrees would make concurrent runs
  per repo possible; deliberately deferred).
- No per-project autonomy modes beyond the existing run `supervised`/`unattended` toggle.
- No data migration for existing state dirs (see A1).
- No remote/multi-machine execution; server stays bound to `127.0.0.1`.
- No changes to the safety layer's deny rules (worktree cwd paths must flow through the
  existing path allowlist mechanics unchanged).

## 4. Requirements

**Functional — Projects & feature flow**

- R1: New entity `Project` in `shared/entities.ts`: `id`, `created_at`, `updated_at`,
  `name` (non-empty), `repo_root` (absolute path, unique), `execution_mode`
  (`"worktree" | "in_repo"`), `default_budget_usd` (number > 0), `default_concurrency`
  (int ≥ 1). New `projects` table in `store/schema.ts` + full `Store` CRUD
  (`createProject`, `getProject`, `listProjects`, `updateProject`, `deleteProject`).
- R2: `Goal` gains `project_id` (FK, required for new goals). `goal.repo_root` remains
  and is denormalized from the project at creation time, so all existing consumers
  (orchestrator, planner, judge, env classifier, run lock) keep working unchanged.
- R3: REST: `GET/POST /api/projects`, `GET/PATCH/DELETE /api/projects/:id`,
  `POST /api/projects/:id/goals`. `POST /api/projects` validates: path exists, is a
  directory, and `git rev-parse --git-dir` succeeds inside it (a project must be a git
  repo — the env classifier and worktrees both need git). Duplicate `repo_root` → 409.
  `DELETE` refuses (409) if the project has a non-terminal run.
- R4: `POST /api/projects/:id/goals` accepts `{ objective: string, title?: string }`,
  creates the goal (title defaults to a truncation of the objective), and **immediately
  kicks planning** (same code path as `POST /api/goals/:id/plan`, fire-and-forget).
  Response `202` with the goal. Existing goal/plan endpoints stay for compat.
- R5: `POST /api/goals/:id/approve` accepts optional body `{ start_run?: boolean }`. When
  true: after approval it starts a run using the project's `default_budget_usd` and
  `default_concurrency`, in **unattended** auto-loop mode (replan cycles do not wait for
  approval; escalations still block as today). The UI's approve button in the
  feature-request flow sends `start_run: true`.
- R6: CLI: `orc project add <path> [--name <n>] [--mode worktree|in_repo] [--budget <usd>]
[--concurrency <n>]`, `orc project list`, `orc project show <id>`,
  `orc project rm <id>`, and `orc feature <project-id> "<objective>"` (calls R4). Wire
  through `cli/src/client.ts`.

**Functional — Worktrees**

- R7: New `packages/core/src/worktrees.ts` exporting `WorktreeManager` with an injectable
  command runner (same pattern as `goalJudge`'s `commandRunner`). API (adapt names to
  taste, keep semantics):
  `ensureScopeWorktree(project, goal, scope, baseBranch) → { path, branch }`,
  `releaseScopeWorktree(scope, { keepOnDisk })`, `listOrphans(project)`.
- R8: Worktree lifecycle, for projects with `execution_mode === "worktree"`:
  - At `startRun`, record the repo's current branch on the run (`runs.base_branch`, new
    column) — this is the branch worktrees fork from and the branch the env classifier
    should classify (NOT the `orc/…` worktree branch; see R10).
  - Lazily, on the first dispatch of any task in a scope:
    `git worktree add <stateDir>/worktrees/<run_id>/<scope_id> -b orc/<goal-slug>/<scope-slug> <base_branch>`
    (slugs: kebab-case, ≤ 40 chars, collision-suffixed). Persist `worktree_path` and
    `branch_name` on the scope (new nullable columns).
  - Every worker (and only workers — planner/judge stay on `repo_root`) in that scope
    gets `cwd = worktree_path`.
  - On scope **done**: if the worktree is dirty, create a safety-net commit
    (`orc: auto-commit remaining changes for <scope>`), then `git worktree remove`
    (force after the commit). **The branch is always kept** — the operator merges
    manually. Surface the branch name in the scope-completion report section.
  - On scope **failed**: keep the worktree on disk for debugging; report its path.
  - `in_repo` projects behave exactly as today (cwd = `repo_root`, no branches created).
- R9: Worker prompts for worktree scopes get an appended instruction to commit their work
  on the current branch as they go (append in `dispatch()` where the prompt is
  assembled; keep it short and factual).
- R10: Environment classification for worktree scopes must use `run.base_branch`, not
  `gitBranch(worktree_cwd)` — otherwise every worktree run would classify as the
  `orc/…` branch. Audit both call sites (`orchestrator.ts` ~47, `autoLoop.ts` ~49).
- R11: Path safety: the scope's `path_allowlist` semantics must apply relative to the
  worktree cwd exactly as they do today relative to `repo_root` (verify against
  `safety/paths.ts`; add a test proving a deny outside the allowlist still denies inside
  a worktree).
- R12: `orc doctor` gains a check listing orphaned worktrees under
  `<stateDir>/worktrees/` (present on disk but not attached to a live scope), and
  `orc project gc <id>` removes them (`git worktree remove --force` + `git worktree
prune`). Never delete branches.

**Functional — Pacing**

- R13: New top-level config knob `global_concurrency_limit: number` in
  `OrchestratorConfig` (`shared/config.ts`) + `DEFAULT_CONFIG` (`core/config.ts`),
  default **4**. The dispatch loop must not start a worker when the number of running
  workers **across all runs** is at the cap. (Inspect `orchestrator.ts`: if
  `this.running` is already a global map, the check is `this.running.size`; if it is
  per-run, aggregate.)
- R14: Enforce the existing-but-dead `budget.max_tasks_per_hour`: a sliding 60-minute
  window of dispatch timestamps (in-memory in a new `packages/core/src/pacing.ts`,
  `DispatchPacer`, pure/testable: `recordDispatch(now)`, `check(now) → { ok } |
{ ok: false, resume_at }`). When throttled, `tick` schedules an unref'd timer to
  re-tick at `resume_at` (same pattern as `Backpressure.onClear`).
- R15: Enforce `budget.max_tasks_per_run`: count dispatches per run (store-derived or
  in-memory per run); at the cap, the run parks with a distinct pause reason (reuse the
  existing park mechanics from `autoLoop`).
- R16: New bus event `pacing.hold` in `shared/events.ts`
  (`payload: { reason: "global_concurrency" | "tasks_per_hour" | "tasks_per_run",
resume_at?: string, run_id? }`), published when dispatch is deferred by R13–R15 (edge-
  triggered, not every tick). Add to UI `EVENT_TYPES` + `liveReducer` and render a banner
  next to the existing backpressure banner. **Bump `SHARED_SCHEMA_VERSION`.**

**Functional — Kanban board**

- R17: New endpoint `GET /api/board?project_id=<optional>` returning every task belonging
  to goals of registered projects whose run is non-terminal (plus tasks of the most
  recent terminal run per project, so finished work is visible), shaped as:
  `{ projects: [...], cards: [{ task_id, title, status, project_id, project_name,
goal_id, goal_title, scope_name, run_id, model_used, attempt, cost_usd, current?:
string }] }`. One SQL join in `Store`; no N+1 over HTTP.
- R18: `GET /api/events` with **no** `run_id` streams events for all runs (fan-out of the
  existing per-run subscription). Global replay via `Last-Event-ID` is NOT required
  (seq is per-run); the board reconciles by re-fetching `/api/board` on reconnect and
  every 15 s as a fallback.
- R19: New "Board" tab in `App.tsx` (`packages/ui/src/board.tsx`): columns **Queued**
  (pending+queued), **Running**, **Blocked**, **Done**, **Failed** (skipped/cancelled
  appear in Done with a badge). Card shows task title, project name, scope, model badge
  (reuse dashboard's), attempt, cost, and — for running tasks — the live `currentTool`
  fed by the global SSE stream. Project filter dropdown. Clicking a card opens the
  existing `Inspector` for that task. Match `styles.css` conventions; no new UI deps.

**Functional — UI project & feature flow**

- R20: New "Projects" screen (list + add form: path, name, mode, defaults; remove
  button). Top-bar "New goal" for a selected project: single objective textarea →
  submits R4 → navigates to the existing Plan tab, which polls until the plan is
  `awaiting_approval` → Approve button sends `start_run: true` (R5) → navigates to the
  run dashboard.

**Non-functional**

- N1: **No billing regression.** `buildSpawnEnv()` continues to wrap every child process
  env, including all git subprocesses spawned by `WorktreeManager` (git needs no
  Anthropic vars, but strip anyway for uniformity). `preflight` checks unchanged.
- N2: All new decision logic (`DispatchPacer`, worktree path/branch derivation, board
  grouping) is pure and unit-testable, per the "deterministic core" convention.
- N3: New columns/tables follow existing store conventions (booleans as 0/1, column lists
  in INSERT/UPDATE kept in sync, `rowToX` coercions).
- N4: Every new file carries a top-of-file doc comment citing this spec's section
  numbers (house style).

## 5. Proposed Approach

- **Design overview:** Additive, four independent tracks after a shared foundation.
  Track A (projects + feature flow) is the foundation: entity → store → API/CLI → UI.
  Track B (worktrees) hangs off the project's `execution_mode` and touches only
  `dispatch()`'s cwd decision plus scope-settlement hooks. Track C (pacing) is two gate
  checks in `tick` plus a pure pacer. Track D (kanban) is a read-model endpoint + a new
  UI tab over the existing SSE machinery. Tracks B, C, D are parallelizable once A lands.
- **Files to create:**
  - `packages/core/src/worktrees.ts` + `worktrees.test.ts` (real git in `mkdtempSync`
    temp repos — `git init`, commit, then exercise add/remove/orphans; injectable runner
    for failure-path unit tests).
  - `packages/core/src/pacing.ts` + `pacing.test.ts` (pure; fake clock via `now`
    params — never `Date.now()` inside logic).
  - `packages/ui/src/board.tsx`.
  - `packages/core/src/projects.test.ts` (store CRUD + goal-under-project flow with fake
    `planQueryFn`).
- **Files to change:** `shared/entities.ts`, `shared/events.ts`, `shared/config.ts`,
  `shared/enums.ts` (if a status enum is needed for pause reason), `core/src/config.ts`,
  `core/src/store/schema.ts`, `core/src/store/index.ts`, `core/src/orchestrator.ts`
  (dispatch cwd, tick gates, base_branch, scope settlement), `core/src/system.ts` (wire
  `WorktreeManager` + `DispatchPacer`), `core/src/preflight.ts` (orphan check),
  `core/src/reporting.ts` (branch names in reports), `server/src/index.ts` (routes +
  global SSE), `cli/src/index.ts` + `cli/src/client.ts`, `ui/src/App.tsx`, `ui/src/api.ts`,
  `ui/src/live.ts`, `ui/src/styles.css`.
- **Data model / schema changes:** new `projects` table; `goals.project_id` (nullable in
  DDL for pre-existing rows, required by API validation); `runs.base_branch` (nullable);
  `scopes.worktree_path`, `scopes.branch_name` (nullable).
- **Contracts affected:** `BusEvent` union (+`pacing.hold` → bump
  `SHARED_SCHEMA_VERSION`); REST additions are backward-compatible; `/api/events` gains
  an all-runs mode when `run_id` is omitted (today that case should be checked — if it
  currently errors, this is purely additive).
- **Dependencies:** none new. Git is invoked via the same child-process pattern already
  used for `gitBranch`. No new UI libraries.

## 6. Constraints & Assumptions

- **Must follow:** `CLAUDE.md` in full — golden rules, ESM `.js` specifiers, no
  validation libraries (hand-written validators), spec-section doc comments, prettier
  defaults, `pnpm build && pnpm test && pnpm lint` green.
- **Must NOT change:** the `SafetyLayer` injection contract; `spawnEnv.ts` stripping;
  existing REST routes' shapes; the deny rules; the event-bus persist-before-fanout
  ordering; the one-run-per-repo lock.
- **Assumptions (confirm before relying on these):**
  - A1: **No migration of existing state dirs.** Pre-1.0, a fresh `.orc/` state dir is
    acceptable; new columns are added to the DDL directly (plus `ALTER TABLE … ADD
COLUMN` guards only if trivial). Existing goals without `project_id` are read-only
    legacy.
  - A2: The SDK worker honors `cwd` in `WorkerSpec` such that the spawned Claude Code
    subprocess operates in the worktree (the field exists and is plumbed; verify with
    one integration-style test).
  - A3: `git worktree` is available in every environment orc supports (git ≥ 2.30 is
    already a doctor check dependency; extend the doctor git check to assert worktree
    support if the version check doesn't already imply it).

## 7. Acceptance Criteria — Definition of Done

- [ ] `orc project add ~/git/paulo/dogfood-app --mode worktree` registers the project;
      `orc project list` shows it; adding the same path again returns 409.
- [ ] `orc feature <project-id> "add a health endpoint"` creates a goal under the
      project, planning starts without further commands, and the goal reaches
      `awaiting_approval` (observable via `orc goal show` / UI Plan tab).
- [ ] Approving with `start_run: true` starts a run using the project's default budget
      and concurrency, in unattended mode, with no further human action needed until
      done/escalation (verified in a test with fake `queryFn`/`planQueryFn`).
- [ ] For a `worktree` project: during a run, tasks execute with cwd under
      `<stateDir>/worktrees/<run>/<scope>` on branch `orc/<goal>/<scope>`; after scope
      success the worktree is gone, the branch exists in the repo with the scope's
      commits (including the auto-commit if the tree was dirty); after scope failure the
      worktree remains and its path appears in the report. Verified by
      `worktrees.test.ts` against a real temp git repo.
- [ ] For an `in_repo` project: behavior is byte-for-byte today's (cwd = repo_root, no
      branches created) — covered by an explicit regression test.
- [ ] Env classification during a worktree run uses `run.base_branch` (test: repo on
      `main` → worktree branch `orc/...` → environment still classifies as `main`'s).
- [ ] With `global_concurrency_limit: 2` and two runs each with `concurrency_limit: 2`,
      at most 2 workers run simultaneously across both runs (deterministic test with
      releasable-gate fake workers — see `hardening.test.ts` pattern).
- [ ] With `max_tasks_per_hour: N`, the N+1-th dispatch within the window is deferred, a
      `pacing.hold` event is published once, and dispatch resumes at `resume_at`
      (fake-clock unit test on `DispatchPacer` + one orchestrator integration test).
- [ ] `max_tasks_per_run` parks the run at the cap with a distinct pause reason.
- [ ] `GET /api/board` returns cards across two projects' runs; the Board tab renders 5
      columns, filters by project, shows `currentTool` on running cards via the global
      SSE stream, and opens the inspector on click.
- [ ] Subscription guardrails intact: `preflight`/`spawnEnv` tests still pass and a new
      test asserts `WorktreeManager`'s git subprocesses receive a stripped env.
- [ ] `pnpm build && pnpm test && pnpm lint` all green; `SHARED_SCHEMA_VERSION` bumped
      exactly once.

## 8. Test Plan

- **How to verify:** unit + integration via vitest with fake SDK streams (per
  `CLAUDE.md`: async generator yielding `system/init` then `result`, wrapped with
  `interrupt`); real git in `mkdtempSync` temp repos for worktree tests; fresh temp
  state dirs + `sys.close()` everywhere; releasable gates, never never-resolving
  promises. Manual smoke: `pnpm serve`, register a scratch repo, run the R20 flow.
- **Commands:** `pnpm build`, `pnpm test`, `pnpm lint`; single file:
  `pnpm exec vitest run packages/core/src/worktrees.test.ts` (from repo root — the
  include glob is root-relative).
- **Edge cases to cover:** dirty worktree at scope end (auto-commit path); branch-name
  collision (two scopes slugging identically); project path that is not a git repo
  (400); deleting a project with an active run (409); `git worktree add` failure
  (task must fail cleanly, not hang); pacer window boundary (dispatch exactly at
  window expiry); global SSE with zero active runs; board with legacy goals lacking
  `project_id` (excluded, no crash); orphan worktree detection after a simulated crash
  (dir on disk, no live scope).

## 9. Task Breakdown — execution plan

1. **Foundation (Track A):** `Project` entity + `goals.project_id` + schema + `Store`
   CRUD + tests. Then REST routes (R3–R5) + CLI (R6) + `projects.test.ts`.
2. **Feature flow UI (R20):** Projects screen, new-goal box, approve→start wiring.
3. **Worktrees (Track B):** `WorktreeManager` + tests (R7); orchestrator integration —
   `base_branch` on run, cwd decision in `dispatch()`, scope-settlement hooks, prompt
   suffix, env-classification fix (R8–R11); doctor/gc (R12); reporting mention.
4. **Pacing (Track C):** `DispatchPacer` + tests (R14); tick gates for global cap (R13)
   and per-run cap (R15); `pacing.hold` event + UI banner (R16); schema-version bump.
5. **Kanban (Track D):** `Store` board query + `GET /api/board` (R17); global SSE mode
   (R18); `board.tsx` + tab (R19).
6. **Hardening pass:** red-team-adjacent tests (worktree path-allowlist, stripped env for
   git), doctor checks, `pnpm build && pnpm test && pnpm lint`, update `README.md`
   command docs.

Each step is independently committable; 3–5 are parallelizable after 1.

## 10. Open Questions

- Q1: Should `orc project gc` also prune fully-merged `orc/*` branches (`git branch
--merged`)? Deferred to a follow-up; v1 never deletes branches. — **blocking? no**
- Q2: Multiple concurrent runs per repo (now safe-ish under worktrees)? Deliberately out
  of scope; revisit after v1. — **blocking? no**

## 11. Rollback / Risk

- **Risks:** (1) Worktree lifecycle bugs could strand dirty worktrees or lose uncommitted
  work — mitigated by the auto-commit safety net, keep-on-failure policy, and
  doctor/gc visibility. (2) The global SSE fan-out could regress per-run replay —
  mitigated by keeping the `run_id` path untouched and adding the all-runs mode as a
  separate branch in the handler. (3) Pacing gates in `tick` could deadlock dispatch if
  a resume timer is dropped — mitigated by the 15 s board poll being UI-only and, in
  core, by re-checking pacer state on every `tick` trigger (task settlement already
  re-kicks `tick`).
- **Rollback:** all features are additive and default-off in behavior: projects are
  opt-in (`in_repo` default preserves today's execution exactly), pacing defaults are
  permissive (`global_concurrency_limit: 4` ≥ today's per-run default of 3), and the
  board is a new tab. Reverting is dropping the new files and the small `orchestrator.ts`
  diffs; the schema additions are nullable columns plus one new table.

---

## 12. Follow-up (v2) — implemented

The three deferred items above were implemented in a follow-up pass:

- **Q1 resolved — merged-branch pruning + opt-in auto-merge.** `Project` gained
  `auto_merge` (default false). When on, a successfully settled scope branch is
  merged `--no-ff` into the run's `base_branch` — only if the checkout is on
  that branch and clean; a conflicted merge is aborted. Every skip/failure
  leaves the branch for manual merge (the default flow) and is audited
  (`auto_merge` / `auto_merge_skipped`). `orc project gc <id> --prune-merged`
  additionally deletes `orc/*` branches fully merged into the current checkout
  (`git branch -d` only — unmerged branches can never be deleted).
- **Q2 resolved — multiple runs per repo.** The §13.11 repo lock is relaxed for
  `worktree`-mode projects (scope isolation makes concurrent runs safe); a
  goal-level lock was added (one active run per goal, always). `in_repo`
  projects and legacy goals keep the repo-level lock.
- **Kanban drag-to-prioritize.** `Task.priority` (default 0, higher first,
  creation order as tiebreak) feeds `listTasksByGoal`'s ordering and therefore
  the dispatch loop. `POST /api/tasks/:id/priority` persists it (pending/queued
  only, 409 otherwise) and re-kicks the run's tick. The Board's Queued column
  is drag-and-droppable; a drop persists the whole column order as descending
  priorities.
