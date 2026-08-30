const AGENT_URL = process.env.NEXT_PUBLIC_AGENT_URL ?? "http://127.0.0.1:4317";

export interface UsageWindowDto {
  utilization: number;
  resetsAt: number | null;
  capturedAt: number;
  source: string;
}

export interface Task {
  id: number;
  title: string;
  priority: number;
  status: "pending" | "done";
  created_at: number;
  completed_at: number | null;
}

export type SessionLifecycle = "active" | "interrupted" | "ready_to_resume" | "completed";

export interface WorkSession {
  id: number;
  project: string;
  status_text: string | null;
  notes: string | null;
  nextTasks: string[];
  lifecycle: SessionLifecycle;
  interruption_kind: string | null;
  started_at: number;
  last_activity_at: number;
  interrupted_at: number | null;
  reset_at: number | null;
  resumed_at: number | null;
  completed_at: number | null;
}

export interface StatusResponse {
  usage: { five_hour: UsageWindowDto | null; seven_day: UsageWindowDto | null };
  nextTask: Task | null;
  session: WorkSession | null;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${AGENT_URL}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`agent request failed: ${res.status}`);
  return res.json();
}

export function getStatus() {
  return get<StatusResponse>("/api/status");
}

export function getSessions(kind: "five_hour" | "seven_day", limit = 20) {
  return get<{ snapshots: unknown[]; resetEvents: unknown[]; averageUtilization: number | null }>(
    `/api/sessions?kind=${kind}&limit=${limit}`,
  );
}

export function getNotifications(limit = 20) {
  return get<{ notifications: { id: number; sent_at: number; channel: string; message: string }[] }>(
    `/api/notifications?limit=${limit}`,
  );
}

export function getTasks(status?: "pending" | "done") {
  return get<{ tasks: Task[] }>(`/api/tasks${status ? `?status=${status}` : ""}`);
}

export function getSessionHistory(limit = 10) {
  return get<{ sessions: WorkSession[] }>(`/api/work-sessions?limit=${limit}`);
}

export async function resumeSession(id: number) {
  const res = await fetch(`${AGENT_URL}/api/work-sessions/${id}/resume`, { method: "POST" });
  if (!res.ok) throw new Error(`resume failed: ${res.status}`);
  return res.json() as Promise<WorkSession>;
}
