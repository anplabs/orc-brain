/**
 * Projects screen (spec 002 §R20): register local repositories, choose the
 * execution mode (worktree | in_repo) and run defaults, and request features —
 * one objective in, planning starts immediately and the Plan tab takes over.
 * Also hosts the plugin task-import flow (spec 003 §R14): browse a provider's
 * tasks (e.g. Linear issues) and import one into a project as a goal.
 */

import { useCallback, useEffect, useState } from "react";
import type { ExternalTask, Project } from "@orc-brain/shared";
import { api } from "./api";

/**
 * Import flow (spec 003 §R14): provider dropdown → search → pick a task and a
 * target project → the import funnels into the feature flow and the shell
 * jumps to plan review. Hidden entirely when no task provider is active.
 */
function ImportSection({
  projects,
  onGoalCreated,
}: {
  projects: Project[];
  onGoalCreated: (goalId: string) => void;
}) {
  const [providers, setProviders] = useState<string[]>([]);
  const [provider, setProvider] = useState("");
  const [search, setSearch] = useState("");
  const [mine, setMine] = useState(false);
  const [tasks, setTasks] = useState<ExternalTask[] | null>(null);
  const [projectId, setProjectId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .providers()
      .then((p) => {
        const names = p.map((x) => x.name);
        setProviders(names);
        setProvider((prev) => prev || (names[0] ?? ""));
      })
      .catch(() => setProviders([]));
  }, []);

  useEffect(() => {
    setProjectId((prev) => prev || (projects[0]?.id ?? ""));
  }, [projects]);

  if (providers.length === 0) return null;

  const load = async () => {
    if (!provider) return;
    setBusy(true);
    setError(null);
    try {
      setTasks(
        await api.providerTasks(provider, {
          search: search.trim() || undefined,
          assigned_to_me: mine || undefined,
        }),
      );
    } catch (e) {
      setTasks(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const importTask = async (t: ExternalTask) => {
    if (!projectId) return alert("Register a project first.");
    setBusy(true);
    try {
      const { goal } = await api.importProviderTask(provider, t.id, projectId);
      onGoalCreated(goal.id);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="toolbar" style={{ padding: 0, border: "none" }}>
        <strong style={{ fontSize: 14 }}>Import a task</strong>
        <div className="picker-group">
          <label>Provider</label>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            {providers.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <div className="picker-group">
          <label>Search</label>
          <input
            placeholder="issue text…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void load()}
            style={{ width: 200 }}
          />
        </div>
        <label
          className="muted"
          style={{ display: "flex", alignItems: "center", gap: 4 }}
        >
          <input
            type="checkbox"
            checked={mine}
            onChange={(e) => setMine(e.target.checked)}
          />
          assigned to me
        </label>
        <div className="picker-group">
          <label>Into project</label>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <button className="primary" disabled={busy} onClick={() => void load()}>
          {busy ? "Loading…" : "Browse"}
        </button>
      </div>
      {error && (
        <div className="muted" style={{ color: "#f85149", marginTop: 8 }}>
          {error}
        </div>
      )}
      {tasks && (
        <table className="grid" style={{ marginTop: 8 }}>
          <tbody>
            {tasks.length === 0 && (
              <tr>
                <td className="muted">No tasks found.</td>
              </tr>
            )}
            {tasks.map((t) => (
              <tr key={t.id}>
                <td style={{ width: 90 }}>
                  <a href={t.url} target="_blank" rel="noreferrer">
                    {t.identifier}
                  </a>
                </td>
                <td style={{ width: 110 }}>
                  <span className="badge">{t.state}</span>
                </td>
                <td>{t.title}</td>
                <td style={{ width: 80, textAlign: "right" }}>
                  <button
                    className="primary"
                    disabled={busy || !projectId}
                    onClick={() => void importTask(t)}
                  >
                    Import
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function Projects({
  onGoalCreated,
}: {
  /** Called with the new goal id so the shell can jump to plan review. */
  onGoalCreated: (goalId: string) => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Add form.
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [mode, setMode] = useState("worktree");
  const [budget, setBudget] = useState("10");
  const [concurrency, setConcurrency] = useState("2");
  const [autoMerge, setAutoMerge] = useState(false);
  // Per-project feature objective.
  const [objective, setObjective] = useState<Record<string, string>>({});

  const refresh = useCallback(() => {
    void api
      .projects()
      .then((p) => {
        setProjects(p);
        setError(null);
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => refresh(), [refresh]);

  const addProject = async () => {
    if (!path.trim()) return;
    setBusy(true);
    try {
      await api.createProject({
        repo_root: path.trim(),
        name: name.trim() || undefined,
        execution_mode: mode,
        auto_merge: autoMerge,
        default_budget_usd: Number(budget) || undefined,
        default_concurrency: Number(concurrency) || undefined,
      });
      setPath("");
      setName("");
      refresh();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const removeProject = async (id: string) => {
    if (!confirm("Remove this project? Goals and runs are kept.")) return;
    try {
      await api.deleteProject(id);
      refresh();
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const requestFeature = async (p: Project) => {
    const text = (objective[p.id] ?? "").trim();
    if (!text) return;
    setBusy(true);
    try {
      const { goal } = await api.createFeatureGoal(p.id, text);
      setObjective((o) => ({ ...o, [p.id]: "" }));
      onGoalCreated(goal.id);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pad">
      {error && <div className="empty">{error}</div>}

      <ImportSection projects={projects} onGoalCreated={onGoalCreated} />

      <div className="toolbar" style={{ flexWrap: "wrap", gap: 8 }}>
        <div className="picker-group">
          <label>Repo path</label>
          <input
            placeholder="~/git/me/my-app"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            style={{ width: 260 }}
          />
        </div>
        <div className="picker-group">
          <label>Name</label>
          <input
            placeholder="(basename)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ width: 120 }}
          />
        </div>
        <div className="picker-group">
          <label>Mode</label>
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="worktree">worktree</option>
            <option value="in_repo">in_repo</option>
          </select>
        </div>
        <div className="picker-group">
          <label>Budget $</label>
          <input
            type="number"
            min="1"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            style={{ width: 70 }}
          />
        </div>
        <div className="picker-group">
          <label>Concurrency</label>
          <input
            type="number"
            min="1"
            value={concurrency}
            onChange={(e) => setConcurrency(e.target.value)}
            style={{ width: 60 }}
          />
        </div>
        <div className="picker-group">
          <label>
            <input
              type="checkbox"
              checked={autoMerge}
              onChange={(e) => setAutoMerge(e.target.checked)}
            />{" "}
            auto-merge
          </label>
        </div>
        <button
          className="primary"
          disabled={busy || !path.trim()}
          onClick={addProject}
        >
          Add project
        </button>
      </div>

      {projects.length === 0 ? (
        <div className="empty">
          No projects yet. Register a local git repository above.
        </div>
      ) : (
        projects.map((p) => (
          <div key={p.id} className="card" style={{ marginBottom: 12 }}>
            <div className="toolbar" style={{ padding: 0, border: "none" }}>
              <div>
                <strong style={{ fontSize: 14 }}>{p.name}</strong>{" "}
                <span className="badge">{p.execution_mode}</span>
                {p.auto_merge && <span className="badge">auto-merge</span>}
                <div className="muted" style={{ fontSize: 12 }}>
                  {p.repo_root} · default ${p.default_budget_usd} ·{" "}
                  {p.default_concurrency} worker(s)
                </div>
              </div>
              <div className="spacer" />
              <button
                onClick={() =>
                  void api
                    .updateProject(p.id, { auto_merge: !p.auto_merge })
                    .then(refresh)
                    .catch((e) => alert((e as Error).message))
                }
              >
                auto-merge: {p.auto_merge ? "on" : "off"}
              </button>
              <button
                onClick={() =>
                  void api
                    .projectGc(p.id)
                    .then((r) =>
                      alert(`Removed ${r.removed.length} orphaned worktree(s)`),
                    )
                    .catch((e) => alert((e as Error).message))
                }
              >
                GC worktrees
              </button>
              <button className="danger" onClick={() => removeProject(p.id)}>
                Remove
              </button>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <textarea
                placeholder='Describe the feature you want, e.g. "add CSV export to the reports page"'
                value={objective[p.id] ?? ""}
                onChange={(e) =>
                  setObjective((o) => ({ ...o, [p.id]: e.target.value }))
                }
                rows={2}
                style={{ flex: 1 }}
              />
              <button
                className="primary"
                disabled={busy || !(objective[p.id] ?? "").trim()}
                onClick={() => requestFeature(p)}
              >
                Plan feature
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
