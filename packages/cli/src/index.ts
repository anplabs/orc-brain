/** `orc` CLI — a thin client over the orc-brain HTTP API (§9). */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Command } from "commander";
import {
  checkProviderEnv,
  liveAuthCheck,
  runDoctorSync,
} from "@orc-brain/core";
import { api, streamEvents } from "./client.js";

/** Prints JSON when `--json`, otherwise the provided human renderer. */
function output(json: boolean, data: unknown, human: () => void): void {
  if (json) console.log(JSON.stringify(data, null, 2));
  else human();
}

/** Builds the `orc` command tree. */
export function buildCli(): Command {
  const program = new Command();
  program
    .name("orc")
    .description("Local orchestrator brain for Claude Code sub-agents")
    .version("1.0.0");

  // --- orc serve -----------------------------------------------------------
  program
    .command("serve")
    .description("Start the orchestrator daemon + web UI")
    .option("--port <port>", "port to bind", "4173")
    .option("--state-dir <dir>", "state directory (.orc)")
    .action(async (opts: { port: string; stateDir?: string }) => {
      // Refuse to start on API-key billing (§2 preflight).
      const env = checkProviderEnv();
      if (!env.ok) {
        console.error(
          `Refusing to start: unset ${env.offenders.join(", ")} — ` +
            `these switch billing off the Max subscription (§2).`,
        );
        process.exit(1);
      }
      const { createServer } = await import("@orc-brain/server");
      const app = createServer({ stateDir: opts.stateDir });
      await app.listen({ port: Number(opts.port), host: "127.0.0.1" });
      console.error(`orc serve listening on http://127.0.0.1:${opts.port}`);
    });

  // --- orc doctor ----------------------------------------------------------
  program
    .command("doctor")
    .description("Verify CLI auth (subscription, no API key), versions, git")
    .option("--live", "also run a live subscription/auth probe")
    .option("--json", "output JSON")
    .action(async (opts: { live?: boolean; json?: boolean }) => {
      const checks = runDoctorSync();
      const live = opts.live ? await liveAuthCheck() : undefined;
      const allOk = checks.every((c) => c.ok) && (!live || live.ok);
      output(!!opts.json, { checks, live }, () => {
        for (const c of checks) {
          console.log(`${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`);
        }
        if (live) {
          console.log(
            `${live.ok ? "✓" : "✗"} live auth — ` +
              (live.ok
                ? `apiKeySource=${live.apiKeySource ?? "?"} model=${live.model ?? "?"}`
                : (live.error ?? "failed")),
          );
        }
      });
      process.exit(allOk ? 0 : 1);
    });

  // --- orc status ----------------------------------------------------------
  program
    .command("status [run-id]")
    .description("Run state, scopes, budget, active subagents")
    .option("--watch", "stream live updates")
    .option("--json", "output JSON")
    .action(
      async (
        runId: string | undefined,
        opts: { watch?: boolean; json?: boolean },
      ) => {
        const id = runId ?? (await latestRunId());
        if (!id) {
          console.error("no runs found");
          process.exit(1);
        }
        await printStatus(id, !!opts.json);
        if (opts.watch) {
          await streamEvents(
            `?run_id=${id}`,
            () => void printStatus(id, false),
          );
        }
      },
    );

  // --- orc tail ------------------------------------------------------------
  program
    .command("tail <task-id>")
    .description("Live transcript of one subagent")
    .option("-f, --follow", "follow the stream")
    .action(async (taskId: string, opts: { follow?: boolean }) => {
      const { task } = await api<{ task: { session_id: string | null } }>(
        `/api/tasks/${taskId}`,
      );
      if (!opts.follow) {
        console.log(`session ${task.session_id ?? "(pending)"}`);
        return;
      }
      const runId = await latestRunId();
      await streamEvents(runId ? `?run_id=${runId}` : "", (e) => {
        const d = e.data as { payload?: Record<string, unknown> };
        const p = d?.payload;
        if (!p || p.task_id !== taskId) return;
        if (e.event === "tool.call")
          console.log(`  ⚙ ${p.tool_name}: ${p.input_summary}`);
        else if (e.event === "text.delta")
          process.stdout.write(String(p.delta));
        else if (e.event === "task.state") console.log(`\n[${p.status}]`);
      });
    });

  // --- orc run start|pause|resume|stop ------------------------------------
  const run = program.command("run").description("Run lifecycle");
  run
    .command("start <goal-id>")
    .option("--budget <usd>", "run budget in USD", "25")
    .option("--concurrency <n>", "max concurrent workers")
    .action(
      async (
        goalId: string,
        opts: { budget: string; concurrency?: string },
      ) => {
        const res = await api<{ run: { id: string } }>("/api/runs", {
          method: "POST",
          body: JSON.stringify({
            goal_id: goalId,
            budget_usd: Number(opts.budget),
            concurrency_limit: opts.concurrency
              ? Number(opts.concurrency)
              : undefined,
          }),
        });
        console.log(res.run.id);
      },
    );
  for (const verb of ["pause", "resume", "stop"] as const) {
    run.command(`${verb} <run-id>`).action(async (runId: string) => {
      const path = verb === "stop" ? "pause" : verb;
      await api(`/api/runs/${runId}/${path}`, { method: "POST" });
      console.log(`${verb} ${runId} ok`);
    });
  }
  // orc run mode <run-id> <supervised|unattended> (autonomous-loop.md §3.5)
  run
    .command("mode <run-id> <mode>")
    .description("Set autonomous-loop approval mode: supervised | unattended")
    .action(async (runId: string, mode: string) => {
      const res = await api<{ mode: string }>(`/api/runs/${runId}/mode`, {
        method: "POST",
        body: JSON.stringify({ mode }),
      });
      console.log(`run ${runId} mode=${res.mode}`);
    });

  // --- orc panic -----------------------------------------------------------
  program
    .command("panic")
    .description("Kill switch: interrupt everything")
    .action(async () => {
      const res = await api<{ aborted: string[] }>("/api/panic", {
        method: "POST",
      });
      console.log(`panicked; aborted ${res.aborted.length} run(s)`);
    });

  // --- orc purge -----------------------------------------------------------
  program
    .command("purge")
    .description("Wipe the orc database (goals, runs, tasks, reports, events)")
    .option("--keep-projects", "keep the project registry")
    .option("--yes", "confirm — required, purge is irreversible")
    .action(async (opts: { keepProjects?: boolean; yes?: boolean }) => {
      if (!opts.yes) {
        console.error(
          "purge deletes every goal, run, task, report and event" +
            (opts.keepProjects ? " (projects kept)" : ", including projects") +
            ". Re-run with --yes to confirm.",
        );
        process.exit(1);
      }
      const { deleted } = await api<{ deleted: Record<string, number> }>(
        "/api/purge",
        {
          method: "POST",
          body: JSON.stringify({ keep_projects: !!opts.keepProjects }),
        },
      );
      const total = Object.values(deleted).reduce((a, b) => a + b, 0);
      console.log(`purged ${total} row(s):`);
      for (const [table, n] of Object.entries(deleted)) {
        if (n > 0) console.log(`  ${table}: ${n}`);
      }
    });

  // --- orc plan ------------------------------------------------------------
  const plan = program.command("plan").description("Planner (§3)");
  plan
    .command("run <goal-id>", { isDefault: true })
    .description("Run the Planner → proposed scopes + tasks")
    .option("--json", "output JSON")
    .action(async (goalId: string, opts: { json?: boolean }) => {
      const res = await api<{
        scopes: { id: string; name: string }[];
        tasks: { id: string }[];
      }>(`/api/goals/${goalId}/plan`, { method: "POST" });
      output(!!opts.json, res, () => {
        console.log(
          `planned ${res.scopes.length} scope(s), ${res.tasks.length} task(s):`,
        );
        for (const s of res.scopes) console.log(`  ${s.id}  ${s.name}`);
        console.log(`approve with: orc approve ${goalId}`);
      });
    });
  plan
    .command("show <goal-id>")
    .description("Render the proposed scopes, boundaries, and tasks")
    .option("--json", "output JSON")
    .action(async (goalId: string, opts: { json?: boolean }) => {
      const data = await api<{
        goal: { title: string; status: string };
        scopes: {
          id: string;
          name: string;
          status: string;
          environment: string;
          model_tier: string;
          permission_mode: string;
          path_allowlist: string[];
        }[];
        tasks: {
          id: string;
          scope_id: string;
          title: string;
          task_type: string;
          status: string;
        }[];
      }>(`/api/goals/${goalId}`);
      output(!!opts.json, data, () => {
        console.log(`${data.goal.title} [${data.goal.status}]`);
        for (const s of data.scopes) {
          console.log(
            `\n▸ ${s.name} [${s.status}] env=${s.environment} ` +
              `tier=${s.model_tier} mode=${s.permission_mode}`,
          );
          console.log(`  paths: ${s.path_allowlist.join(", ")}`);
          for (const t of data.tasks.filter((t) => t.scope_id === s.id)) {
            console.log(`    · ${t.title} (${t.task_type}) [${t.status}]`);
          }
        }
      });
    });

  plan
    .command("cancel <goal-id>")
    .description(
      "Cancel the proposed plan: drop proposed scopes, back to draft",
    )
    .action(async (goalId: string) => {
      await api(`/api/goals/${goalId}/plan`, { method: "DELETE" });
      console.log(`plan cancelled; goal ${goalId} is draft again`);
    });

  plan
    .command("edit <goal-id>")
    .description("Edit the proposed plan JSON in $EDITOR, re-validate & apply")
    .action(async (goalId: string) => {
      const data = await api<{
        scopes: Record<string, unknown>[];
        tasks: Record<string, unknown>[];
      }>(`/api/goals/${goalId}`);
      // Reconstruct an editable Plan (scopes with nested tasks by title).
      const planScopes = data.scopes.map((s) => ({
        name: s.name,
        description: s.description,
        path_allowlist: s.path_allowlist,
        path_denylist: s.path_denylist,
        allowed_tools: s.allowed_tools,
        disallowed_tools: s.disallowed_tools,
        model_tier: s.model_tier,
        environment: s.environment,
        permission_mode: s.permission_mode,
        forbidden_actions: s.forbidden_actions,
        success_criteria: s.success_criteria,
        max_budget_usd: s.max_budget_usd,
        tasks: data.tasks
          .filter((t) => t.scope_id === s.id)
          .map((t) => ({
            title: t.title,
            prompt: t.prompt,
            task_type: t.task_type,
          })),
      }));
      const file = join(mkdtempSync(join(tmpdir(), "orc-plan-")), "plan.json");
      writeFileSync(file, JSON.stringify({ scopes: planScopes }, null, 2));
      const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi";
      execFileSync(editor, [file], { stdio: "inherit" });
      const edited = JSON.parse(readFileSync(file, "utf8"));
      try {
        const res = await api<{ scopes: unknown[] }>(
          `/api/goals/${goalId}/plan`,
          { method: "PUT", body: JSON.stringify(edited) },
        );
        console.log(`re-materialized ${res.scopes.length} scope(s)`);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(2);
      }
    });

  // --- orc approve ---------------------------------------------------------
  program
    .command("approve <goal-id>")
    .description("Approve all proposed scopes of a goal (or selected --scope)")
    .option("--scope <id...>", "approve only these scope ids")
    .option(
      "--start",
      "then start an unattended run with the project defaults (spec 002 §R5)",
    )
    .action(
      async (goalId: string, opts: { scope?: string[]; start?: boolean }) => {
        if (opts.scope?.length) {
          for (const id of opts.scope) {
            await api(`/api/scopes/${id}/approve`, { method: "POST" });
          }
          console.log(`approved ${opts.scope.length} scope(s)`);
          return;
        }
        const res = await api<{ approved: string[]; run?: { id: string } }>(
          `/api/goals/${goalId}/approve`,
          {
            method: "POST",
            body: JSON.stringify({ start_run: !!opts.start }),
          },
        );
        console.log(`approved ${res.approved.length} scope(s)`);
        if (res.run) console.log(`run ${res.run.id} started (unattended)`);
      },
    );

  // --- orc project add|list|show|rm|gc (spec 002 §R6, §R12) -----------------
  const project = program
    .command("project")
    .description("Registered local repositories orc operates on (spec 002)");
  project
    .command("add [path]")
    .description(
      "Register a local git repository as a project (default: current directory)",
    )
    .option("--name <name>", "display name (default: directory basename)")
    .option("--mode <mode>", "execution mode: worktree | in_repo", "in_repo")
    .option("--budget <usd>", "default run budget in USD")
    .option("--concurrency <n>", "default per-run concurrency")
    .option(
      "--auto-merge",
      "merge settled scope branches into the base branch automatically",
    )
    .action(
      async (
        path: string | undefined,
        opts: {
          name?: string;
          mode: string;
          budget?: string;
          concurrency?: string;
          autoMerge?: boolean;
        },
      ) => {
        const repoRoot = resolve(path ?? process.cwd());
        const res = await api<{ project: { id: string; repo_root: string } }>(
          "/api/projects",
          {
            method: "POST",
            body: JSON.stringify({
              repo_root: repoRoot,
              name: opts.name,
              execution_mode: opts.mode,
              auto_merge: !!opts.autoMerge,
              default_budget_usd: opts.budget ? Number(opts.budget) : undefined,
              default_concurrency: opts.concurrency
                ? Number(opts.concurrency)
                : undefined,
            }),
          },
        );
        console.log(`${res.project.id}  ${res.project.repo_root}`);
      },
    );
  project.command("list").action(async () => {
    const { projects } = await api<{
      projects: {
        id: string;
        name: string;
        repo_root: string;
        execution_mode: string;
      }[];
    }>("/api/projects");
    for (const p of projects) {
      console.log(
        `${p.id}  ${p.execution_mode.padEnd(8)} ${p.name}  ${p.repo_root}`,
      );
    }
  });
  project.command("show <id>").action(async (id: string) => {
    console.log(JSON.stringify(await api(`/api/projects/${id}`), null, 2));
  });
  project.command("rm <id>").action(async (id: string) => {
    await api(`/api/projects/${id}`, { method: "DELETE" });
    console.log(`removed ${id}`);
  });
  project
    .command("gc <id>")
    .description("Remove orphaned worktrees of a project (branches are kept)")
    .option(
      "--prune-merged",
      "also delete orc/* branches fully merged into the current checkout",
    )
    .action(async (id: string, opts: { pruneMerged?: boolean }) => {
      const res = await api<{ removed: string[]; pruned_branches: string[] }>(
        `/api/projects/${id}/gc`,
        {
          method: "POST",
          body: JSON.stringify({ prune_merged: !!opts.pruneMerged }),
        },
      );
      console.log(`removed ${res.removed.length} orphaned worktree(s)`);
      for (const p of res.removed) console.log(`  ${p}`);
      if (opts.pruneMerged) {
        console.log(`pruned ${res.pruned_branches.length} merged branch(es)`);
        for (const b of res.pruned_branches) console.log(`  ${b}`);
      }
    });

  // --- orc feature (spec 002 §R6): objective in, plan awaits approval -------
  program
    .command("feature <project-id> <objective...>")
    .description("Create a goal under a project and start planning it")
    .action(async (projectId: string, objectiveWords: string[]) => {
      const objective = objectiveWords.join(" ");
      const { goal } = await api<{ goal: { id: string } }>(
        `/api/projects/${projectId}/goals`,
        { method: "POST", body: JSON.stringify({ objective }) },
      );
      console.log(goal.id);
      console.log(
        `planning started; review with: orc plan show ${goal.id} ` +
          `then approve with: orc approve ${goal.id} --start`,
      );
    });

  // --- orc plugin (spec 003 §R8): declarations file + secrets ---------------
  // Declarations are edited locally in `<state-dir>/plugins.json` (the server
  // reads it at startup); secrets go through the API so the running server
  // registers redaction/stripping immediately.
  const plugin = program
    .command("plugin")
    .description("Plugins: declared in <state-dir>/plugins.json (spec 003)");
  plugin
    .command("list")
    .description("Loaded plugins and their status (from the running server)")
    .option("--json", "output JSON")
    .action(async (opts: { json?: boolean }) => {
      const { plugins } = await api<{
        plugins: {
          name: string;
          version: string | null;
          capabilities: string[];
          enabled: boolean;
          status: string;
          error?: string;
        }[];
      }>("/api/plugins");
      output(!!opts.json, { plugins }, () => {
        if (!plugins.length) {
          return console.log(
            "no plugins declared — add one with: orc plugin add linear",
          );
        }
        for (const p of plugins) {
          console.log(
            `${p.name.padEnd(12)} ${(p.version ?? "-").padEnd(8)} ` +
              `${p.status.padEnd(9)} ${p.capabilities.join(",") || "-"}` +
              (p.error ? `  (${p.error})` : ""),
          );
        }
      });
    });
  plugin
    .command("add <specifier>")
    .description(
      "Declare a plugin: a builtin alias (linear) or an absolute module path",
    )
    .option("--name <name>", "plugin name (default: the builtin alias)")
    .option("--disable", "declare it disabled")
    .option("--state-dir <dir>", "state directory (.orc)")
    .action(
      async (
        specifier: string,
        opts: { name?: string; disable?: boolean; stateDir?: string },
      ) => {
        const name = opts.name ?? specifier;
        if (!/^[a-z][a-z0-9-]*$/.test(name)) {
          console.error(
            `plugin name must be kebab-case — pass one with --name (got "${name}")`,
          );
          process.exit(1);
        }
        const file = pluginsFilePath(opts.stateDir);
        const decls = readPluginsFile(file);
        if (decls.plugins.some((p) => p.name === name)) {
          console.error(`plugin "${name}" already declared in ${file}`);
          process.exit(1);
        }
        decls.plugins.push({ name, specifier, enabled: !opts.disable });
        writePluginsFile(file, decls);
        console.log(`declared "${name}" in ${file}`);
        console.log("restart `orc serve` to load it");
      },
    );
  plugin
    .command("rm <name>")
    .option("--state-dir <dir>", "state directory (.orc)")
    .action(async (name: string, opts: { stateDir?: string }) => {
      const file = pluginsFilePath(opts.stateDir);
      const decls = readPluginsFile(file);
      const before = decls.plugins.length;
      decls.plugins = decls.plugins.filter((p) => p.name !== name);
      if (decls.plugins.length === before) {
        console.error(`plugin "${name}" not declared in ${file}`);
        process.exit(1);
      }
      writePluginsFile(file, decls);
      console.log(`removed "${name}"; restart \`orc serve\` to apply`);
    });
  for (const verb of ["enable", "disable"] as const) {
    plugin
      .command(`${verb} <name>`)
      .option("--state-dir <dir>", "state directory (.orc)")
      .action(async (name: string, opts: { stateDir?: string }) => {
        const file = pluginsFilePath(opts.stateDir);
        const decls = readPluginsFile(file);
        const entry = decls.plugins.find((p) => p.name === name);
        if (!entry) {
          console.error(`plugin "${name}" not declared in ${file}`);
          process.exit(1);
        }
        entry.enabled = verb === "enable";
        writePluginsFile(file, decls);
        console.log(`${verb}d "${name}"; restart \`orc serve\` to apply`);
      });
  }
  const secret = plugin
    .command("secret")
    .description("Plugin secrets (stored in <state-dir>/secrets.json, 0600)");
  secret
    .command("set <plugin> <key>")
    .description("Set a secret; the value is read from stdin, never argv")
    .action(async (pluginName: string, key: string) => {
      const value = await readSecretFromStdin(`value for ${key}: `);
      if (!value) {
        console.error("empty value; aborted");
        process.exit(1);
      }
      await api(`/api/plugins/${pluginName}/secrets`, {
        method: "POST",
        body: JSON.stringify({ key, value }),
      });
      console.log(`${key} set for ${pluginName}`);
    });
  secret
    .command("unset <plugin> <key>")
    .action(async (pluginName: string, key: string) => {
      await api(`/api/plugins/${pluginName}/secrets/${key}`, {
        method: "DELETE",
      });
      console.log(`${key} unset for ${pluginName}`);
    });

  // --- orc provider (spec 003 §R8): browse & import external tasks ----------
  const provider = program
    .command("provider")
    .description("Task providers exposed by plugins (spec 003)");
  provider.command("list").action(async () => {
    const { providers } = await api<{
      providers: { name: string; capabilities: string[] }[];
    }>("/api/providers");
    if (!providers.length) return console.log("no active task providers");
    for (const p of providers) {
      console.log(`${p.name}  ${p.capabilities.join(",")}`);
    }
  });
  provider
    .command("tasks <name>")
    .description("List external tasks from a provider")
    .option("--search <q>", "search text")
    .option("--mine", "only tasks assigned to me")
    .option("--state <state>", "filter by workflow state name")
    .option("--team <team>", "filter by team key or name")
    .option("--limit <n>", "max results")
    .option("--json", "output JSON")
    .action(
      async (
        name: string,
        opts: {
          search?: string;
          mine?: boolean;
          state?: string;
          team?: string;
          limit?: string;
          json?: boolean;
        },
      ) => {
        const params = new URLSearchParams();
        if (opts.search) params.set("search", opts.search);
        if (opts.mine) params.set("assigned_to_me", "true");
        if (opts.state) params.set("state", opts.state);
        if (opts.team) params.set("team", opts.team);
        if (opts.limit) params.set("limit", opts.limit);
        const qs = params.toString();
        const { tasks } = await api<{
          tasks: {
            identifier: string;
            title: string;
            state: string;
            url: string;
          }[];
        }>(`/api/providers/${name}/tasks${qs ? `?${qs}` : ""}`);
        output(!!opts.json, { tasks }, () => {
          if (!tasks.length) return console.log("no tasks found");
          for (const t of tasks) {
            console.log(
              `${t.identifier.padEnd(10)} ${t.state.padEnd(12)} ${t.title}  ${t.url}`,
            );
          }
        });
      },
    );
  provider
    .command("import <name> <external-id>")
    .description("Import an external task as a goal and start planning it")
    .requiredOption("--project <project-id>", "target project")
    .action(
      async (name: string, externalId: string, opts: { project: string }) => {
        const { goal } = await api<{ goal: { id: string } }>(
          `/api/providers/${name}/import`,
          {
            method: "POST",
            body: JSON.stringify({
              external_id: externalId,
              project_id: opts.project,
            }),
          },
        );
        console.log(goal.id);
        console.log(
          `planning started; review with: orc plan show ${goal.id} ` +
            `then approve with: orc approve ${goal.id} --start`,
        );
      },
    );

  // --- orc goal new|list|show ----------------------------------------------
  const goal = program.command("goal").description("Goal management");
  goal
    .command("new")
    .description("Define a goal from a JSON file or flags")
    .option("-f, --file <path>", "JSON file with the goal definition")
    .option("--title <title>")
    .option("--objective <text>")
    .option("--repo <path>", "repo root", process.cwd())
    .action(
      async (opts: {
        file?: string;
        title?: string;
        objective?: string;
        repo: string;
      }) => {
        const body = opts.file
          ? JSON.parse(readFileSync(opts.file, "utf8"))
          : {
              title: opts.title ?? "untitled goal",
              objective: opts.objective ?? "",
              success_criteria: [],
              constraints: [],
              out_of_scope: [],
              repo_root: opts.repo,
            };
        const { goal: created } = await api<{ goal: { id: string } }>(
          "/api/goals",
          { method: "POST", body: JSON.stringify(body) },
        );
        console.log(created.id);
      },
    );
  goal.command("list").action(async () => {
    const { goals } = await api<{
      goals: { id: string; title: string; status: string }[];
    }>("/api/goals");
    for (const g of goals)
      console.log(`${g.id}  ${g.status.padEnd(16)} ${g.title}`);
  });
  goal.command("show <id>").action(async (id: string) => {
    console.log(JSON.stringify(await api(`/api/goals/${id}`), null, 2));
  });

  // --- orc tasks -----------------------------------------------------------
  program
    .command("tasks [run-id]")
    .description("List tasks, optionally filtered by state")
    .option("--state <state>", "running|blocked|failed|done|…")
    .option("--json", "output JSON")
    .action(
      async (
        runId: string | undefined,
        opts: { state?: string; json?: boolean },
      ) => {
        const id = runId ?? (await latestRunId());
        if (!id) return console.error("no runs found");
        const q = opts.state ? `?state=${opts.state}` : "";
        const { tasks } = await api<{
          tasks: {
            id: string;
            title: string;
            status: string;
            task_type: string;
            model_used?: string;
          }[];
        }>(`/api/runs/${id}/tasks${q}`);
        output(!!opts.json, { tasks }, () => {
          for (const t of tasks) {
            console.log(
              `${t.id}  ${t.status.padEnd(9)} ${(t.model_used ?? "-").padEnd(7)} ${t.title}`,
            );
          }
        });
      },
    );

  // --- orc blocked ---------------------------------------------------------
  const blocked = program
    .command("blocked")
    .description("Pending escalations awaiting operator resolution (§8.5)");
  blocked
    .command("list [run-id]", { isDefault: true })
    .option("--json", "output JSON")
    .action(async (runId: string | undefined, opts: { json?: boolean }) => {
      const q = runId ? `?run_id=${runId}` : "";
      const { escalations } = await api<{
        escalations: {
          id: string;
          rule_id: string;
          tool_name: string;
          input_summary: string;
          task_id: string;
        }[];
      }>(`/api/blocked${q}`);
      output(!!opts.json, { escalations }, () => {
        if (!escalations.length) return console.log("no blocked tasks");
        for (const e of escalations) {
          console.log(
            `${e.id}  ${e.rule_id}  ${e.tool_name}: ${e.input_summary}`,
          );
        }
        console.log(
          "resolve: orc blocked resolve <id> --approve-once|--deny|--skip [--msg ...]",
        );
      });
    });
  blocked
    .command("resolve <escalation-id>")
    .description("Resolve a blocked escalation")
    .option("--approve-once", "single-use exemption, re-queue")
    .option("--deny", "deny & instruct, re-queue with guidance")
    .option("--skip", "skip the task")
    .option("--msg <text>", "guidance message")
    .action(
      async (
        escId: string,
        opts: {
          approveOnce?: boolean;
          deny?: boolean;
          skip?: boolean;
          msg?: string;
        },
      ) => {
        const action = opts.approveOnce
          ? "approve_once"
          : opts.skip
            ? "skip_task"
            : "deny_instruct";
        await api(`/api/escalations/${escId}/resolve`, {
          method: "POST",
          body: JSON.stringify({ action, message: opts.msg }),
        });
        console.log(`resolved ${escId} (${action})`);
      },
    );

  // --- orc budget ----------------------------------------------------------
  const budget = program.command("budget").description("Budget (§7)");
  budget
    .command("show <run-id>")
    .option("--json", "output JSON")
    .action(async (runId: string, opts: { json?: boolean }) => {
      const data = await api<{
        run: {
          budget_usd: number;
          budget_spent_usd: number;
          budget_state: string;
        };
      }>(`/api/runs/${runId}/status`);
      output(!!opts.json, data, () => {
        const r = data.run;
        const pct =
          r.budget_usd > 0
            ? Math.min(100, (r.budget_spent_usd / r.budget_usd) * 100)
            : 0;
        console.log(
          `budget ${pct.toFixed(0)}% used — $${r.budget_spent_usd.toFixed(4)} / $${r.budget_usd} (${r.budget_state})`,
        );
      });
    });
  budget
    .command("set <run-id>")
    .requiredOption("--usd <usd>", "new budget ceiling in USD")
    .action(async (runId: string, opts: { usd: string }) => {
      await api(`/api/runs/${runId}/budget`, {
        method: "POST",
        body: JSON.stringify({ usd: Number(opts.usd) }),
      });
      console.log(`budget set to $${opts.usd}`);
    });

  // --- orc report ----------------------------------------------------------
  program
    .command("report [run-id]")
    .description("Show the latest report or force generation (§11)")
    .option("--now", "generate a fresh report now")
    .option("--json", "output JSON")
    .action(
      async (
        runId: string | undefined,
        opts: { now?: boolean; json?: boolean },
      ) => {
        const id = runId ?? (await latestRunId());
        if (!id) return console.error("no runs found");
        if (opts.now) {
          const { report } = await api<{ report: { content_md: string } }>(
            `/api/runs/${id}/reports`,
            { method: "POST" },
          );
          return output(!!opts.json, { report }, () =>
            console.log(report.content_md),
          );
        }
        const { reports } = await api<{
          reports: { content_md: string }[];
        }>(`/api/runs/${id}/reports`);
        const latest = reports[0];
        output(!!opts.json, { report: latest }, () =>
          console.log(latest ? latest.content_md : "(no reports yet)"),
        );
      },
    );

  // --- orc audit tail ------------------------------------------------------
  const audit = program.command("audit").description("Audit log");
  audit
    .command("tail <run-id>")
    .option("--rule <id>", "filter by rule id")
    .action(async (runId: string, opts: { rule?: string }) => {
      const { events } = await api<{ events: { rule_id?: string }[] }>(
        `/api/audit/${runId}`,
      );
      for (const e of events) {
        if (opts.rule && e.rule_id !== opts.rule) continue;
        console.log(JSON.stringify(e));
      }
    });

  return program;
}

