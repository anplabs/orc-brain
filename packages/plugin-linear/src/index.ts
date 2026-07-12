/**
 * The Linear plugin (spec 003 §R10–§R13) — orc-brain's first and reference
 * plugin. Bundled in the repo but loaded through the public plugin mechanism
 * (builtin alias `"linear"`). Depends on `@orc-brain/shared` only, proving
 * the third-party contract. Capabilities: `task-provider` (browse/import
 * issues) plus outbound status sync (comments + state transitions).
 *
 * Settings (via `plugins.json`):
 * - `complete_on_success` (boolean, default false): move the issue to a
 *   `completed`-type state when a run succeeds (§R12).
 * - `fetchFn` (function, test-only): injectable fetch for offline tests.
 */

import {
  PLUGIN_API_VERSION,
  type ExternalTask,
  type Goal,
  type OrcPlugin,
  type PluginHost,
  type TaskQuery,
} from "@orc-brain/shared";
import { LinearClient, type FetchFn } from "./api.js";
import { attachSync } from "./sync.js";

export { LinearClient, buildIssueFilter, mapIssue } from "./api.js";
export type { FetchFn, WorkflowState } from "./api.js";
export { attachSync } from "./sync.js";

/** Plugin factory (spec 003 §R1 `OrcPluginModule`). */
export default function createLinearPlugin(
  settings: Record<string, unknown>,
): OrcPlugin {
  let host: PluginHost | null = null;
  const client = new LinearClient(
    () => host?.getSecret("LINEAR_API_KEY"),
    (settings.fetchFn as FetchFn | undefined) ?? fetch,
  );

  return {
    manifest: {
      name: "linear",
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
      capabilities: ["task-provider"],
      secrets: ["LINEAR_API_KEY"],
    },

    init(h: PluginHost): void {
      host = h;
      attachSync({
        host: h,
        client,
        completeOnSuccess: settings.complete_on_success === true,
      });
    },

    taskProvider: {
      listTasks: (query: TaskQuery): Promise<ExternalTask[]> =>
        client.listIssues(query),
      getTask: (id: string): Promise<ExternalTask | null> =>
        client.getIssue(id),
    },

    async onTaskImported(task: ExternalTask, goal: Goal): Promise<void> {
      // Import comment (§R12): fire-and-forget from the registry; a failure
      // is audited there and must not fail the import.
      const ref = goal.external_ref ?? undefined;
      try {
        await client.createComment(
          task.id,
          `orc-brain imported this issue as goal \`${goal.id}\` and is planning.`,
        );
        host?.reportSync("imported", { ref, ok: true });
      } catch (err) {
        host?.reportSync("imported", {
          ref,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
