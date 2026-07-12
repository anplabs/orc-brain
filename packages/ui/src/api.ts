/**
 * Thin fetch wrapper around the local orc-brain HTTP API. All paths are
 * relative so the SPA works both behind the Vite dev proxy and when served by
 * the Fastify server at the same origin.
 */

import type {
  AuditEvent,
  Escalation,
  Goal,
  Project,
  Report,
  Run,
  Scope,
  SubagentRecord,
  Task,
  TaskStatus,
} from "@orc-brain/shared";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      /* ignore non-JSON error bodies */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return req<T>(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** A kanban card from `GET /api/board` (spec 002 §R17). */
export interface BoardCard {
  task_id: string;
  title: string;
  status: TaskStatus;
  model_used: string | null;
  priority: number;
  attempt: number;
  cost_usd: number;
  scope_name: string;
  goal_id: string;
  goal_title: string;
  project_id: string;
  project_name: string;
  run_id: string;
}

export interface RunStatus {
  run: Run;
  goal: Goal | null;
  scopes: Scope[];
  tasks: Task[];
  task_counts: Partial<Record<TaskStatus, number>>;
  in_flight: number;
  spent_usd: number;
  open_escalations: number;
  backpressure: {
    engaged: boolean;
    resets_at: number | null;
    quarantined: string[];
  };
}

export const api = {
  goals: () => req<{ goals: Goal[] }>("/api/goals").then((r) => r.goals),
  goal: (id: string) =>
    req<{ goal: Goal; scopes: Scope[]; tasks: Task[] }>(`/api/goals/${id}`),
  plan: (id: string) =>
    post<{ scopes: Scope[]; tasks: Task[] }>(`/api/goals/${id}/plan`),
  cancelPlan: (id: string) =>
    req<{ ok: boolean; goal: Goal }>(`/api/goals/${id}/plan`, {
      method: "DELETE",
    }),
  approveGoal: (id: string, startRun = false) =>
    post<{ approved: string[]; run?: Run }>(`/api/goals/${id}/approve`, {
      start_run: startRun,
    }),
  approveScope: (id: string) =>
    post<{ ok: boolean }>(`/api/scopes/${id}/approve`),

  // Projects & feature flow (spec 002 §R3–§R5).
  projects: () =>
    req<{ projects: Project[] }>("/api/projects").then((r) => r.projects),
  createProject: (body: {
    repo_root: string;
    name?: string;
    execution_mode?: string;
    default_budget_usd?: number;
    default_concurrency?: number;
    auto_merge?: boolean;
  }) => post<{ project: Project }>("/api/projects", body),
  deleteProject: (id: string) =>
    req<{ ok: boolean }>(`/api/projects/${id}`, { method: "DELETE" }),
  updateProject: (id: string, body: Partial<Project>) =>
    req<{ project: Project }>(`/api/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  createFeatureGoal: (projectId: string, objective: string, title?: string) =>
    post<{ goal: Goal }>(`/api/projects/${projectId}/goals`, {
      objective,
      title,
    }),
  projectGc: (id: string) =>
    post<{ removed: string[] }>(`/api/projects/${id}/gc`),

  // Kanban board (spec 002 §R17; priority = drag reorder, v2).
  setTaskPriority: (id: string, priority: number) =>
    post<{ task: Task }>(`/api/tasks/${id}/priority`, { priority }),
  board: (projectId?: string) =>
    req<{ projects: Project[]; cards: BoardCard[] }>(
      `/api/board${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ""}`,
    ),

  runs: () => req<{ runs: Run[] }>("/api/runs").then((r) => r.runs),
  createRun: (body: {
    goal_id: string;
    budget_usd: number;
    concurrency_limit?: number;
  }) => post<{ run: Run }>("/api/runs", body),
  status: (id: string) => req<RunStatus>(`/api/runs/${id}/status`),
  pause: (id: string) => post<{ ok: boolean }>(`/api/runs/${id}/pause`),
  resume: (id: string) => post<{ ok: boolean }>(`/api/runs/${id}/resume`),
  setBudget: (id: string, usd: number) =>
    post<{ run: Run }>(`/api/runs/${id}/budget`, { usd }),
  reports: (id: string) =>
    req<{ reports: Report[] }>(`/api/runs/${id}/reports`).then(
      (r) => r.reports,
    ),
  generateReport: (id: string) =>
    post<{ report: Report }>(`/api/runs/${id}/reports`),

  blocked: (runId: string) =>
    req<{ escalations: Escalation[] }>(
      `/api/blocked?run_id=${encodeURIComponent(runId)}`,
    ).then((r) => r.escalations),
  resolveEscalation: (
    id: string,
    action: "deny_instruct" | "approve_once" | "skip_task",
    message?: string,
  ) =>
    post<{ ok: boolean }>(`/api/escalations/${id}/resolve`, {
      action,
      message,
    }),

  panic: () => post<{ ok: boolean; aborted: string[] }>("/api/panic"),

  task: (id: string) =>
    req<{ task: Task; subagents: SubagentRecord[] }>(`/api/tasks/${id}`),
  audit: (runId: string) =>
    req<{ events: AuditEvent[] }>(`/api/audit/${runId}`).then((r) => r.events),
  doctor: () =>
    req<{ checks: DoctorCheck[] }>("/api/doctor").then((r) => r.checks),
};
