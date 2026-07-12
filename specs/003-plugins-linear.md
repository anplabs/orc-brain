<!--
  SPEC — for Claude Code / agent execution.
  Written for an executor who has NOT seen the originating conversation.
-->

# Spec: Plugin System & Linear Integration (first plugin)

> **Status:** Draft · **Owner:** Paulo Lima · **Date:** 2026-07-12 · **Target:** orc-brain monorepo (all packages + one new package)

## 1. Goal

Give orc-brain a **first-class plugin system** so third parties can extend the
orchestrator without forking it, and ship **Linear as the first plugin**: the operator
connects a Linear workspace (API key), browses issues from the UI or CLI, picks an issue,
connects it to a registered project, and orc creates a goal from the issue and works on it
through the existing feature flow (plan → approve → run). While the work progresses, the
plugin syncs status back to the Linear issue (comments + state transitions).

The plugin API must be generic — Linear implements standardized **capabilities**
(`task-provider`, status sync) that any future tracker plugin (Jira, GitHub Issues, …)
can implement, and the UI/CLI import flow works against the capability, not against
Linear specifically.

Subscription-only billing is already enforced and **must not regress** — plugins add no
model-auth paths, and plugin secrets must never reach worker envs.

## 2. Context & Background

- **Where this lives:** `/Users/paulo/git/PauloPeregoHQ/orc-brain` — pnpm monorepo,
  packages `shared ← core ← {server, cli}`, `ui ← shared`, all named `@orc-brain/*`,
  ESM (`"type": "module"`), Node ≥ 22. Read `CLAUDE.md` first; its golden rules
  (subscription-only billing, constructor-injected safety, deny-first production,
  spec-wins) all apply here. `specs/002-projects-worktrees-kanban.md` is the previous
  spec and defines the project/feature flow this one builds on.
- **Read first:**
  - `packages/server/src/index.ts` — REST routes; **the seam this spec reuses** is
    `POST /api/projects/:id/goals` (~L260): body `{ objective, title? }` → creates a
    project-scoped goal (`orchestrator.createGoal`, denormalizing `project_id` +
    `repo_root`) → fire-and-forget `orchestrator.planGoal(goal.id)` → `202 { goal }`.
    Importing a Linear issue must funnel into this exact code path.
  - `packages/core/src/system.ts` — composition root (`createSystem`,
    `CreateSystemOptions` L46-60). All external I/O is constructor-injected
    (`queryFn`, `planQueryFn`, `judgeQueryFn`, `commandRunner`, `gitRunner`); the
    plugin host follows the same pattern (injectable `fetchFn` for tests).
  - `packages/core/src/eventBus.ts` — `EventBus.subscribe` is the generic fan-out point
    plugins observe; `publish` persists before fanning out (keep that ordering).
  - `packages/shared/src/{entities.ts,events.ts,config.ts,enums.ts}` — `Goal` (L56-67,
    has `project_id` + denormalized `repo_root`), `BusEvent` union (bump
    `SHARED_SCHEMA_VERSION` on change), `OrchestratorConfig`.
  - `packages/core/src/store/{schema.ts,index.ts}` — `CREATE TABLE IF NOT EXISTS` DDL +
    `MIGRATION_COLUMNS` guarded `ALTER TABLE` list (schema.ts L184-200); booleans as
    0/1; JSON columns as TEXT via the `JSON_FIELDS` map.
  - `packages/core/src/spawnEnv.ts` — `STRIPPED_ENV_KEYS` (Anthropic/Bedrock/Vertex
    vars) deleted from every worker env; plugin secrets extend this mechanism.
  - `packages/core/src/safety/redact.ts` — output redaction; plugin secrets must be
    registered here too.
  - `packages/ui/src/{App.tsx,projects.tsx,api.ts}` — nav groups, the per-project
    "Plan feature" textarea (`requestFeature` → `api.createFeatureGoal`) that the
    issue-import flow mirrors, API client conventions.
  - `packages/cli/src/{index.ts,client.ts}` — commander tree + fetch/SSE client.
