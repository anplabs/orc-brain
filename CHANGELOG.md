# Changelog

All notable changes to this project are documented here. This project is pre-1.0
and follows the phased build plan in
[`specs/001-orchestrator-spec.md`](./specs/001-orchestrator-spec.md) §15.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

### Added — Phase 3 (surfaces)

- **Reporting engine** — store-derived Markdown reports on interval, milestones,
  and demand; written to `reports/<run>/` and announced as `report.new`.
- **Escalation / blocked queue** — a second same-rule denial blocks the task and
  raises an operator escalation with deny-&-instruct / approve-once / skip.
- **Rate-limit backpressure** — global halt or per-model quarantine (router R7)
  on detected limit signals, with countdown.
- **Full CLI** — `goal new`, `plan edit`, `tasks`, `blocked`, `budget`, `report`.
- **Web UI** — live React Flow dashboard, plan review, reports, audit, settings.

### Added — Phase 4 (hardening)

- **Red-team corpus** — a permanent bypass-attempt regression suite (caught and
  fixed a real `nice -n` wrapper-unwrap bypass).
- **Rate-limit chaos, crash-recovery, and dirty-resume** tests and workflows.
- **Repo concurrency guard** (a second run on the same repo refuses, HTTP 409),
  a disk-space doctor check, and graceful shutdown of the dispatch loop.

### Added — Phases 1–2 (foundation)

- Thin vertical slice: SQLite + JSONL store, event bus, safety layer wired from
  the first worker, budget ledger, single-task dispatch, minimal API + CLI.
- Orchestration core: Planner (Opus, plan-mode, structured output), plan
  approval, DAG dispatch with concurrency, model router, pause/resume with
  session persistence, and bounded retries.

### Project

- Open-source scaffolding: README, `CLAUDE.md`, `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, `SECURITY.md`, issue/PR templates, and CI.
- License corrected to **MIT** across the repository.
