# Security Policy

orc-brain's central promise is that **no sub-agent can perform a destructive
operation against a production target**, and that billing never silently leaves
your Claude subscription. Security reports — especially safety-layer bypasses —
are taken seriously.

## Reporting a vulnerability

**Please do not open a public GitHub issue for a security problem.**

Report privately using GitHub's
[private vulnerability reporting](https://github.com/PauloPeregoHQ/orc-brain/security/advisories/new)
("Report a vulnerability" under the repo's **Security** tab). If that is
unavailable, contact the maintainer privately and we will coordinate a fix.

Please include:

- A description of the issue and its impact.
- A minimal reproduction — for a deny-pipeline bypass, the exact tool input
  (e.g. the Bash command) and the scope environment it was accepted in.
- The commit / version you observed it on.

We aim to acknowledge reports within a few days and to ship a fix and a
regression test (added to the red-team corpus) promptly.

## What counts as a security issue

- A destructive command, path escape, or credential access that is **allowed in
  a production-flagged scope** (a deny-pipeline bypass).
- Any path that causes `ANTHROPIC_API_KEY` (or other provider credentials) to
  reach a worker or switch billing off the subscription.
- The web UI or API binding beyond `127.0.0.1`, or an auth/bearer bypass on the
  local API.
- Escalations that fail to block, or a `bypassPermissions`-equivalent reaching a
  worker.

## What is out of scope

- Behaviour in **development-flagged** scopes, which intentionally follow a
  configurable posture (allow-with-audit / require-approval).
- Cost/usage estimates diverging from real subscription consumption — the budget
  is an estimator and backpressure system, not a meter (see spec §7).

## Supported versions

This project is pre-1.0 and moves fast; fixes land on `main`. Please test against
the latest `main` before reporting.
