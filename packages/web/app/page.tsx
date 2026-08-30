"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  getStatus,
  getSessions,
  getNotifications,
  getTasks,
  resumeSession,
  type StatusResponse,
  type Task,
  type WorkSession,
} from "@/lib/api";

const REFRESH_MS = 15_000;

function formatCountdown(resetsAt: number | null): string {
  if (!resetsAt) return "unknown";
  const ms = resetsAt - Date.now();
  if (ms <= 0) return "resetting now";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

const LIFECYCLE_LABEL: Record<WorkSession["lifecycle"], string> = {
  active: "Active",
  interrupted: "Interrupted — Claude limit reached",
  ready_to_resume: "Ready to resume",
  completed: "Completed",
};

function WorkSessionCard({ session, onResumed }: { session: WorkSession | null; onResumed: () => void }) {
  const [resuming, setResuming] = useState(false);

  if (!session) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No active work session</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-neutral-500">
          Start one from the CLI: <code>quota session start &quot;My project&quot;</code>
        </CardContent>
      </Card>
    );
  }

  const isBrief = session.lifecycle === "ready_to_resume";
  const badgeVariant =
    session.lifecycle === "ready_to_resume" ? "success" : session.lifecycle === "interrupted" ? "warning" : "default";

  return (
    <Card className={isBrief ? "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950" : undefined}>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="text-base text-neutral-900 dark:text-neutral-50">
          {isBrief ? "Welcome back" : "Current work session"}
        </CardTitle>
        <Badge variant={badgeVariant}>{LIFECYCLE_LABEL[session.lifecycle]}</Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <div>
          <p className="text-xs uppercase text-neutral-400">You were working on</p>
          <p className="text-lg font-semibold">{session.project}</p>
        </div>
        {session.status_text && (
          <div>
            <p className="text-xs uppercase text-neutral-400">Last state</p>
            <p>{session.status_text}</p>
          </div>
        )}
        {session.nextTasks.length > 0 && (
          <div>
            <p className="text-xs uppercase text-neutral-400">Next</p>
            <ol className="list-decimal pl-4">
              {session.nextTasks.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ol>
          </div>
        )}
        {session.notes && (
          <div>
            <p className="text-xs uppercase text-neutral-400">Notes</p>
            <p className="whitespace-pre-wrap">{session.notes}</p>
          </div>
        )}
        {isBrief && (
          <button
            type="button"
            disabled={resuming}
            onClick={async () => {
              setResuming(true);
              try {
                await resumeSession(session.id);
                onResumed();
              } finally {
                setResuming(false);
              }
            }}
            className="mt-1 w-fit rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {resuming ? "Resuming…" : "Resume Work"}
          </button>
        )}
      </CardContent>
    </Card>
  );
}

function UsageCard({ label, usage }: { label: string; usage: StatusResponse["usage"]["five_hour"] }) {
  if (!usage) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{label}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-neutral-500">
          No data yet — open Claude Code once, or wait for the next background poll.
        </CardContent>
      </Card>
    );
  }
  const pct = Math.round(usage.utilization);
  const variant = pct >= 95 ? "danger" : pct >= 80 ? "warning" : "success";
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>{label}</CardTitle>
        <Badge variant={variant}>{pct}%</Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <Progress value={pct} />
        <p className="text-sm text-neutral-500">
          Resets in {formatCountdown(usage.resetsAt)} · source: {usage.source}
        </p>
      </CardContent>
    </Card>
  );
}

export default function Dashboard() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [avgFiveHour, setAvgFiveHour] = useState<number | null>(null);
  const [notifications, setNotifications] = useState<{ id: number; sent_at: number; channel: string; message: string }[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, sessions, n, t] = await Promise.all([
        getStatus(),
        getSessions("five_hour", 10),
        getNotifications(10),
        getTasks("pending"),
      ]);
      setStatus(s);
      setAvgFiveHour(sessions.averageUtilization);
      setNotifications(n.notifications);
      setTasks(t.tasks);
      setError(null);
    } catch {
      setError("Can't reach the quota agent. Run `quota start` from the CLI.");
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Claude Quota</h1>
        <Badge variant={error ? "danger" : "success"}>{error ? "disconnected" : "connected"}</Badge>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <WorkSessionCard session={status?.session ?? null} onResumed={refresh} />

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-neutral-500">Claude availability</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <UsageCard label="5-hour session" usage={status?.usage.five_hour ?? null} />
          <UsageCard label="Weekly" usage={status?.usage.seven_day ?? null} />
        </div>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Usage stats</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          Average 5-hour utilization: {avgFiveHour !== null ? `${Math.round(avgFiveHour)}%` : "no data yet"}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Task queue ({tasks.length} pending)</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {tasks.length === 0 && <p className="text-sm text-neutral-500">No pending tasks. Add some via `quota tasks add`.</p>}
          {tasks.map((t) => (
            <div key={t.id} className="flex items-center justify-between text-sm">
              <span>{t.title}</span>
              <Badge>{`p${t.priority}`}</Badge>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent notifications</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {notifications.length === 0 && <p className="text-sm text-neutral-500">None yet.</p>}
          {notifications.map((n) => (
            <div key={n.id} className="text-sm">
              <span className="text-neutral-400">{new Date(n.sent_at).toLocaleString()}</span> · {n.channel} · {n.message}
            </div>
          ))}
        </CardContent>
      </Card>
    </main>
  );
}