- **Current behavior:**
  - **No plugin/extension mechanism exists** (verified by grep: no plugin, webhook, or
    hook registry anywhere). Closest seams are the DI injectables on `createSystem`,
    `EventBus.subscribe`, and `Orchestrator.setAutoLoop`.
  - **No HTTP client exists in any package** (no fetch/axios/undici usage in core or
    server; Node 22's global `fetch` is available but unused). A plugin's outbound
    Linear calls are the first orchestrator-process egress.
  - **No secret store and no config-file loader exist.** Config is
    `DEFAULT_CONFIG` + the single `ORC_FORCE_MODEL` env override. Provider creds
    (`ANTHROPIC_API_KEY` etc.) are stripped from workers and refuse `orc serve` at
    startup — so there is deliberately no home for an API token today; this spec
    creates one for _plugin_ (non-model) secrets only.
  - Work enters the system through the feature flow: `POST /api/projects/:id/goals`
    (UI "Plan feature" textarea / `orc feature`), then approve with
    `{ start_run: true }` for unattended execution.
- **Motivation:** orc-brain is open source; integrations (issue trackers first) should
  be community-extensible rather than baked into core. The operator's immediate need:
  drive orc from Linear — pick an issue, connect it to a repo/project, let the fleet
  work on it, and see progress reflected back in Linear.

## 3. Scope

**In scope**

1. **Plugin host** — a loader + registry in `core`: plugins are ESM modules declared in
   `<stateDir>/plugins.json`, dynamically imported at startup, initialized with a
   narrow `PluginHost` API (create goals via the feature flow, subscribe to the bus,
   read entities, get secrets/settings, audit log). Typed contract in `shared` so
   third-party plugins depend on `@orc-brain/shared` only.
2. **Capability model** — plugins declare capabilities; v1 standardizes one:
   `task-provider` (list/get external tasks, normalize to `ExternalTask`). Generic REST
   (`/api/providers/...`), CLI, and UI import flows are built against the capability.
3. **Plugin secrets** — file-based secret store (`<stateDir>/secrets.json`, mode 0600),
   CLI to set/unset, redaction registration, and worker-env stripping of every
   plugin-declared secret env key.
4. **Linear plugin** — new package `@orc-brain/plugin-linear` (bundled, but loaded
   through the same public plugin mechanism — dogfooding): Linear GraphQL API via
   native `fetch`, `task-provider` capability (browse/filter issues), issue → goal
   import (stores the back-reference), and status sync back (comment on the issue and
   move its workflow state on run start / done / failed).
5. **External linkage on goals** — `goals.external_ref` (nullable JSON) recording
   `{ provider, id, identifier, url, title }` so the UI/reports can show and link the
   origin issue.
6. **Surfaces** — REST endpoints, `orc plugin …` / `orc provider …` CLI commands, and a
   UI import flow (browse provider tasks → pick issue + project → import) plus plugin
   list/status in Settings.

**Out of scope (explicit non-goals)**

- **No model-auth paths.** Plugins cannot configure Anthropic/Bedrock/Vertex auth; the
  startup refusal (`checkProviderEnv`) and `buildSpawnEnv` stripping are untouched
  (only extended with more keys to strip).
- **No inbound webhooks.** The server stays bound to `127.0.0.1`; Linear cannot call
  in. Sync is outbound-only; issue _discovery_ is on-demand (manual browse/import), not
  polled. Automatic import (label-triggered polling) is deferred (see Q2).
- **No plugin sandboxing.** v1 plugins run in-process with the orchestrator's
  privileges (documented as a trust decision — see §11). No worker/vm isolation.
- **No plugin-contributed UI panels or REST routes.** The UI/CLI only knows the
  standardized capabilities; a plugin cannot register arbitrary endpoints or screens
  in v1.
- **No OAuth.** Linear auth is a personal API key (see A2).
- **No marketplace/registry, no version/compat negotiation beyond a single
  `apiVersion: 1` check.**
- **No two-way field sync** (title/description edits in Linear after import are not
  pulled; the goal is a snapshot). No attachment/branch-link creation in Linear (v2
  candidate).
- **No changes to planner/judge/worker behavior** — an imported goal is
  indistinguishable from a typed feature request downstream of creation (except for
  `external_ref`).

## 4. Requirements

**Functional — Plugin contract (`shared`)**

- R1: New `packages/shared/src/plugins.ts` (exported from `shared/src/index.ts`) with
  **types only** (no logic, per shared's convention):
  - `PLUGIN_API_VERSION = 1` (exported const).
  - `PluginManifest`: `{ name: string /* kebab-case, unique */, version: string,
apiVersion: number, capabilities: PluginCapability[], secrets?: string[]
/* env-style key names, e.g. "LINEAR_API_KEY" */ }`.
  - `PluginCapability = "task-provider"` (union of one, room to grow).
  - `ExternalTask`: `{ provider: string, id: string, identifier: string /* e.g.
"ENG-123" */, title: string, description: string, url: string, state: string,
assignee?: string, labels: string[], updated_at: string }`.
  - `ExternalRef`: `{ provider: string, id: string, identifier: string, url: string,
title: string }`.
  - `TaskProvider`: `{ listTasks(query: TaskQuery): Promise<ExternalTask[]>,
getTask(id: string): Promise<ExternalTask | null> }` with
    `TaskQuery = { search?: string, assigned_to_me?: boolean, state?: string,
team?: string, limit?: number }`.
  - `PluginHost` (interface implemented by core): `{ log(msg): void,
audit(action, detail): void, reportSync(action, { ref?, ok, detail?, run_id? }):
void /* audits AND publishes plugin.sync (R9) */, getSecret(key): string |
undefined, settings: Record<string, unknown>, subscribe(fn: (e: BusEvent) =>
void): () => void, listProjects(): Promise<Project[]>, getGoal(id):
Promise<Goal | null>, getRun(id): Promise<Run | null>,
listScopesByGoal(goalId): Promise<Scope[]> /* branch names for R12 summaries */,
createGoalFromExternalTask(projectId: string, task: ExternalTask):
Promise<Goal> }`.
  - `OrcPlugin`: `{ manifest: PluginManifest, init(host: PluginHost): Promise<void> |
void, close?(): Promise<void> | void, taskProvider?: TaskProvider,
onTaskImported?(task, goal): Promise<void> | void /* fired by the registry
after an import — the R12 import comment */ }`.
  - `OrcPluginModule`: a module whose default export is
    `(settings: Record<string, unknown>) => OrcPlugin` (factory, so tests can
    construct plugins directly).
- R2: `Goal` gains `external_ref: ExternalRef | null` (`shared/entities.ts`); new
  nullable TEXT column via `MIGRATION_COLUMNS` + `JSON_FIELDS` registration; carried
  through `Store` create/read/update and returned by all existing goal endpoints
  unchanged in shape otherwise.

**Functional — Plugin host (`core`)**

- R3: New `packages/core/src/plugins/registry.ts` exporting `PluginRegistry`:
  - Constructed by `createSystem` with `{ store, bus, audit, orchestrator-facade,
secrets, fetchFn? }`. **Injectable loader**: `createSystem` gains
    `pluginModules?: Record<string, OrcPluginModule>` (tests inject fakes; no dynamic
    import in tests) and `pluginsFile?: string` (defaults to
    `<stateDir>/plugins.json`).
  - Declaration file `<stateDir>/plugins.json`:
    `{ plugins: [{ name, specifier, enabled, settings? }] }`. `specifier` is an
    absolute path to an ESM module **or** a builtin alias (v1 builtins:
    `"linear"` → `@orc-brain/plugin-linear`, resolved via `import.meta.resolve` from
    core). Malformed file or a plugin that throws on import/init → log + audit the
    error, mark the plugin `status: "error"`, **continue booting** (a broken plugin
    must never take the orchestrator down).
  - Validates `manifest.apiVersion === PLUGIN_API_VERSION` (mismatch → `error` status,
    not loaded), unique names, kebab-case name.
  - `list(): PluginStatus[]` (`{ name, version, capabilities, enabled, status:
"active" | "disabled" | "error", error? }`), `getTaskProvider(name)`,
    `listTaskProviders()`, `closeAll()` (called from `system.close()`).
- R4: `PluginHost.createGoalFromExternalTask` reuses the **feature-flow code path**:
  create the goal under the project with `title = task.identifier + ": " + task.title`
  (truncated to the same limit the feature flow uses), `objective` = the issue
  description prefixed by the title line (plus the issue URL as a constraint-free
  context line), `external_ref` populated, then fire-and-forget `planGoal` exactly like
  `POST /api/projects/:id/goals` does. Extract the shared logic into one function
  (e.g. `core` exposes `createFeatureGoal(projectId, { objective, title,
external_ref? })`) so server route and plugin host cannot drift.
- R5: **Secrets.** New `packages/core/src/plugins/secrets.ts`: `SecretStore` over
  `<stateDir>/secrets.json` (created with mode 0600; refuse-and-warn if an existing
  file is group/world-readable), API `get/set/unset/list-keys` (values never listed).
  Resolution order for `host.getSecret(key)`: secrets file, then `process.env[key]`
  fallback. Every key named in any loaded plugin's `manifest.secrets`:
  - is added to the worker-env strip set (extend `buildSpawnEnv` to accept extra keys,
    or export a registration function — workers must never see `LINEAR_API_KEY`);
  - is registered with `safety/redact.ts` so its _value_ is redacted from transcripts,
    logs, and audit entries.
- R6: **Audit.** Every externally-visible plugin action (goal import, Linear comment,
  Linear state change, sync failure) goes through `host.audit(action, detail)` into
  the existing `AuditLog` JSONL with `actor: "plugin:<name>"`.

**Functional — Provider REST + CLI**

- R7: REST additions (`server/src/index.ts`):
  - `GET /api/plugins` → `PluginStatus[]` (R3).
  - `GET /api/providers` → `[{ name, capabilities }]` for active `task-provider`
    plugins.
  - `GET /api/providers/:name/tasks?search=&assigned_to_me=&state=&team=&limit=` →
    `ExternalTask[]`; 404 unknown provider, 502 with a readable message when the
    upstream call fails (e.g. bad token), never a hang (upstream timeout ≤ 15 s).
  - `POST /api/providers/:name/import` body `{ external_id: string, project_id:
string }` → resolves the task via `getTask`, calls R4, returns `202 { goal }`
    (mirrors the feature-flow response). 404 unknown provider/task/project; 409 if a
    non-terminal goal with the same `external_ref.provider + id` already exists
    (duplicate-import guard, checked via a `Store` query on the JSON column).
- R8: CLI (`cli/src/{index.ts,client.ts}`):
  - `orc plugin list` — table of name/version/capabilities/status.
  - `orc plugin add <specifier> [--name <n>] [--disable]` /
    `orc plugin rm <name>` / `orc plugin enable|disable <name>` — edit `plugins.json`
    (server picks changes up on restart; the commands say so).
  - `orc plugin secret set <plugin> <KEY>` — prompts for the value on stdin (never an
    argv argument — argv leaks to `ps`), writes via a new
    `POST /api/plugins/:name/secrets` route (body `{ key, value }`, localhost-only
    like everything else); `orc plugin secret unset <plugin> <KEY>`.
  - `orc provider tasks <name> [--search <q>] [--mine] [--state <s>] [--team <t>]` —
    lists tasks (identifier, title, state, url).
  - `orc provider import <name> <external-id> --project <project-id>` — calls R7
    import and prints the created goal id (then the existing
    `orc plan show` / `orc approve --start` flow applies).
- R9: New bus event `plugin.sync` in `shared/events.ts`
  (`payload: { plugin: string, action: string, ref?: ExternalRef, ok: boolean,
detail?: string }`), published by the host when a plugin reports a sync action
  (R12). Add to UI `EVENT_TYPES`/`liveReducer`. **Bump `SHARED_SCHEMA_VERSION`.**

**Functional — Linear plugin (`@orc-brain/plugin-linear`)**

- R10: New package `packages/plugin-linear` (`@orc-brain/plugin-linear`), depending on
  `@orc-brain/shared` **only** (this proves third-party viability). Default export =
  plugin factory (R1). Manifest: `{ name: "linear", capabilities: ["task-provider"],
secrets: ["LINEAR_API_KEY"] }`. Linear GraphQL API
  (`https://api.linear.app/graphql`, header `Authorization: <key>`) via an injectable
  `fetchFn` (defaults to global `fetch`) — hand-written GraphQL query strings, **no
  `@linear/sdk` dependency** (matches the house "no validation library" minimalism).
- R11: `taskProvider` implementation:
  - `listTasks`: issues filtered by `TaskQuery` (search → Linear's `searchableContent`
    /title filter; `assigned_to_me` → viewer's assigned issues; `state`/`team` by
    name; default: non-completed, non-canceled issues, `limit` default 25, ordered by
    `updatedAt` desc). Maps to `ExternalTask` (id = Linear issue UUID, identifier =
    `TEAM-123`, state = workflow-state name, url = issue URL).
  - `getTask(id)`: accepts either the UUID **or** the human identifier (`ENG-123`);
    returns full description (markdown as-is).
- R12: **Status sync back** (via `host.subscribe`), only for goals whose
  `external_ref.provider === "linear"`, each action audited (R6) and published as
  `plugin.sync` (R9); every Linear call is fire-and-forget with error-swallow +
  audit — **a Linear outage must never affect a run**:
  - On import (once, from `init`-time subscription seeing the goal or directly after
    `createGoalFromExternalTask`): comment on the issue — "orc-brain imported this
    issue as goal `<id>` and is planning."
  - On the goal's first run entering `running` (`run.state` event): move the issue to
    the workspace's `started`-type state (Linear state `type == "started"`, first
    match) and comment with the run id.
  - On run terminal success (`run.state` → succeeded/`goal_evaluated` met): comment
    with a short summary — goal title, cost, and scope branch names if present in the
    report — and move the issue to the `started→completed`… **no**: move to the first
    state of type `"completed"` **only if** plugin setting
    `complete_on_success: true` (default **false**; default behavior is a comment
    only — a human verifies before closing).
  - On run failure/abandonment: comment with the failure reason; never change state.
  - State transitions are resolved by Linear state **type** (`started`, `completed`),
    not hardcoded names, so any workspace works.
- R13: The plugin ships in the repo, is built by `pnpm build` (add to the build chain
  after `shared`), tested by root vitest, and is registered as a builtin alias
  (`"linear"`, R3) so `orc plugin add linear` works with zero install steps.

**Functional — UI**

- R14: **Import flow** (`packages/ui/src/`): a new "Import" affordance — either a
  section on the Projects screen or a small dedicated screen under the Workspace nav
  group (executor's choice; match existing patterns): provider dropdown (from
  `GET /api/providers`; hidden entirely when empty), search box + "assigned to me"
  toggle, result list (identifier, title, state), each row with an "Import" action →
  project picker (registered projects) → calls R7 import → navigate to the Plan tab
  for the new goal (same handoff as the existing feature flow / `onGoalCreated`).
- R15: Goals with `external_ref` show a provider badge + identifier
  (e.g. `linear · ENG-123`) linking to `external_ref.url`, wherever the goal title is
  already rendered prominently (Plan review header; dashboard goal header). Settings
  screen gains a read-only "Plugins" section listing `GET /api/plugins` (name,
  version, status, error message when errored).

**Non-functional**

- N1: **No billing regression.** `checkProviderEnv` refusal and `buildSpawnEnv`
  stripping unchanged in behavior, only _extended_ with plugin secret keys. A test
  asserts a worker env contains no `LINEAR_API_KEY` when the Linear plugin is loaded.
- N2: **Isolation of failure.** Plugin import/init/sync errors are contained (logged,
  audited, status surfaces in `/api/plugins`) — orchestrator boot, dispatch, and run
  settlement never block or fail because of a plugin. Bus subscribers already isolate
  exceptions; keep plugin callbacks behind that same guarantee.
- N3: **Deterministic core.** The registry, secret store, and Linear GraphQL
  query-building/response-mapping are pure or DI-injected and unit-testable without
  network (fake `fetchFn`). No live Linear calls in tests.
- N4: Redaction: the Linear API key value never appears in logs, audit JSONL, bus
  events, or transcripts (test with a canary value).
- N5: House style: ESM `.js` specifiers, hand-written validators (no zod), top-of-file
  doc comments citing this spec's section numbers, prettier defaults,
  `pnpm build && pnpm test && pnpm lint` green.
- N6: Docs: `README.md` gains a "Plugins" section (declaring, secrets, trust model —
  plugins run in-process with your privileges, install only code you trust) and a
  short "writing a plugin" walkthrough pointing at `shared/src/plugins.ts` and
  `plugin-linear` as the reference implementation. `SECURITY.md` gains the trust-model
  paragraph.

## 5. Proposed Approach

- **Design overview:** Contract-first. Track A defines the plugin contract in `shared`
  and the host (registry + secrets + host API) in `core`, wired in `createSystem`
  behind injectables so everything is testable with fake plugin modules. Track B is
  the generic provider surface (REST/CLI/UI) written against the capability types.
  Track C is the Linear plugin itself — a leaf package depending only on `shared`,
  exercising the whole contract from the outside. Tracks B and C are parallelizable
  once A lands; neither may import the other.
- **Files to create:**
  - `packages/shared/src/plugins.ts` — the contract (R1).
  - `packages/core/src/plugins/registry.ts` + `registry.test.ts` — loader, statuses,
    capability lookup (fake modules; one test with a real temp-file `plugins.json`).
  - `packages/core/src/plugins/secrets.ts` + `secrets.test.ts` — file store, 0600,
    env fallback, strip/redact registration.
  - `packages/core/src/plugins/host.ts` — `PluginHost` implementation (thin facade
    over store/bus/audit + the shared `createFeatureGoal`).
  - `packages/plugin-linear/` — `package.json`, `tsconfig.json`, `src/index.ts`
    (factory + manifest), `src/api.ts` (GraphQL queries + mapping), `src/sync.ts`
    (bus-driven status sync), `src/*.test.ts` (fake `fetchFn` fixtures for
    list/get/comment/state-move; sync state-machine tests).
  - `packages/core/src/plugins/plugins.test.ts` — end-to-end-ish: fake plugin →
    import task → goal exists with `external_ref` → fake run events → sync calls
    recorded.
- **Files to change:** `shared/src/{index.ts,entities.ts,events.ts}` (+
  `SHARED_SCHEMA_VERSION`), `core/src/{system.ts,spawnEnv.ts,index.ts}`,
  `core/src/safety/redact.ts`, `core/src/store/{schema.ts,index.ts}`
  (`external_ref` column + duplicate-import query), the feature-goal extraction in
  `server/src/index.ts` → `core` (R4), `server/src/index.ts` (routes R7 + secrets
  route R8), `cli/src/{index.ts,client.ts}` (R8), `ui/src/{App.tsx,api.ts,live.ts,
projects.tsx,screens.tsx,styles.css}` (R14, R15), root `package.json` build order,
  `README.md`, `SECURITY.md`.
- **Data model / schema changes:** `goals.external_ref` (TEXT, nullable, JSON) via
  `MIGRATION_COLUMNS`; no new tables (plugin declarations and secrets are files under
  `<stateDir>`, which is already gitignored).
- **APIs / contracts affected:** `BusEvent` union (+`plugin.sync` → bump
  `SHARED_SCHEMA_VERSION`); REST is purely additive; `plugins.json` and
  `secrets.json` are new on-disk contracts (document their shapes in README).
- **Dependencies:** **none new.** Linear is called with Node's global `fetch`;
  GraphQL queries are strings. `plugin-linear` depends on `@orc-brain/shared` only.

## 6. Constraints & Assumptions

- **Must follow:** `CLAUDE.md` in full — golden rules, ESM `.js` specifiers, no
  validation libraries, spec-section doc comments, `pnpm build && pnpm test &&
pnpm lint` green.
- **Must NOT change:** `SafetyLayer` injection contract; deny rules; existing REST
  route shapes; event-bus persist-before-fanout ordering; `checkProviderEnv`
  startup refusal; the server's `127.0.0.1` bind.
- **Assumptions (confirm before relying on these):**
  - A1: **In-process, trusted plugins are acceptable for v1.** orc-brain is a local
    single-operator tool; a plugin is code the operator chose to install, same trust
    class as a devDependency. Sandboxing is a documented non-goal (see §11).
  - A2: **Linear auth = personal API key** (Linear Settings → API), stored via the
    secret store or `LINEAR_API_KEY` env. OAuth is out of scope (needs a callback
    surface; unnecessary for a single-operator local tool).
  - A3: **Manual, on-demand import** matches the operator's intent ("connect to a
    Linear task and work on it"). Automatic label-driven polling is deferred (Q2).
  - A4: Plugin declaration changes require a server restart (no hot reload in v1);
    CLI messages say so.
  - A5: Third-party plugins are distributed as ESM modules referenced by **absolute
    path** in v1 (built npm packages installed anywhere on disk). An
    `orc plugin add <npm-name>` that npm-installs into `<stateDir>/plugins/` is a v2
    nicety; v1 only resolves absolute paths + builtin aliases.

## 7. Acceptance Criteria — Definition of Done

- [ ] With no `plugins.json`, behavior is byte-for-byte today's: boot, all existing
      tests, `GET /api/plugins` → `[]`, no provider UI shown.
- [ ] A fake plugin module injected via `createSystem({ pluginModules })` loads,
      reports `active` in `GET /api/plugins`, and its `taskProvider` appears in
      `GET /api/providers`.
- [ ] A plugin whose `init` throws (or with a wrong `apiVersion`) shows
      `status: "error"` with a message, and the system still boots and runs goals
      (test).
- [ ] `orc plugin add linear && orc plugin secret set linear LINEAR_API_KEY` (value on
      stdin) enables the Linear provider after restart; `secrets.json` is mode 0600
      and the key's value appears in no log/audit/transcript (canary test for N4).
- [ ] `orc provider tasks linear --mine` lists issues (fake `fetchFn` in tests; manual
      smoke against a real workspace); a bad token yields a readable 502, not a hang.
- [ ] `orc provider import linear ENG-123 --project <id>` (and the same via the UI
      import flow) creates a goal under the project with
      `external_ref = { provider: "linear", identifier: "ENG-123", … }`, planning
      starts automatically, and the goal reaches `awaiting_approval` — from there the
      existing approve → unattended run flow works unchanged (integration test with
      fake `planQueryFn`).
- [ ] Importing the same issue twice while the first goal is non-terminal → 409.
- [ ] During a run of an imported goal, the Linear plugin (fake `fetchFn`) receives:
      an import comment, a move-to-`started` + comment on run start, and on success a
      summary comment (state moved to `completed` **only** when
      `complete_on_success: true`); on failure a comment and no state change. Each
      action produces an audit entry (`actor: "plugin:linear"`) and a `plugin.sync`
      bus event.
- [ ] A Linear call that rejects (network error) is swallowed + audited and the run
      settles normally (test).
- [ ] Worker envs contain no `LINEAR_API_KEY` when the plugin is loaded (extend
      `spawnEnv.test.ts`).
- [ ] UI: provider import flow works end-to-end (manual smoke via `pnpm serve`);
      goals show the `linear · ENG-123` badge linking to the issue; Settings lists
      plugins with status.
- [ ] `plugin-linear`'s `package.json` depends on `@orc-brain/shared` only (checked in
      review, and by the build graph).
