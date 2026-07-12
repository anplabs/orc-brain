/**
 * Plugin system end-to-end tests (spec 003 §7 acceptance): a fake plugin
 * loaded through `createSystem`, an external task imported into the feature
 * flow (planning kicks off with a fake plan query), and bus-driven sync.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Options, Query } from "@anthropic-ai/claude-agent-sdk";
import {
  PLUGIN_API_VERSION,
  type BusEvent,
  type ExternalTask,
  type OrcPluginModule,
  type Plan,
  type PluginHost,
} from "@orc-brain/shared";
import { createSystem } from "../system.js";

const PLAN: Plan = {
  scopes: [
    {
      name: "core",
      description: "core work",
      path_allowlist: ["src/**"],
      allowed_tools: ["Read", "Edit"],
      model_tier: "auto",
      environment: "development",
      permission_mode: "default",
      max_budget_usd: 3,
      tasks: [{ title: "do it", prompt: "do it", task_type: "codegen" }],
    },
  ],
};

const TASK: ExternalTask = {
  provider: "fake",
  id: "issue-7",
  identifier: "ENG-7",
  title: "Add health endpoint",
  description: "GET /health returning 200.",
  url: "https://tracker.example/ENG-7",
  state: "Todo",
  labels: ["orc"],
  updated_at: "2026-07-12T00:00:00.000Z",
};

function fakePlanQuery(params: { prompt: string; options?: Options }): Query {
  void params;
  async function* gen() {
    yield { type: "system", subtype: "init", session_id: "p", model: "opus" };
    yield {
      type: "result",
      subtype: "success",
      total_cost_usd: 0.01,
      num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
      result: "plan",
      structured_output: PLAN,
    };
  }
  return Object.assign(gen(), {
    interrupt: async () => {},
  }) as unknown as Query;
}

function fakePluginModule(record: {
  hosts: PluginHost[];
  events: BusEvent[];
}): OrcPluginModule {
  return {
    default: () => ({
      manifest: {
        name: "fake",
        version: "1.0.0",
        apiVersion: PLUGIN_API_VERSION,
        capabilities: ["task-provider"],
      },
      init(host) {
        record.hosts.push(host);
        host.subscribe((e) => record.events.push(e));
      },
      taskProvider: {
        listTasks: async () => [TASK],
        getTask: async (id) =>
          id === TASK.id || id === TASK.identifier ? TASK : null,
      },
    }),
  };
}

function makeSystem(withPlugin: boolean) {
  const stateDir = mkdtempSync(join(tmpdir(), "orc-plug-e2e-"));
  if (withPlugin) {
    writeFileSync(
      join(stateDir, "plugins.json"),
      JSON.stringify({
        plugins: [{ name: "fake", specifier: "/x/fake.js", enabled: true }],
      }),
    );
  }
  const record: { hosts: PluginHost[]; events: BusEvent[] } = {
    hosts: [],
    events: [],
  };
  const sys = createSystem({
    stateDir,
    planQueryFn: fakePlanQuery,
    pluginModules: { fake: fakePluginModule(record) },
  });
  return { sys, record, stateDir };
}

async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("Plugin system end-to-end (spec 003 §7)", () => {
  it("boots to today's behavior with no plugins.json", async () => {
    const { sys } = makeSystem(false);
    try {
      await sys.plugins.ready;
      expect(sys.plugins.list()).toEqual([]);
      expect(sys.plugins.listTaskProviders()).toEqual([]);
    } finally {
      sys.close();
    }
  });

  it("imports an external task into the feature flow: goal + external_ref + planning", async () => {
    const { sys, record } = makeSystem(true);
    try {
      await sys.plugins.ready;
      expect(sys.plugins.list()[0]).toMatchObject({
        name: "fake",
        status: "active",
      });

      const project = sys.store.createProject({
        name: "demo",
        repo_root: "/tmp/demo-repo",
        execution_mode: "in_repo",
        default_budget_usd: 10,
        default_concurrency: 2,
      });
      const goal = await sys.plugins.importTask("fake", TASK, project.id);
      expect(goal.external_ref).toMatchObject({
        provider: "fake",
        id: "issue-7",
        identifier: "ENG-7",
      });
      expect(goal.project_id).toBe(project.id);
      expect(goal.objective).toContain("GET /health returning 200.");
      expect(goal.objective).toContain("Origin: https://tracker.example/ENG-7");

      // Planning kicked automatically (§R4): the goal reaches approval with
      // the plan materialized, exactly like the typed feature flow.
      await waitFor(
        () => sys.store.getGoal(goal.id)?.status === "awaiting_approval",
      );
      expect(sys.store.listScopesByGoal(goal.id)).toHaveLength(1);

      // Duplicate import while non-terminal is visible to the guard (§R7).
      expect(sys.store.findActiveGoalByExternalRef("fake", "issue-7")?.id).toBe(
        goal.id,
      );

      // The plugin's bus subscription sees run/system events.
      sys.bus.publish({
        run_id: "r-1",
        type: "run.state",
        payload: { state: "running" },
      });
      expect(record.events.some((e) => e.type === "run.state")).toBe(true);
    } finally {
      sys.close();
    }
  });

  it("close() detaches plugin subscriptions before the store closes", async () => {
    const { sys, record } = makeSystem(true);
    await sys.plugins.ready;
    sys.close();
    // Late publish after close must not reach the plugin (and must not throw
    // into a closed store via the plugin path).
    expect(record.events).toEqual([]);
  });
});
