<!-- Thanks for contributing to orc-brain! Please fill this out. -->

## What & why

<!-- What does this change do, and why? Link any related issue: Closes #123 -->

## How I verified it

<!-- Commands run, tests added, manual checks. -->

- [ ] `pnpm build && pnpm test && pnpm lint` pass locally

## Checklist

- [ ] Tests added/updated for the change
- [ ] Docs updated if behaviour changed (README / `docs/README.md` / `CLAUDE.md`)
- [ ] Follows the spec (`specs/001-orchestrator-spec.md`) — or updates it deliberately
- [ ] Does **not** weaken the safety guarantee (deny pipeline, no API-key billing,
      `127.0.0.1`-only) — new deny rules include a red-team case
