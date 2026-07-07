# orc-brain

> Local orchestrator brain for Claude Code sub-agents — autonomous within
> bounds, observable always, never destructive in production.

orc-brain is a local, single-machine orchestrator that coordinates Claude Code
sub-agents via the TypeScript Agent SDK (`@anthropic-ai/claude-agent-sdk`). It
plans work, spawns and supervises workers, routes models, tracks budget, and
enforces a safety layer — all while streaming an observable event feed to a
local UI.

## What this is

- A **single-machine** orchestrator you run locally to coordinate Claude Code
  sub-agents.
- **Autonomous within bounds**: workers act on their own, but only inside
  budget, environment, and deny-rule limits enforced by a safety layer.
- **Observable always**: every orchestration event is streamed and inspectable
  from a local SPA.
- A **monorepo** of small, focused packages (core, server, cli, ui, shared).

## What this is not

- **Not** a hosted or multi-tenant service.
- **Not** destructive in production: the safety layer gates actions and
  classifies environments to prevent destructive operations against prod.
- **Not** a place for business logic yet — this repository is currently a
  scaffold. Components are stubbed with `TODO`s pending the spec.

## Source of truth

The full technical specification is **`docs/SPEC.md`** (added in the next
commit). When in doubt, `SPEC.md` wins over code comments or this README.

## Packages

| Package             | Purpose                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `@orc-brain/core`   | Orchestrator core: planner, worker manager, model router, budget tracker, safety layer, event bus, state store. |
| `@orc-brain/server` | Fastify HTTP API + SSE; serves the SPA.                                                                         |
| `@orc-brain/cli`    | `orc` CLI — a thin client over the HTTP API.                                                                    |
| `@orc-brain/ui`     | React + Vite + React Flow single-page app.                                                                      |
| `@orc-brain/shared` | Shared types and event schemas.                                                                                 |

## Getting started

Requires **Node 22+** and **pnpm 11+**.

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm dev
```
