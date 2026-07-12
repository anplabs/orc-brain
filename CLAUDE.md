# CLAUDE.md

Guidance for Claude Code (and humans) working in this repository.

## What this project is

orc-brain is a **local, single-process orchestrator** for Claude Code sub-agents,
built on `@anthropic-ai/claude-agent-sdk`. It plans a goal into a scope/task DAG,
dispatches each task to an independent SDK `query()` (one bundled Claude Code CLI
subprocess per worker), and enforces a deny-first safety layer. It's a pnpm
monorepo of six TypeScript packages.

**The spec is the source of truth.** Read
[`specs/001-orchestrator-spec.md`](./specs/001-orchestrator-spec.md) before making
design decisions — section numbers (`§8.2`, etc.) are referenced throughout the
code comments. Implementation status is tracked in [`docs/README.md`](./docs/README.md).
All four build phases (thin slice → orchestration core → surfaces → hardening)
are implemented.

## Golden rules

1. **Never let billing leave the subscription.** `ANTHROPIC_API_KEY` and friends
   are stripped from every worker env (`spawnEnv.ts`) and the process refuses to
   start if one is set. Don't add code paths that reintroduce them.
2. **The safety layer is constructor-injected, not opt-in.** A `WorkerManager`
   cannot be built without a `SafetyLayer`. `bypassPermissions` is not a
   representable value. Don't loosen this.
3. **Production is never destructive.** Deny rules in production scopes are not
   configurable off. If you touch `denyRules.ts`, add red-team cases.
4. **The spec wins.** If code and spec disagree, fix the code (or update the spec
   deliberately and say so).

## Commands

```bash
pnpm install            # install workspace deps
pnpm build              # build all packages (shared → plugin-linear → core → ui → server → cli)
pnpm test               # vitest run (whole monorepo)
pnpm lint               # eslint + prettier --check  (CI runs this)
pnpm format             # prettier --write
pnpm dev                # server (4173) + UI (5173) with hot reload
pnpm serve              # build first, then serve API + UI on 4173
pnpm orc <cmd>          # run the CLI (thin client over the API)

# Single test file (run from the repo root — vitest include is root-relative):
pnpm exec vitest run packages/core/src/orchestrator.test.ts
```

Always finish a change with `pnpm build && pnpm test && pnpm lint` green.

## Architecture map

Dependency direction: `shared` ← `core` ← {`server`, `cli`}; `ui` ← `shared`.

- **`packages/shared`** — pure types, no logic. `enums.ts`, `entities.ts`,
  `events.ts` (the bus/SSE union), `config.ts` (`OrchestratorConfig`), `plan.ts`
  (`Plan` + `PLAN_JSON_SCHEMA`). Bump `SHARED_SCHEMA_VERSION` when event schemas
  change.
- **`packages/core`** — the engine. Key files:
  - `system.ts` — the composition root (`createSystem`). Wire new components here.
  - `orchestrator.ts` — Goal/Scope/Task DAG, run state machine, dispatch loop,
    pause/resume, retries, escalation resolution. The hub.
  - `planner.ts` + `planValidation.ts` — Opus plan-only session → validated `Plan`.
  - `workerManager.ts` — one SDK `query()` per task; streams messages onto the bus.
  - `modelRouter.ts` — pure `(task, scope, ctx) → {model, reason}` (rules R1–R7).
  - `budgetTracker.ts`, `backpressure.ts` — cost ledger + rate-limit handling.
  - `worktrees.ts` — scope worktree lifecycle for `worktree`-mode projects
    (spec 002 §R8: branch kept on success, worktree kept on failure).
  - `pacing.ts` — proactive dispatch pacing (`max_tasks_per_hour` sliding
    window; the global concurrency cap lives in the orchestrator tick).
  - `escalation.ts` — same-rule denial counting → block + operator escalation.
  - `reporting.ts` — store-derived Markdown reports.
  - `safety/` — `denyRules.ts` (shell-parsing interception), `envClassifier.ts`,
    `paths.ts`, `redact.ts`, `limitSignals.ts`, `index.ts` (the `SafetyLayer`).
  - `store/` — `schema.ts` (SQLite DDL), `index.ts` (`Store`), `auditLog.ts` (JSONL).
  - `plugins/` — spec 003: `registry.ts` (loader over `<stateDir>/plugins.json`),
    `host.ts` (the narrow `PluginHost` facade), `secrets.ts` (0600 secret store).
    The typed plugin contract lives in `shared/src/plugins.ts`.
