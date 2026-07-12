/**
 * PluginRegistry tests (spec 003 §R3, §R5, §R6, §N2): loading, statuses,
 * failure isolation, capability lookup, secret hygiene, and detach-on-close.
 * All plugin modules are injected fakes — no dynamic import, no network.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PLUGIN_API_VERSION,
  type BusEvent,
  type ExternalTask,
  type OrcPlugin,
  type OrcPluginModule,
  type PluginHost,
} from "@orc-brain/shared";
import { Store } from "../store/index.js";
import { NullAuditLog } from "../store/auditLog.js";
import { EventBus } from "../eventBus.js";
import { buildSpawnEnv, clearRegisteredStrippedEnvKeys } from "../spawnEnv.js";
import { clearRegisteredSecretValues, redactString } from "../safety/redact.js";
import { SecretStore } from "./secrets.js";
import { PluginRegistry } from "./registry.js";
import { externalTaskToFeatureInput } from "./host.js";

const TASK: ExternalTask = {
  provider: "fake",
  id: "uuid-1",
  identifier: "ENG-123",
  title: "Fix the flux capacitor",
  description: "It drifts.",
  url: "https://tracker.example/ENG-123",
  state: "Todo",
  labels: [],
  updated_at: "2026-07-12T00:00:00.000Z",
};

/** A minimal plugin module with observable hooks. */
function fakeModule(
  overrides: Partial<OrcPlugin> = {},
  onInit?: (host: PluginHost) => void,
): OrcPluginModule {
  return {
    default: () => ({
      manifest: {
        name: "fake",
        version: "1.0.0",
        apiVersion: PLUGIN_API_VERSION,
        capabilities: ["task-provider"],
      },
      init(host) {
        onInit?.(host);
      },
      taskProvider: {
        listTasks: async () => [TASK],
        getTask: async (id) => (id === TASK.id ? TASK : null),
      },
      ...overrides,
    }),
  };
}

function buildRegistry(opts: {
  declarations?: unknown;
  modules?: Record<string, OrcPluginModule>;
  rawFile?: string;
}) {
  const dir = mkdtempSync(join(tmpdir(), "orc-plugins-"));
  const pluginsFile = join(dir, "plugins.json");
  if (opts.rawFile !== undefined) {
    writeFileSync(pluginsFile, opts.rawFile);
  } else if (opts.declarations !== undefined) {
    writeFileSync(pluginsFile, JSON.stringify({ plugins: opts.declarations }));
  }
  const store = new Store(":memory:");
  const bus = new EventBus(store);
  const audit = new NullAuditLog();
  const secrets = new SecretStore(dir, {});
  const events: BusEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const registry = new PluginRegistry({
    store,
    bus,
    audit,
    secrets,
    createFeatureGoal: (projectId, input) =>
      store.createGoal({
        title: input.title ?? input.objective,
        objective: input.objective,
        success_criteria: [],
        constraints: [],
        out_of_scope: [],
        project_id: projectId,
        repo_root: "/tmp/fake-repo",
        external_ref: input.external_ref ?? null,
      }),
    pluginsFile,
    modules: opts.modules,
    log: () => {},
  });
  return { registry, store, bus, audit, secrets, events, dir };
}