- [ ] `pnpm build && pnpm test && pnpm lint` all green; `SHARED_SCHEMA_VERSION`
      bumped exactly once; README + SECURITY.md updated (N6).

## 8. Test Plan

- **How to verify:** vitest, from the repo root (include glob is root-relative). Fake
  plugin modules via `createSystem({ pluginModules })`; fake Linear via injectable
  `fetchFn` returning canned GraphQL JSON fixtures; fake SDK streams per `CLAUDE.md`
  for any test that reaches planning/dispatch; fresh `mkdtempSync` state dirs +
  `sys.close()`; releasable gates, never never-resolving promises. Manual smoke:
  `pnpm serve` + a real Linear workspace + a scratch repo project.
- **Commands:** `pnpm build`, `pnpm test`, `pnpm lint`; single file:
  `pnpm exec vitest run packages/core/src/plugins/registry.test.ts`.
- **Edge cases to cover:** malformed `plugins.json` (boot continues); duplicate plugin
  names; unknown builtin alias; secrets file pre-existing with 0644 (warn + refuse);
  `getSecret` env fallback; provider timeout (15 s cap → 502); Linear issue with an
  empty description; `getTask` by human identifier vs UUID; import into a deleted
  project (404); duplicate import after the first goal is terminal (allowed);
  `plugin.sync` for a goal whose run is started twice (comment once per run, not
  per tick); redaction canary; `system.close()` unsubscribes plugin bus listeners
  (no late callbacks on a closed store).

