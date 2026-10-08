import express, { type ErrorRequestHandler } from "express";
import type Database from "better-sqlite3";
import type { Notifier } from "../notifications/notifier.ts";
import type { Scheduler } from "../scheduler/scheduler.ts";
import { parseStatusLinePayload } from "../provider/statusline-hook.ts";
import { latestSnapshot, recentSnapshots, recentResetEvents, averageUtilization } from "../storage/snapshots.ts";
import { recentNotifications } from "../storage/notifications-log.ts";
import { createTask, listTasks, completeTask, updateTask, deleteTask, nextRecommendedTask } from "../storage/tasks.ts";
import { USAGE_KINDS, type UsageKind } from "../provider/types.ts";
import {
  getCurrentSession,
  getSession,
  listSessions,
  startSession,
  updateSession,
  appendNote,
  appendNextTask,
  resumeSession,
  completeSession,
  applySessionActivity,
} from "../storage/sessions.ts";

export interface ApiDeps {
  db: Database.Database;
  notifier: Notifier;
  scheduler?: Scheduler;
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** A positive integer `?limit=`, or `fallback` for anything else. */
function limitParam(value: unknown, fallback = 20): number {
  const n = Number(value ?? fallback);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function createApp({ db, notifier, scheduler }: ApiDeps) {
  const app = express();
  // The API is unauthenticated, so only local callers may use it. Browsers always send
  // Origin cross-site, so a non-local Origin is some website the user has open; a non-local
  // Host is a DNS-rebinding attempt. The CLI and Claude Code hooks send no Origin at all.
  // The dashboard runs on a different localhost port, so local origins get CORS headers.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (!LOCAL_HOST.test(req.headers.host ?? "") || (origin !== undefined && !LOCAL_ORIGIN.test(origin))) {
      res.status(403).json({ error: "forbidden: the quota agent only accepts requests from localhost" });
      return;
    }
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,PUT,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "content-type");
    }
    next();
  });
  app.use(express.json());
  app.options(/.*/, (_req, res) => res.sendStatus(204));

  app.get("/api/status", (_req, res) => {
    const usage = Object.fromEntries(
      USAGE_KINDS.map((kind) => {
        const snap = latestSnapshot(db, kind);
        return [
          kind,
          snap
            ? {
                utilization: snap.utilization,
                resetsAt: snap.resets_at,
                capturedAt: snap.captured_at,
                source: snap.source,
              }
            : null,
        ];
      }),
    );
    res.json({ usage, nextTask: nextRecommendedTask(db) ?? null, session: getCurrentSession(db) ?? null });
  });

  app.get("/api/work-sessions/current", (_req, res) => {
    res.json({ session: getCurrentSession(db) ?? null });
  });

  app.get("/api/work-sessions", (req, res) => {
    res.json({ sessions: listSessions(db, limitParam(req.query.limit)) });
  });

  app.post("/api/work-sessions", (req, res) => {
    const { project, statusText, force } = req.body ?? {};
    if (typeof project !== "string" || project.trim() === "") {
      res.status(400).json({ error: "project is required" });
      return;
    }
    // Starting a session completes whatever's currently in play. That's expected for an
    // `active` session (you're just moving on), but silently discards an unresumed Resume
    // Brief if the current one is `interrupted`/`ready_to_resume` -- undermining the whole
    // "never lose your place" premise. Require an explicit `force` to proceed past that.
    const current = getCurrentSession(db);
    if (current && (current.lifecycle === "interrupted" || current.lifecycle === "ready_to_resume") && !force) {
      res.status(409).json({
        error: "unresumed_session",
        message: `"${current.project}" is still ${
          current.lifecycle === "ready_to_resume" ? "ready to resume" : "interrupted"
        } -- starting a new session will discard it.`,
        session: current,
      });
      return;
    }
    res.status(201).json(startSession(db, project.trim(), statusText));
  });

  app.patch("/api/work-sessions/:id", (req, res) => {
    const { project, statusText } = req.body ?? {};
    const session = updateSession(db, Number(req.params.id), { project, statusText });
    if (!session) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(session);
  });

  app.post("/api/work-sessions/:id/note", (req, res) => {
    const { text } = req.body ?? {};
    if (typeof text !== "string" || text.trim() === "") {
      res.status(400).json({ error: "text is required" });
      return;
    }
    const session = appendNote(db, Number(req.params.id), text.trim());
    if (!session) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(session);
  });

  app.post("/api/work-sessions/:id/next", (req, res) => {
    const { text } = req.body ?? {};
    if (typeof text !== "string" || text.trim() === "") {
      res.status(400).json({ error: "text is required" });
      return;
    }
    const session = appendNextTask(db, Number(req.params.id), text.trim());
    if (!session) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(session);
  });

  app.post("/api/work-sessions/:id/resume", (req, res) => {
    const session = resumeSession(db, Number(req.params.id));
    if (!session) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(session);
  });

  app.post("/api/work-sessions/:id/complete", (req, res) => {
    const { force } = req.body ?? {};
    const id = Number(req.params.id);
    const current = getSession(db, id);
    if (!current) {
      res.status(404).json({ error: "not found" });
      return;
    }
    // Same discard risk as starting a new session: completing an interrupted/ready_to_resume
    // session throws away its Resume Brief. Require an explicit `force` to proceed past that.
    if ((current.lifecycle === "interrupted" || current.lifecycle === "ready_to_resume") && !force) {
      res.status(409).json({
        error: "unresumed_session",
        message: `"${current.project}" is still ${
          current.lifecycle === "ready_to_resume" ? "ready to resume" : "interrupted"
        } -- completing it will discard the Resume Brief.`,
        session: current,
      });
      return;
    }
    res.json(completeSession(db, id));
  });

  app.get("/api/sessions", (req, res) => {
    const kind = (req.query.kind as UsageKind) ?? "five_hour";
    const limit = limitParam(req.query.limit);
    res.json({
      snapshots: recentSnapshots(db, kind, limit),
      resetEvents: recentResetEvents(db, limit),
      averageUtilization: averageUtilization(db, kind) ?? null,
    });
  });

  app.get("/api/notifications", (req, res) => {
    res.json({ notifications: recentNotifications(db, limitParam(req.query.limit)) });
  });

  app.get("/api/tasks", (req, res) => {
    const status = req.query.status as "pending" | "done" | undefined;
    res.json({ tasks: listTasks(db, status) });
  });

  app.post("/api/tasks", (req, res) => {
    const { title, priority } = req.body ?? {};
    if (typeof title !== "string" || title.trim() === "") {
      res.status(400).json({ error: "title is required" });
      return;
    }
    if (!Number.isFinite(Number(priority ?? 0))) {
      res.status(400).json({ error: "priority must be a number" });
      return;
    }
    res.status(201).json(createTask(db, title.trim(), Number(priority ?? 0)));
  });

  app.patch("/api/tasks/:id", (req, res) => {
    const id = Number(req.params.id);
    const { title, priority, status } = req.body ?? {};
    if (priority !== undefined && !Number.isFinite(Number(priority))) {
      res.status(400).json({ error: "priority must be a number" });
      return;
    }
    let task = updateTask(db, id, { title, priority: priority === undefined ? undefined : Number(priority) });
    if (status === "done") task = completeTask(db, id);
    if (!task) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(task);
  });

  app.delete("/api/tasks/:id", (req, res) => {
    const ok = deleteTask(db, Number(req.params.id));
    res.status(ok ? 204 : 404).end();
  });

  app.post("/api/notify/test", async (_req, res) => {
    res.json({ results: await notifier.sendTest() });
  });

  // Called by bin/quota-session-hook.ts (Claude Code Stop/SessionEnd hooks) to
  // keep the current session's status/next-tasks/notes fresh automatically.
  // Auto-creates a session (named from cwd) if none is open yet.
  app.post("/api/internal/session-activity", (req, res) => {
    const { statusText, note, nextTasks, cwd } = req.body ?? {};
    applySessionActivity(
      db,
      {
        statusText: typeof statusText === "string" && statusText ? statusText : undefined,
        note: typeof note === "string" && note ? note : undefined,
        nextTasks: Array.isArray(nextTasks) ? nextTasks.filter((t) => typeof t === "string" && t) : undefined,
      },
      typeof cwd === "string" && cwd ? cwd : undefined,
    );
    res.status(204).end();
  });

  // Called by bin/quota-statusline.ts to push a freshly observed snapshot into
  // the running scheduler immediately, instead of waiting for the next poll.
  app.post("/api/internal/statusline", (req, res) => {
    if (!scheduler) {
      res.status(503).json({ error: "scheduler not attached" });
      return;
    }
    const snapshot = parseStatusLinePayload(req.body ?? {});
    if (!snapshot) {
      res.status(204).end();
      return;
    }
    scheduler.ingest(snapshot);
    res.status(204).end();
  });

  // JSON errors only, never Express's default HTML page with a stack trace. Client errors
  // (e.g. a malformed JSON body) keep their own status and message; anything else is a bug.
  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const status = Number(err?.status ?? err?.statusCode ?? 500);
    if (status >= 500) console.error("quota: request failed", err);
    res.status(status).json({ error: status < 500 ? String(err.message) : "internal error" });
  };
  app.use(onError);

  return app;
}
