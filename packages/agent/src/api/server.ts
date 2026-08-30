import express from "express";
import type Database from "better-sqlite3";
import type { Notifier } from "../notifications/notifier.ts";
import type { Scheduler } from "../scheduler/scheduler.ts";
import { parseStatusLinePayload } from "../provider/statusline-hook.ts";
import { latestSnapshot, recentSnapshots, recentResetEvents, averageUtilization } from "../storage/snapshots.ts";
import { recentNotifications } from "../storage/notifications-log.ts";
import { createTask, listTasks, completeTask, updateTask, deleteTask, nextRecommendedTask } from "../storage/tasks.ts";
import type { UsageKind } from "../provider/types.ts";
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
} from "../storage/sessions.ts";
import path from "node:path";

const KINDS: UsageKind[] = ["five_hour", "seven_day"];

export interface ApiDeps {
  db: Database.Database;
  notifier: Notifier;
  scheduler?: Scheduler;
}

export function createApp({ db, notifier, scheduler }: ApiDeps) {
  const app = express();
  app.use(express.json());
  // The dashboard (Next.js dev/prod server) runs on a different localhost port,
  // so cross-origin requests need this even though everything stays on 127.0.0.1.
  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,PUT,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    next();
  });
  app.options(/.*/, (_req, res) => res.sendStatus(204));

  app.get("/api/status", (_req, res) => {
    const usage = Object.fromEntries(
      KINDS.map((kind) => {
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
    res.json({ sessions: listSessions(db, Number(req.query.limit ?? 20)) });
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
    const limit = Number(req.query.limit ?? 20);
    res.json({
      snapshots: recentSnapshots(db, kind, limit),
      resetEvents: recentResetEvents(db, limit),
      averageUtilization: averageUtilization(db, kind) ?? null,
    });
  });

  app.get("/api/notifications", (req, res) => {
    res.json({ notifications: recentNotifications(db, Number(req.query.limit ?? 20)) });
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
    res.status(201).json(createTask(db, title.trim(), Number(priority ?? 0)));
  });

  app.patch("/api/tasks/:id", (req, res) => {
    const id = Number(req.params.id);
    const { title, priority, status } = req.body ?? {};
    let task = updateTask(db, id, { title, priority });
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
    let session = getCurrentSession(db);
    if (!session) {
      const project = typeof cwd === "string" && cwd ? path.basename(cwd) : "Untitled session";
      session = startSession(db, project);
    }
    if (typeof statusText === "string" && statusText) {
      session = updateSession(db, session.id, { statusText }) ?? session;
    }
    if (typeof note === "string" && note) {
      session = appendNote(db, session.id, note) ?? session;
    }
    if (Array.isArray(nextTasks)) {
      for (const t of nextTasks) {
        if (typeof t === "string" && t && !session.nextTasks.includes(t)) {
          session = appendNextTask(db, session.id, t) ?? session;
        }
      }
    }
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

  return app;
}