## 9. Task Breakdown — execution plan

1. **Contract (Track A1):** `shared/src/plugins.ts` + `Goal.external_ref` +
   `plugin.sync` event + schema/store changes + `SHARED_SCHEMA_VERSION` bump.
2. **Host (Track A2):** `secrets.ts` (+ strip/redact registration), `registry.ts`,
   `host.ts`, extraction of `createFeatureGoal` into core, wiring in `system.ts`
   (+ `pluginModules`/`pluginsFile` injectables), tests.
3. **Provider surface (Track B):** REST routes (R7 + secrets route), CLI commands
   (R8), `api.test.ts` additions.
4. **Linear plugin (Track C):** package scaffold, `api.ts` GraphQL layer + tests,
   `taskProvider`, `sync.ts` + tests, builtin-alias registration, build-chain entry.
5. **UI (Track B2):** import flow, external-ref badges, Settings plugin list,
   `live.ts` event type.
6. **Hardening + docs:** spawnEnv/redaction tests, failure-isolation tests, README
   "Plugins" + plugin-author walkthrough, SECURITY.md trust model,
   `pnpm build && pnpm test && pnpm lint`.

Steps 3–5 are parallelizable after 2; each step is independently committable.

## 10. Open Questions

- Q1: Should the import flow also let the operator pick **run defaults** (budget/
  concurrency) per import, or always use the project defaults? v1 uses project
  defaults (matches the feature flow). — **blocking? no**
