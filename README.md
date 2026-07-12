# orc-brain

> A local orchestrator brain for Claude Code sub-agents — **autonomous within
> bounds, observable always, never destructive in production.**

[![CI](https://github.com/anplabs/orc-brain/actions/workflows/ci.yml/badge.svg)](https://github.com/anplabs/orc-brain/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-%3E%3D11-orange.svg)](https://pnpm.io)

orc-brain is a **single-machine desktop orchestrator**: you define a goal with
well-scoped boundaries, it plans a decomposition for your approval, then spawns
and coordinates Claude Code sub-agent sessions to execute — streaming everything
to a localhost web UI and a CLI. It draws exclusively from your Claude
subscription via the Claude Code CLI's subscription login, estimates usage
against a budget you set, and enforces — as a first-class guarantee — that **no
sub-agent can perform a destructive operation against a production target.**

It's built on the TypeScript [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
(`@anthropic-ai/claude-agent-sdk`), which bundles the Claude Code binary — one
Node process, one SQLite file, one browser tab, no infrastructure to babysit.

---

## Table of contents

- [Why orc-brain](#why-orc-brain)
- [The safety guarantee](#the-safety-guarantee)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Install](#install)
- [Run it locally](#run-it-locally)
- [Your first run — end to end](#your-first-run--end-to-end)
- [CLI reference](#cli-reference)
- [Configuration](#configuration)
- [Project layout](#project-layout)
- [Development](#development)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

---

## Why orc-brain

Design goals, in priority order:

1. **Bounded blast radius.** Every agent action passes through a deny-first
   safety layer that holds even under permissive permission modes.
2. **Observability.** Every lifecycle event and tool call is streamed live and
   persisted to an append-only audit log. If it isn't observable, it didn't
   happen safely.
3. **Autonomy under constraint.** The orchestrator picks steps, models, and
   parallelism _inside_ the boundaries you approved; it never widens one on its
   own.
4. **Recoverability.** Crash, pause, or kill at any moment → resume from
   persisted state with no lost work beyond the interrupted turn.
5. **Solo-operable.** One process (plus CLI worker subprocesses), one SQLite
   file, one browser tab.

### What it does

- **Plans** a goal into an approvable DAG of scopes and tasks (a dedicated Opus
  session in read-only plan mode).
- **Dispatches** tasks to independent Claude Code worker sessions, gated by
  dependencies, scope approval, budget, and a concurrency limit.
- **Routes models** deterministically per task type (haiku / sonnet / opus),
  with escalation on repeated failure and re-routing under rate limits.
- **Tracks usage** against a spend-equivalent budget with warn/stop thresholds
  and rate-limit backpressure.
- **Enforces safety** with a shell-parsing deny pipeline, environment
  classifier, path allowlists, and a permission-mode floor.
- **Escalates** blocked actions to you with a three-action resolution flow.
- **Reports** progress as Markdown on interval and milestones.
- **Surfaces** all of it through a live React Flow dashboard and an `orc` CLI.

### What it is not

- **Not** hosted, multi-tenant, or cloud — the web UI binds to `127.0.0.1` only.
- **Not** API-key billing — it refuses to start if `ANTHROPIC_API_KEY` is set.
- **Not** destructive in production — that guarantee is not configurable off.

---

## The safety guarantee

The canonical accident — `rm -rf` in the wrong directory, `git push --force` to
`main`, `DROP TABLE` against a prod database — is stopped by defense in depth,
each layer independently sufficient:

- A **`PreToolUse` hook** parses Bash with a real shell tokenizer (unwrapping
  `sh -c`, `xargs`, `sudo`, `nice -n`, command substitution, `&&` chains) and
  denies destructive commands. It runs before the rest of the permission chain
  and applies to sub-agents too, so it holds even under `acceptEdits`.
- An **environment classifier** treats anything ambiguous as production and can
  only ever _raise_ severity (e.g. a mid-task `git checkout main`).
- **Path allowlists** are enforced on `Write`/`Edit` independently of tool mode.
- **`bypassPermissions` is structurally unrepresentable** — the worker builder
  throws if it ever sees it.

A permanent red-team corpus (`packages/core/src/safety/redteam.test.ts`) locks
this in as a regression fixture. Production-flagged scopes deny destructive
commands unconditionally.

---

## Architecture

```
┌─ Orchestrator process (single Node.js process) ─────────────────────────┐
│                                                                          │
│  Core ── Planner (Opus, plan-only)                                       │
│   │  ├── Worker Manager ── Worker: SDK query() → bundled Claude Code CLI  │
│   │  ├── Model Router      Worker: SDK query() → …                        │
│   │  ├── Budget Tracker                                                   │
│   │  ├── Safety Layer (PreToolUse hook + canUseTool + env classifier)     │
│   │  ├── Escalation Manager + Backpressure + Reporting Engine             │
│   │  └── Event Bus ──► State Store (SQLite + JSONL audit log)             │
│   │                     │                                                 │
│  Local HTTP API + SSE ──┘  (binds 127.0.0.1 only)                         │
│         ▲            ▲                                                    │
└─────────┼────────────┼───────────────────────────────────────────────────┘
       CLI `orc`   Web UI (React SPA)
```

| Package             | Purpose                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `@orc-brain/shared` | Data model, enums, event schemas, config types, plan schema.                                                                   |
| `@orc-brain/core`   | Orchestrator, planner, worker manager, model router, budget tracker, safety layer, escalation, backpressure, reporting, store. |
| `@orc-brain/server` | Fastify HTTP API + SSE; serves the SPA. Binds `127.0.0.1`.                                                                     |
| `@orc-brain/cli`    | `orc` — a thin client over the HTTP API.                                                                                       |
| `@orc-brain/ui`     | React + Vite + React Flow single-page app.                                                                                     |

The full technical specification is the source of truth:
**[`specs/001-orchestrator-spec.md`](./specs/001-orchestrator-spec.md)**. When
in doubt, the spec wins over code comments or this README.

---

## Prerequisites

| Requirement          | Version | Notes                                                         |
| -------------------- | ------- | ------------------------------------------------------------- |
| **Node.js**          | ≥ 22    | `node --version`                                              |
| **pnpm**             | ≥ 11    | `corepack enable && corepack prepare pnpm@latest --activate`  |
| **git**              | any     | Used for worktrees and branch classification.                 |
| **Claude Code auth** | current | A Claude subscription, authenticated via the Claude Code CLI. |

### Authenticate Claude Code (subscription, not API key)

orc-brain drives your **Claude subscription** through the Claude Code CLI that
the Agent SDK bundles. Log in once with the Claude Code CLI or desktop app so the
subscription credentials exist on your machine.

> [!IMPORTANT]
> Do **not** set `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`,
> `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`). Those switch billing to
> pay-as-you-go API. orc-brain **strips them from every worker** and **refuses
> to start** if one is present. Verify with `orc doctor`.

---

## Install

```bash
# 1. Clone
git clone https://github.com/anplabs/orc-brain.git
cd orc-brain

# 2. Enable pnpm (skip if you already have pnpm ≥ 11)
corepack enable

# 3. Install dependencies for every workspace package
pnpm install

# 4. Build all packages (shared → core → ui → server → cli)
pnpm build
```

That's it — no database to provision, no services to start. State lives in a
local `.orc/` directory (SQLite + audit log) created on first run.

Verify your environment before running anything:

```bash
pnpm orc doctor          # checks: no API key in env, Node ≥ 22, git, disk space
pnpm orc doctor --live   # also runs a live subscription/auth probe (uses a token)
```

You should see all ✓ checks. If `subscription billing (no API key)` fails, unset
the offending variables it names.

---

## Run it locally

There are two ways to run it. **Pick one.**

### Option A — Serve mode (recommended for a real run)

Builds are already done from the install step. Start the daemon; it serves both
the API and the web UI from one port.

```bash
pnpm serve                       # = node packages/cli/dist/main.js serve --port 4173
```

Then open **<http://127.0.0.1:4173>** in your browser. The CLI talks to the same
server:

```bash
pnpm orc status                  # run state, budget, active sub-agents
pnpm orc goal list
```

### Option B — Dev mode (hot reload while hacking)

Runs the server (`tsx watch`, port 4173) and the Vite dev server (port 5173,
which proxies `/api` and the SSE stream to 4173) together:

```bash
pnpm dev
```

Then open **<http://localhost:5173>** — the UI hot-reloads on change, and the
API restarts on server-code changes.

> The `orc` CLI is a thin HTTP client. Anywhere below, `pnpm orc <cmd>` is
> shorthand for `node packages/cli/dist/main.js <cmd>`. If you prefer a bare
> `orc`, add an alias: `alias orc="node $(pwd)/packages/cli/dist/main.js"`.

---

## Your first run — end to end

> [!NOTE]
> **The mental model in one line:** you don't "run orc _in_ a repo" — you create
> a **goal that points at a repo**, and orc plans it into tasks for you.
>
> - **One goal = one repo.** The repo is fixed when you create the goal (`--repo`,
>   or the current directory). That path is the working directory for every
>   sub-agent. To work on a different repo, create another goal.
> - **One run per repo at a time.** Starting a second run against a repo that
>   already has an active run is refused.
> - **No "create a single task" command.** Tasks are only ever produced by
>   _planning a goal_. To do one small thing, write a tightly-scoped goal (narrow
>   `objective` + `out_of_scope`); the planner emits a minimal scope with one or
>   two tasks. Trim further with `orc plan edit <goal-id>` if needed.

### The short way — projects + feature flow (spec 002)

Register a repo once as a **project**, then ask for features in one line. The
plan approval is the single human gate: the run starts unattended (auto-replan
included) with the project's default budget/concurrency.

```bash
# Register the repo (worktree mode isolates each scope on an orc/<goal>/<scope>
# branch; in_repo works directly in your checkout).
PROJ=$(pnpm --silent orc project add ~/git/paulo/dogfood-app --mode worktree | cut -d' ' -f1)

# Ask for a feature — planning starts immediately.
GOAL=$(pnpm --silent orc feature "$PROJ" "add CSV export to the reports page" | head -1)

# Review the proposed plan, then approve AND start in one step.
pnpm orc plan show "$GOAL"
pnpm orc approve "$GOAL" --start
```

Watch everything on the **Board** tab (a kanban of every agent across all
projects — drag cards in the Queued column to reprioritize dispatch) or the
run dashboard. When a worktree scope finishes, its branch
(`orc/<goal>/<scope>`) is kept for you to review and merge — or, with
`--auto-merge` on the project, orc merges it into the base branch when the
checkout is clean (conflicts always fall back to manual). Failed scopes keep
their worktree on disk for debugging (`orc project gc <id> [--prune-merged]`
cleans orphans and merged branches). Worktree projects may run several goals
concurrently on the same repo; `in_repo` keeps the one-run-per-repo lock.

### The long way — explicit goals

With the server running (Option A or B), drive a full goal from the CLI. Every
step also has a UI equivalent (Plan review, Run dashboard, Blocked drawer).

```bash
# 1. Define a goal (repo-root defaults to the current directory).
GOAL=$(pnpm --silent orc goal new \
  --title "Add a health endpoint" \
  --objective "Expose GET /healthz returning 200 ok" \
  --repo /path/to/your/project)
echo "goal: $GOAL"

# 2. Plan it — a read-only Opus session proposes scopes + tasks.
pnpm orc plan "$GOAL"
pnpm orc plan show "$GOAL"        # review boundaries, tools, model tiers, budgets

# 3. Approve the plan (all scopes, or --scope <id> for a subset).
pnpm orc approve "$GOAL"

# 4. Start a run with a budget ceiling and concurrency.
RUN=$(pnpm --silent orc run start "$GOAL" --budget 5 --concurrency 2)
echo "run: $RUN"

# 5. Watch it live.
pnpm orc status "$RUN" --watch    # or open the dashboard in the browser
pnpm orc tail <task-id> -f        # stream one sub-agent's transcript

# 6. Handle anything the safety layer blocked (if it did).
pnpm orc blocked "$RUN"
pnpm orc blocked resolve <esc-id> --deny --msg "use a PR instead"

# 7. Pause / resume / stop, and read the report.
pnpm orc run pause "$RUN"
pnpm orc run resume "$RUN"
pnpm orc report "$RUN" --now
```

At any moment, **`pnpm orc panic`** SIGKILLs every worker immediately.

---

## CLI reference

`orc` is a thin client over the local HTTP API. Add `--json` to most commands
for scripting. Exit codes: `0` ok, `1` error, `2` blocked/needs-approval.

| Command                                            | Description                                             |
| -------------------------------------------------- | ------------------------------------------------------- |
| `orc serve [--port 4173]`                          | Start the orchestrator daemon + web UI.                 |
| `orc doctor [--live]`                              | Verify subscription auth, Node, git, disk.              |
| `orc project add <path> [--mode --auto-merge …]`   | Register a local repo (worktree \| in_repo).            |
| `orc project gc <id> [--prune-merged]`             | Prune orphaned worktrees (and merged `orc/*` branches). |
| `orc project list\|show\|rm <id>`                  | Manage projects.                                        |
| `orc feature <project> "<objective>"`              | Create a goal under a project and start planning.       |
| `orc approve <goal> --start`                       | Approve + start an unattended run (project defaults).   |
| `orc goal new [-f file.json \| --title …]`         | Define a goal.                                          |
| `orc goal list` · `orc goal show <id>`             | List / inspect goals.                                   |
| `orc plan <goal>` · `plan show` · `plan edit`      | Run the planner / render / edit the plan in `$EDITOR`.  |
| `orc approve <goal> [--scope <id>…]`               | Approve proposed scopes.                                |
| `orc run start <goal> [--budget --concurrency]`    | Start a run.                                            |
| `orc run pause\|resume\|stop <run>`                | Lifecycle control.                                      |
| `orc panic`                                        | Kill switch — SIGKILL everything.                       |
| `orc status [run] [--watch]`                       | Run state, budget, sub-agents.                          |
| `orc tasks [run] [--state …]`                      | List tasks by state.                                    |
| `orc tail <task-id> [-f]`                          | Live transcript of one sub-agent.                       |
| `orc blocked [run]` · `blocked resolve <id>`       | Pending escalations + resolution.                       |
| `orc budget show <run>` · `budget set <run> --usd` | Budget inspection / adjustment.                         |
| `orc report [run] [--now]`                         | Latest report / force generation.                       |
| `orc audit tail <run> [--rule <id>]`               | Tail the audit log.                                     |

---

## Configuration

Environment variables read by the server (`packages/server/src/main.ts`):

| Variable        | Default                 | Purpose                                  |
| --------------- | ----------------------- | ---------------------------------------- |
| `PORT`          | `4173`                  | Port the API + SPA bind to.              |
| `HOST`          | `127.0.0.1`             | Bind address. **Keep it loopback.**      |
| `ORC_STATE_DIR` | `<cwd>/.orc`            | SQLite, audit log, and reports location. |
| `ORC_URL`       | `http://127.0.0.1:4173` | Base URL the CLI targets.                |

Runtime policy (routing table, budget thresholds, prod-host indicators, deny
postures, escalation and pause behaviour) lives in `DEFAULT_CONFIG`
(`packages/core/src/config.ts`) and mirrors the spec's §6–§8 defaults.

Subscription pacing (spec 002): `global_concurrency_limit` caps simultaneous
workers across **all** runs (default 4), and `budget.max_tasks_per_hour` /
`budget.max_tasks_per_run` throttle dispatch volume. When a gate engages the
UI shows a "Paced" banner (`pacing.hold` event) and dispatch resumes
automatically.

---

## Project layout

```
orc-brain/
├─ packages/
│  ├─ shared/   # data model, enums, events, config + plan schemas
│  ├─ core/     # orchestrator, planner, router, budget, safety, store, …
│  ├─ server/   # Fastify API + SSE (127.0.0.1)
│  ├─ cli/      # the `orc` command
│  └─ ui/       # React + React Flow SPA
├─ specs/       # 001-orchestrator-spec.md — the source of truth
├─ docs/        # implementation status
├─ reports/     # generated run reports (gitignored)
└─ .orc/        # local state: SQLite + audit log (gitignored, created at runtime)
```

---

## Development

```bash
pnpm build       # build every package (tsc; ui also runs vite build)
pnpm test        # vitest across the monorepo (unit + integration + red-team)
pnpm lint        # eslint + prettier --check
pnpm format      # prettier --write
pnpm dev         # server + UI with hot reload
```

The test suite (`pnpm test`) covers the safety deny pipeline, the red-team
bypass corpus, the model router, the budget tracker, the planner and plan
validation, the full orchestrator lifecycle (dispatch, retry, pause/resume), and
Phase-4 hardening (rate-limit chaos, crash recovery, dirty-resume, escalation).

New to the codebase or working with an AI assistant? Read
**[`CLAUDE.md`](./CLAUDE.md)** for the architecture map, conventions, and gotchas.

---

## Contributing

Contributions are welcome! Please read **[`CONTRIBUTING.md`](./CONTRIBUTING.md)**
for setup, coding conventions, and the PR process, and note our
**[Code of Conduct](./CODE_OF_CONDUCT.md)**. Good first areas: additional deny
rules + red-team cases, UI polish, and reporting/report-format improvements.

## Security

This project's whole point is safety, so security reports are taken seriously.
Please report vulnerabilities privately per **[`SECURITY.md`](./SECURITY.md)** —
do not open a public issue for a safety bypass.

## License

[MIT](./LICENSE) © Paulo Lima