- **`packages/plugin-linear`** — the first plugin (spec 003): Linear GraphQL
  `task-provider` + issue status sync. Depends on `@orc-brain/shared` **only**;
  it is the reference for third-party plugins — never import core from it.
- **`packages/server`** — `index.ts` builds the Fastify app (all REST + the
  `/api/events` SSE endpoint). `main.ts` is the entrypoint. Binds `127.0.0.1`.
- **`packages/cli`** — `index.ts` builds the commander tree; `client.ts` is the
  fetch/SSE HTTP client; `main.ts` is the entrypoint.
- **`packages/ui`** — `App.tsx` (nav + pickers), `dashboard.tsx` (flow graph +
  inspector + blocked drawer), `screens.tsx` (plan/reports/audit/settings),
  `api.ts`, `live.ts` (SSE reducer), `markdown.ts`, `styles.css`.

## Conventions (match the surrounding code)

- **ESM with explicit `.js` import specifiers** even for `.ts` files
  (`import { X } from "./foo.js"`). TypeScript is configured for NodeNext.
- **No validation library.** Plans and inputs are checked with hand-written
  validators (`planValidation.ts`). Don't add zod/yup.
- **Every meaningful file has a top-of-file doc comment citing the spec section.**
  Keep that style; keep comment density similar to neighbours.
- **Deterministic core.** The model router is a pure function; reports are
  store-derived (no LLM). Keep decision logic explainable and testable.
- **Prettier defaults** (2-space, double quotes, semicolons, trailing commas).
  `pnpm lint` must pass — it's `eslint .` **and** `prettier --check .`.

## Gotchas (learned the hard way)

- **SQLite can't bind booleans.** `better-sqlite3` rejects JS booleans. The
  `dirty` column is stored as `0/1` and coerced back in `Store.rowToTask`. Any
  new boolean column needs the same treatment.
- **Tests inject a fake SDK, never call the real one.** `createSystem({ queryFn,
planQueryFn })` and the `WorkerManager`/`Planner` constructors accept an
  injectable `query` function. A fake is an async generator yielding
  `{type:"system",subtype:"init",…}` then `{type:"result",…}`, wrapped with
  `Object.assign(gen(), { interrupt: async () => {} })`.
- **Never leave a never-resolving promise in a test.** A worker that "hangs"
  forever (`await new Promise(() => {})`) prevents vitest from exiting. Use a
  **releasable gate** (`let release; const gate = new Promise(r => release = r)`)
  and call `release()` in a `finally`. See `hardening.test.ts`.
- **Use fresh temp state dirs per test** (`mkdtempSync`) or `:memory:` stores, and
  call `sys.close()` — it stops the dispatch loop (`orchestrator.stop()`), clears
  timers, and closes the DB so late worker callbacks don't touch a closed store.
- **Run vitest from the repo root.** The `include` glob in `vitest.config.ts` is
  root-relative; `pnpm --filter … exec vitest` finds no files.
- **The event bus persists before it fans out.** `EventBus.publish` writes to the
  store (assigning the monotonic `seq`) _then_ notifies subscribers, so the SSE
  `Last-Event-ID` replay is never behind the UI.

## How to make common changes

- **Add a deny rule:** extend `matchCommand`/matchers in `safety/denyRules.ts`,
  then add both a positive case in `denyRules.test.ts` and a production-bypass
  case in `safety/redteam.test.ts`. The red-team suite is a permanent regression
  fixture — it has already caught a real wrapper-unwrap bypass.
- **Add a bus/SSE event:** add the type to `shared/events.ts` (extend `BusEvent`),
  publish it via `bus.publish(...)`, and handle it in the UI's `live.ts` reducer
  and (if relevant) `EVENT_TYPES`.
- **Add an API endpoint:** add the route in `server/src/index.ts`, a client call
  in `cli/src/client.ts` usage or `ui/src/api.ts`, and wire the surface.
- **Add a config knob:** add it to the relevant interface in `shared/config.ts`
  and to `DEFAULT_CONFIG` in `core/config.ts`. Both must stay in sync.
- **Change the data model:** update `shared/entities.ts`, `store/schema.ts` (DDL),
  and the `Store` CRUD (serialize/deserialize + the column list in INSERT/UPDATE).

## Git & PRs

- Branch off `main`; keep changes focused. CI (`.github/workflows/ci.yml`) runs
  build + test + lint on every push and PR — all three must pass.
- Match existing commit style. Don't commit `dist/`, `.orc/`, `*.db`, or
  `reports/*` (all gitignored).