- Q2: **Auto-import**: poll Linear for issues carrying a label (e.g. `orc`) and
  import them automatically? Deferred — needs pacing/dedup design and makes the trust
  story bigger. v1 is manual import only. — **blocking? no**
- Q3: Should run **reports** be posted to Linear as the comment body (full Markdown)
  instead of a short summary? v1 posts a short summary + goal/branch info; full
  report attach is a v2 candidate. — **blocking? no**
- Q4: Plugin settings UI (editing `plugins.json` from Settings)? v1 is file/CLI only.
  — **blocking? no**

## 11. Rollback / Risk

- **Risks:**
  1. **In-process third-party code** is the big one: a malicious/buggy plugin has
     full process privileges (can read the state dir, all secrets, and make any
     egress). Mitigations: explicit trust-model documentation (N6), builtin-alias +
     absolute-path-only loading (no transitive auto-discovery, nothing loads unless
     the operator wrote it into `plugins.json`), audit trail on every plugin action,
     failure isolation (N2). Sandboxing is deliberately deferred, not forgotten —
     revisit before any "community plugin directory" exists.
  2. **Secret leakage** into worker transcripts or logs — mitigated by strip-set
     extension + redaction registration + the canary test (N4).
  3. **Sync feedback loops / noise** (plugin reacting to events it caused) —
     mitigated by syncing only on `run.state`/terminal transitions keyed by
     `external_ref`, once per run (test for double-start).
  4. **Upstream flakiness** (Linear down, token revoked) — mitigated by
     fire-and-forget + audit + 15 s timeouts; runs never block on Linear.
- **Rollback:** fully additive. No plugins declared → the system is today's system
  (first acceptance criterion). Reverting = dropping the new packages/modules, the
  nullable `external_ref` column, one bus event, and the additive routes. The
  `secrets.json`/`plugins.json` files live in the gitignored state dir and can be
  deleted freely.
