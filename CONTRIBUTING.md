# Contributing to orc-brain

Thanks for your interest in improving orc-brain! This project is a safety-first
local orchestrator for Claude Code sub-agents, so contributions are held to a
high bar for correctness and observability — but the workflow is friendly and
the codebase is small and well-documented.

By participating you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Ground rules

- **The spec is the source of truth.** Read
  [`specs/001-orchestrator-spec.md`](./specs/001-orchestrator-spec.md). If your
  change contradicts it, either align with it or update the spec deliberately in
  the same PR and explain why.
- **Never weaken the safety guarantee.** Production scopes deny destructive
  commands unconditionally; the `PreToolUse` hook is the guarantee; billing must
  stay on the subscription (`ANTHROPIC_API_KEY` is stripped and rejected). PRs
  that loosen these will be declined unless they strengthen the invariant a
  different way.
- **Every change ships with tests.** New behaviour needs coverage; new deny
  rules need both a positive test and a red-team bypass case.

See **[`CLAUDE.md`](./CLAUDE.md)** for the architecture map, conventions, and
gotchas — it's the fastest way to get oriented.

## Development setup

Requires **Node ≥ 22** and **pnpm ≥ 11** (`corepack enable`).

```bash
git clone https://github.com/anplabs/orc-brain.git
cd orc-brain
pnpm install
pnpm build
pnpm test
```

Run the app locally with `pnpm dev` (hot reload, UI on <http://localhost:5173>)
or `pnpm serve` (API + built UI on <http://127.0.0.1:4173>). See the
[README](./README.md#run-it-locally) for details.

## Making a change

1. **Fork** the repo and create a topic branch off `main`
   (e.g. `feat/report-diff`, `fix/deny-xargs-r`).
2. **Make your change** in a focused commit or two. Match the surrounding code:
   ESM `.js` import specifiers, top-of-file spec-referencing doc comments,
   hand-written validators (no zod), Prettier defaults.
3. **Add or update tests** next to the code (`*.test.ts`, run by vitest from the
   repo root).
4. **Run the full check locally** — this is exactly what CI runs:
   ```bash
   pnpm build && pnpm test && pnpm lint
   ```
   `pnpm format` fixes most style issues.
5. **Open a pull request** against `main`. Fill out the PR template, link any
   related issue, and describe what you changed and how you verified it.

## Pull request expectations

- CI (build + test + lint) is green.
- The diff is scoped and readable; unrelated refactors go in separate PRs.
- Public behaviour changes update the README and/or `docs/README.md`.
- Data-model or event-schema changes keep `shared/`, `store/schema.ts`, and the
  `Store` CRUD in sync (and bump `SHARED_SCHEMA_VERSION` for event changes).

## Good first contributions

- Additional deny rules + red-team corpus entries (`safety/`).
- Reporting improvements (report contents, Markdown rendering, diff view).
- UI polish on the dashboard / plan review / audit screens.
- Documentation clarifications and examples.

## Reporting bugs and requesting features

Use the GitHub issue templates. For anything that could be a **safety bypass**,
do **not** open a public issue — follow [`SECURITY.md`](./SECURITY.md) instead.

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](./LICENSE).