describe("PluginRegistry — loading (spec 003 §R3)", () => {
  it("no plugins.json → no plugins, nothing breaks", async () => {
    const { registry } = buildRegistry({});
    await registry.ready;
    expect(registry.list()).toEqual([]);
    expect(registry.listTaskProviders()).toEqual([]);
  });

  it("loads an injected fake module as active with its capabilities", async () => {
    const { registry } = buildRegistry({
      declarations: [{ name: "fake", specifier: "/x/fake.js", enabled: true }],
      modules: { fake: fakeModule() },
    });
    await registry.ready;
    expect(registry.list()).toEqual([
      {
        name: "fake",
        version: "1.0.0",
        capabilities: ["task-provider"],
        enabled: true,
        status: "active",
      },
    ]);
    expect(registry.getTaskProvider("fake")).not.toBeNull();
    expect(registry.listTaskProviders()).toEqual([
      { name: "fake", capabilities: ["task-provider"] },
    ]);
  });

  it("a plugin whose init throws is status=error and does not break others", async () => {
    const broken = fakeModule({
      manifest: {
        name: "broken",
        version: "0.1.0",
        apiVersion: PLUGIN_API_VERSION,
        capabilities: [],
      },
      init() {
        throw new Error("boom at init");
      },
    });
    const { registry } = buildRegistry({
      declarations: [
        { name: "broken", specifier: "/x/broken.js", enabled: true },
        { name: "fake", specifier: "/x/fake.js", enabled: true },
      ],
      modules: { broken, fake: fakeModule() },
    });
    await registry.ready;
    const byName = Object.fromEntries(registry.list().map((s) => [s.name, s]));
    expect(byName.broken).toMatchObject({
      status: "error",
      error: "boom at init",
    });
    expect(byName.fake).toMatchObject({ status: "active" });
  });

  it("rejects an apiVersion mismatch and a manifest/declaration name mismatch", async () => {
    const wrongVersion = fakeModule({
      manifest: {
        name: "oldy",
        version: "1.0.0",
        apiVersion: 99,
        capabilities: [],
      },
    });
    const wrongName = fakeModule(); // manifest.name is "fake"
    const { registry } = buildRegistry({
      declarations: [
        { name: "oldy", specifier: "/x/o.js", enabled: true },
        { name: "notfake", specifier: "/x/n.js", enabled: true },
      ],
      modules: { oldy: wrongVersion, notfake: wrongName },
    });
    await registry.ready;
    const byName = Object.fromEntries(registry.list().map((s) => [s.name, s]));
    expect(byName.oldy?.status).toBe("error");
    expect(byName.oldy?.error).toMatch(/apiVersion 99/);
    expect(byName.notfake?.status).toBe("error");
    expect(byName.notfake?.error).toMatch(/does not match declared name/);
  });

  it("flags duplicate and non-kebab-case names; skips disabled plugins", async () => {
    let constructed = 0;
    const counting: OrcPluginModule = {
      default: () => {
        constructed++;
        return fakeModule().default({});
      },
    };
    const { registry } = buildRegistry({
      declarations: [
        { name: "fake", specifier: "/x/a.js", enabled: true },
        { name: "fake", specifier: "/x/b.js", enabled: true },
        { name: "Bad_Name", specifier: "/x/c.js", enabled: true },
        { name: "off", specifier: "/x/d.js", enabled: false },
      ],
      modules: { fake: counting, off: fakeModule() },
    });
    await registry.ready;
    const statuses = registry.list();
    expect(statuses.map((s) => s.status)).toEqual([
      "active",
      "error",
      "error",
      "disabled",
    ]);
    expect(statuses[1]?.error).toMatch(/duplicate/);
    expect(statuses[2]?.error).toMatch(/kebab-case/);
    expect(constructed).toBe(1); // duplicate + disabled never constructed
  });

  it("survives a malformed plugins.json and a relative specifier", async () => {
    const malformed = buildRegistry({ rawFile: "{oops" });
    await malformed.registry.ready;
    expect(malformed.registry.list()).toEqual([]);

    const relative = buildRegistry({
      declarations: [{ name: "rel", specifier: "./rel.js", enabled: true }],
    });
    await relative.registry.ready;
    expect(relative.registry.list()[0]).toMatchObject({
      status: "error",
      error: expect.stringMatching(/absolute path or a builtin alias/),
    });
  });
});

describe("PluginRegistry — secret hygiene (spec 003 §R5, §N4)", () => {
  it("strips declared secret keys from worker envs and redacts their values", async () => {
    clearRegisteredStrippedEnvKeys();
    clearRegisteredSecretValues();
    const withSecret = fakeModule({
      manifest: {
        name: "fake",
        version: "1.0.0",
        apiVersion: PLUGIN_API_VERSION,
        capabilities: ["task-provider"],
        secrets: ["FAKE_TRACKER_TOKEN"],
      },
    });
    const { registry, secrets } = buildRegistry({
      declarations: [{ name: "fake", specifier: "/x/f.js", enabled: true }],
      modules: { fake: withSecret },
    });
    secrets.set("FAKE_TRACKER_TOKEN", "canary-secret-value-9876");
    await registry.ready;

    const env = buildSpawnEnv({
      FAKE_TRACKER_TOKEN: "canary-secret-value-9876",
      PATH: "/usr/bin",
    });
    expect(env.FAKE_TRACKER_TOKEN).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    expect(redactString("oops canary-secret-value-9876 leaked")).toBe(
      "oops ***REDACTED*** leaked",
    );
    clearRegisteredStrippedEnvKeys();
    clearRegisteredSecretValues();
  });
});