/** A `plugins.json` declaration entry (spec 003 §R3). */
interface PluginDecl {
  name: string;
  specifier: string;
  enabled: boolean;
  settings?: Record<string, unknown>;
}

/** Resolves `<state-dir>/plugins.json` (default state dir: `<cwd>/.orc`). */
function pluginsFilePath(stateDir?: string): string {
  return join(resolve(stateDir ?? join(process.cwd(), ".orc")), "plugins.json");
}

/** Reads the declarations file, tolerating a missing one. */
function readPluginsFile(path: string): { plugins: PluginDecl[] } {
  if (!existsSync(path)) return { plugins: [] };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    plugins?: PluginDecl[];
  };
  return { plugins: Array.isArray(parsed.plugins) ? parsed.plugins : [] };
}

/** Writes the declarations file, creating the state dir if needed. */
function writePluginsFile(path: string, data: { plugins: PluginDecl[] }): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

/**
 * Reads a secret from stdin (spec 003 §R8 — never argv, which leaks to `ps`).
 * Piped input is read whole; interactive input is prompted without echo.
 */
async function readSecretFromStdin(promptText: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  process.stderr.write(promptText);
  return await new Promise<string>((resolvePromise) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    let value = "";
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\n" || ch === "\r") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          resolvePromise(value);
          return;
        }
        if (ch === "\u0003") process.exit(130); // ^C
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/** Resolves the most recent run id from the API. */
async function latestRunId(): Promise<string | undefined> {
  try {
    const { runs } = await api<{ runs: { id: string }[] }>("/api/runs");
    return runs[0]?.id;
  } catch {
    return undefined;
  }
}

/** Fetches and renders a run's status. */
async function printStatus(runId: string, json: boolean): Promise<void> {
  const data = await api<{
    run: { state: string; budget_usd: number; budget_state: string };
    spent_usd: number;
    in_flight: number;
    task_counts: Record<string, number>;
  }>(`/api/runs/${runId}/status`);
  output(json, data, () => {
    const { run, spent_usd, in_flight, task_counts } = data;
    const pct =
      run.budget_usd > 0
        ? Math.min(100, (spent_usd / run.budget_usd) * 100)
        : 0;
    console.log(
      `run ${runId} [${run.state}] budget ${pct.toFixed(0)}% used ` +
        `($${spent_usd.toFixed(4)}/$${run.budget_usd}, ${run.budget_state}) · ${in_flight} in-flight`,
    );
    const counts = Object.entries(task_counts)
      .map(([k, v]) => `${k}:${v}`)
      .join(" ");
    if (counts) console.log(`tasks: ${counts}`);
  });
}
