/**
 * orc-brain web UI shell (§10): top nav + goal/run pickers, and the screens
 * (board, projects, dashboard, plan review, reports, audit, settings).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Goal, Run } from "@orc-brain/shared";
import { api } from "./api";
import { RunDashboard } from "./dashboard";
import { Board } from "./board";
import { Projects } from "./projects";
import { Audit, PlanReview, Reports, Settings } from "./screens";
import "./styles.css";

type Tab =
  | "board"
  | "projects"
  | "dashboard"
  | "plan"
  | "reports"
  | "audit"
  | "settings";

const TABS: { id: Tab; label: string }[] = [
  { id: "board", label: "Board" },
  { id: "projects", label: "Projects" },
  { id: "dashboard", label: "Run" },
  { id: "plan", label: "Plan review" },
  { id: "reports", label: "Reports" },
  { id: "audit", label: "Audit" },
  { id: "settings", label: "Settings" },
];

/** Tabs whose content is global — the run/goal pickers are hidden there. */
const GLOBAL_TABS: Tab[] = ["board", "projects"];

export default function App() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [goals, setGoals] = useState<Goal[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [goalId, setGoalId] = useState<string | null>(null);
  const [showNewRun, setShowNewRun] = useState(false);
  const [budget, setBudget] = useState("5");
  const [concurrency, setConcurrency] = useState("2");

  const refresh = useCallback(async () => {
    const [g, r] = await Promise.all([api.goals(), api.runs()]);
    setGoals(g);
    setRuns(r);
    return { g, r };
  }, []);

  useEffect(() => {
    void refresh().then(({ g, r }) => {
      const newest = [...r].sort((a, b) =>
        a.created_at < b.created_at ? 1 : -1,
      )[0];
      setRunId((prev) => prev ?? newest?.id ?? null);
      setGoalId((prev) => prev ?? newest?.goal_id ?? g[0]?.id ?? null);
    });
  }, [refresh]);

  // Auto-refresh the pickers so new goals/runs and state changes appear
  // without a reload (planning finishes, runs settle, budgets move).
  useEffect(() => {
    const t = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  // Keep the goal picker in sync with the selected run.
  useEffect(() => {
    if (!runId) return;
    const run = runs.find((r) => r.id === runId);
    if (run) setGoalId(run.goal_id);
  }, [runId, runs]);

  const startRun = async () => {
    if (!goalId) return;
    try {
      const { run } = await api.createRun({
        goal_id: goalId,
        budget_usd: Number(budget) || 5,
        concurrency_limit: Number(concurrency) || undefined,
      });
      await refresh();
      setRunId(run.id);
      setShowNewRun(false);
      setTab("dashboard");
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const sortedRuns = useMemo(
    () => [...runs].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
    [runs],
  );

  const goalLabel = (g: Goal) => `${g.title} · ${g.status}`;
  const runLabel = (r: Run) => {
    const pct =
      r.budget_usd > 0
        ? Math.min(100, (r.budget_spent_usd / r.budget_usd) * 100)
        : 0;
    return `${r.id.slice(-6)} · ${r.state} · ${pct.toFixed(0)}% of budget`;
  };

  return (
    <div className="app">
      <div className="topbar">
        <span className="brand">orc-brain</span>
        <div className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`tab${tab === t.id ? " active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="spacer" />
        {GLOBAL_TABS.includes(tab) ? null : tab === "plan" ? (
          <div className="picker-group">
            <label>Goal</label>
            <select
              value={goalId ?? ""}
              onChange={(e) => setGoalId(e.target.value || null)}
            >
              <option value="">— select —</option>
              {goals.map((g) => (
                <option key={g.id} value={g.id}>
                  {goalLabel(g)}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="picker-group">
            <label>Run</label>
            <select
              value={runId ?? ""}
              onChange={(e) => setRunId(e.target.value || null)}
            >
              <option value="">— select —</option>
              {sortedRuns.map((r) => (
                <option key={r.id} value={r.id}>
                  {runLabel(r)}
                </option>
              ))}
            </select>
          </div>
        )}
        {!GLOBAL_TABS.includes(tab) && (
          <button onClick={() => setShowNewRun((s) => !s)}>New run</button>
        )}
      </div>

      {showNewRun && (
        <div className="topbar" style={{ background: "var(--bg-elev)" }}>
          <div className="picker-group">
            <label>Goal</label>
            <select
              value={goalId ?? ""}
              onChange={(e) => setGoalId(e.target.value || null)}
            >
              <option value="">— select —</option>
              {goals.map((g) => (
                <option key={g.id} value={g.id}>
                  {goalLabel(g)}
                </option>
              ))}
            </select>
          </div>
          <div className="picker-group">
            <label>Budget $</label>
            <input
              type="number"
              min="0"
              step="0.5"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              style={{ width: 80 }}
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
          <button className="primary" disabled={!goalId} onClick={startRun}>
            Start run
          </button>
          <button onClick={() => setShowNewRun(false)}>Cancel</button>
        </div>
      )}

      <div className="screen">
        {tab === "board" && <Board />}
        {tab === "projects" && (
          <Projects
            onGoalCreated={(gid) => {
              setGoalId(gid);
              setTab("plan");
              void refresh();
            }}
          />
        )}
        {tab === "dashboard" && <RunDashboard runId={runId} />}
        {tab === "plan" && (
          <PlanReview
            goalId={goalId}
            onRunStarted={(rid) => {
              void refresh();
              setRunId(rid);
              setTab("dashboard");
            }}
          />
        )}
        {tab === "reports" && <Reports runId={runId} />}
        {tab === "audit" && <Audit runId={runId} />}
        {tab === "settings" && <Settings runId={runId} />}
      </div>
    </div>
  );
}
