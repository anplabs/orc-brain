/**
 * Status sync back to Linear (spec 003 §R12): bus-driven, outbound-only, and
 * strictly fire-and-forget — every Linear call is wrapped so an outage can
 * never affect a run. Actions fire once per run (in-memory guard), only for
 * goals whose `external_ref.provider === "linear"`, and each is reported via
 * `host.reportSync` (audit entry + `plugin.sync` bus event, §R6/§R9).
 */

import type { ExternalRef, Goal, PluginHost, Run } from "@orc-brain/shared";
import type { LinearClient } from "./api.js";

/** Options for {@link attachSync}. */
export interface SyncOptions {
  host: PluginHost;
  client: LinearClient;
  /**
   * Move the issue to a `completed`-type state on run success. Default false:
   * comment only — a human verifies before closing (§R12).
   */
  completeOnSuccess: boolean;
}

/** The goal behind a run event, when it is a Linear-imported goal. */
async function linearGoalOfRun(
  host: PluginHost,
  runId: string,
): Promise<{ run: Run; goal: Goal; ref: ExternalRef } | null> {
  const run = await host.getRun(runId);
  if (!run) return null;
  const goal = await host.getGoal(run.goal_id);
  if (!goal?.external_ref || goal.external_ref.provider !== "linear") {
    return null;
  }
  return { run, goal, ref: goal.external_ref };
}

/** Subscribes the sync reactions to the bus (§R12). Idempotent per plugin. */
export function attachSync(opts: SyncOptions): void {
  const { host, client } = opts;
  // Once-per-run guards: a resume re-emits `running`, and terminal states must
  // not double-comment (§8 edge cases — "comment once per run, not per tick").
  const started = new Set<string>();
  const settled = new Set<string>();

  const onRunning = async (runId: string): Promise<void> => {
    const hit = await linearGoalOfRun(host, runId);
    if (!hit) return;
    const { ref } = hit;
    try {
      const state = await client.moveIssueToStateType(ref.id, "started");
      await client.createComment(
        ref.id,
        `orc-brain started run \`${runId}\` for goal \`${hit.goal.id}\` (${hit.goal.title}).`,
      );
      host.reportSync("run_started", {
        ref,
        ok: true,
        run_id: runId,
        detail: state
          ? `moved to "${state.name}" and commented`
          : "commented (no started-type state found)",
      });
    } catch (err) {
      host.reportSync("run_started", {
        ref,
        ok: false,
        run_id: runId,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const onDone = async (runId: string): Promise<void> => {
    const hit = await linearGoalOfRun(host, runId);
    if (!hit) return;
    const { ref, run, goal } = hit;
    try {
      const scopes = await host.listScopesByGoal(goal.id);
      const branches = scopes
        .map((s) => s.branch_name)
        .filter((b): b is string => !!b);
      const lines = [
        `orc-brain finished working on this issue.`,
        ``,
        `- Goal: ${goal.title} (\`${goal.id}\`)`,
        `- Run: \`${runId}\``,
        `- Cost: $${run.budget_spent_usd.toFixed(2)}`,
        ...(branches.length
          ? [`- Branches: ${branches.map((b) => `\`${b}\``).join(", ")}`]
          : []),
      ];
      await client.createComment(ref.id, lines.join("\n"));
      let detail = "commented";
      if (opts.completeOnSuccess) {
        const state = await client.moveIssueToStateType(ref.id, "completed");
        if (state) detail = `commented and moved to "${state.name}"`;
      }
      host.reportSync("run_succeeded", {
        ref,
        ok: true,
        run_id: runId,
        detail,
      });
    } catch (err) {
      host.reportSync("run_succeeded", {
        ref,
        ok: false,
        run_id: runId,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const onFailed = async (runId: string, reason?: string): Promise<void> => {
    const hit = await linearGoalOfRun(host, runId);
    if (!hit) return;
    const { ref } = hit;
    try {
      // Failure never changes the issue state (§R12).
      await client.createComment(
        ref.id,
        `orc-brain run \`${runId}\` failed${reason ? `: ${reason}` : "."}`,
      );
      host.reportSync("run_failed", { ref, ok: true, run_id: runId });
    } catch (err) {
      host.reportSync("run_failed", {
        ref,
        ok: false,
        run_id: runId,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  };

  host.subscribe((event) => {
    if (event.type !== "run.state" || !event.run_id) return;
    const runId = event.run_id;
    const { state, reason } = event.payload;
    if (state === "running" && !started.has(runId)) {
      started.add(runId);
      void onRunning(runId);
    } else if (state === "done" && !settled.has(runId)) {
      settled.add(runId);
      void onDone(runId);
    } else if (state === "failed" && !settled.has(runId)) {
      settled.add(runId);
      void onFailed(runId, reason);
    }
  });
}