describe("PluginRegistry — host, import, and close (spec 003 §R4, §R6, §R9)", () => {
  it("importTask creates the goal with external_ref and fires onTaskImported", async () => {
    const imported: Array<{ taskId: string; goalId: string }> = [];
    const module = fakeModule({
      onTaskImported: (task, goal) => {
        imported.push({ taskId: task.id, goalId: goal.id });
      },
    });
    const { registry, store, audit } = buildRegistry({
      declarations: [{ name: "fake", specifier: "/x/f.js", enabled: true }],
      modules: { fake: module },
    });
    await registry.ready;

    const goal = await registry.importTask("fake", TASK, "proj-1");
    expect(goal.title).toBe("ENG-123: Fix the flux capacitor");
    expect(goal.external_ref).toEqual({
      provider: "fake",
      id: "uuid-1",
      identifier: "ENG-123",
      url: "https://tracker.example/ENG-123",
      title: "Fix the flux capacitor",
    });
    expect(store.getGoal(goal.id)?.external_ref?.identifier).toBe("ENG-123");
    // The duplicate-import guard sees it while non-terminal (§R7).
    expect(store.findActiveGoalByExternalRef("fake", "uuid-1")?.id).toBe(
      goal.id,
    );
    store.updateGoalStatus(goal.id, "done");
    expect(store.findActiveGoalByExternalRef("fake", "uuid-1")).toBeNull();

    await new Promise((r) => setTimeout(r, 0)); // onTaskImported is async
    expect(imported).toEqual([{ taskId: "uuid-1", goalId: goal.id }]);
    const auditActions = audit.events.map(
      (e) => (e.detail as { action: string }).action,
    );
    expect(auditActions).toContain("goal_imported");
    expect(audit.events[0]?.actor).toBe("plugin:fake");
  });

  it("host.reportSync audits and publishes a plugin.sync bus event", async () => {
    let host: PluginHost | null = null;
    const { registry, events, audit } = buildRegistry({
      declarations: [{ name: "fake", specifier: "/x/f.js", enabled: true }],
      modules: { fake: fakeModule({}, (h) => (host = h)) },
    });
    await registry.ready;
    host!.reportSync("commented", {
      ok: true,
      detail: "hello",
      run_id: "run-1",
    });
    const sync = events.find((e) => e.type === "plugin.sync");
    expect(sync).toMatchObject({
      run_id: "run-1",
      payload: { plugin: "fake", action: "commented", ok: true },
    });
    expect(
      audit.events.some(
        (e) =>
          e.actor === "plugin:fake" &&
          (e.detail as { action: string }).action === "commented",
      ),
    ).toBe(true);
  });

  it("closeAll unsubscribes plugin listeners and calls close()", async () => {
    const seen: string[] = [];
    let closed = false;
    const module = fakeModule({ close: () => void (closed = true) }, (host) =>
      host.subscribe((e) => seen.push(e.type)),
    );
    const { registry, bus } = buildRegistry({
      declarations: [{ name: "fake", specifier: "/x/f.js", enabled: true }],
      modules: { fake: module },
    });
    await registry.ready;
    bus.publish({
      run_id: null,
      type: "run.state",
      payload: { state: "running" },
    });
    expect(seen).toEqual(["run.state"]);
    registry.closeAll();
    bus.publish({
      run_id: null,
      type: "run.state",
      payload: { state: "done" },
    });
    expect(seen).toEqual(["run.state"]); // no late delivery after close
    await new Promise((r) => setTimeout(r, 0));
    expect(closed).toBe(true);
  });

  it("a throwing subscriber is contained and audited (§N2)", async () => {
    const { registry, bus, audit } = buildRegistry({
      declarations: [{ name: "fake", specifier: "/x/f.js", enabled: true }],
      modules: {
        fake: fakeModule({}, (host) =>
          host.subscribe(() => {
            throw new Error("subscriber exploded");
          }),
        ),
      },
    });
    await registry.ready;
    expect(() =>
      bus.publish({
        run_id: null,
        type: "run.state",
        payload: { state: "running" },
      }),
    ).not.toThrow();
    expect(
      audit.events.some(
        (e) =>
          (e.detail as { action: string }).action === "subscriber_error" &&
          JSON.stringify(e.detail).includes("subscriber exploded"),
      ),
    ).toBe(true);
  });
});

describe("externalTaskToFeatureInput (spec 003 §R4)", () => {
  it("builds title/objective from the task, truncating long titles", () => {
    const input = externalTaskToFeatureInput(TASK);
    expect(input.title).toBe("ENG-123: Fix the flux capacitor");
    expect(input.objective).toBe(
      "ENG-123: Fix the flux capacitor\n\nIt drifts.\n\nOrigin: https://tracker.example/ENG-123",
    );

    const long = externalTaskToFeatureInput({
      ...TASK,
      title: "x".repeat(200),
      description: "",
    });
    expect(long.title.length).toBe(78); // 77 chars + ellipsis
    expect(long.title.endsWith("…")).toBe(true);
    expect(long.objective).toContain("Origin: https://tracker.example/ENG-123");
    expect(long.objective).not.toContain("\n\n\n"); // empty description elided
  });
});
