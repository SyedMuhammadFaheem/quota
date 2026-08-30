import type Database from "better-sqlite3";
import type { UsageKind } from "../provider/types.ts";

export type SessionLifecycle = "active" | "interrupted" | "ready_to_resume" | "completed";

export interface WorkSessionRow {
  id: number;
  project: string;
  status_text: string | null;
  notes: string | null;
  next_tasks: string; // JSON string[]
  lifecycle: SessionLifecycle;
  interruption_kind: UsageKind | null;
  interruption_reason: string | null;
  started_at: number;
  last_activity_at: number;
  interrupted_at: number | null;
  reset_at: number | null;
  resumed_at: number | null;
  completed_at: number | null;
}

export interface WorkSession extends Omit<WorkSessionRow, "next_tasks"> {
  nextTasks: string[];
}

function toWorkSession(row: WorkSessionRow): WorkSession {
  let nextTasks: string[];
  try {
    nextTasks = JSON.parse(row.next_tasks);
  } catch {
    nextTasks = [];
  }
  const { next_tasks: _next_tasks, ...rest } = row;
  return { ...rest, nextTasks };
}

/** Ends any non-completed session (superseded by a new one) without touching its history. */
function completeOpenSessions(db: Database.Database): void {
  db.prepare(
    "UPDATE work_sessions SET lifecycle = 'completed', completed_at = ? WHERE lifecycle != 'completed'",
  ).run(Date.now());
}

export function startSession(db: Database.Database, project: string, statusText?: string): WorkSession {
  completeOpenSessions(db);
  const now = Date.now();
  const info = db
    .prepare(
      "INSERT INTO work_sessions (project, status_text, started_at, last_activity_at) VALUES (?, ?, ?, ?)",
    )
    .run(project, statusText ?? null, now, now);
  return getSession(db, Number(info.lastInsertRowid))!;
}

export function getSession(db: Database.Database, id: number): WorkSession | undefined {
  const row = db.prepare("SELECT * FROM work_sessions WHERE id = ?").get(id) as
    | WorkSessionRow
    | undefined;
  return row ? toWorkSession(row) : undefined;
}

/** The session currently in play -- active, interrupted, or waiting to be resumed. */
export function getCurrentSession(db: Database.Database): WorkSession | undefined {
  const row = db
    .prepare("SELECT * FROM work_sessions WHERE lifecycle != 'completed' ORDER BY id DESC LIMIT 1")
    .get() as WorkSessionRow | undefined;
  return row ? toWorkSession(row) : undefined;
}

export function listSessions(db: Database.Database, limit = 20): WorkSession[] {
  const rows = db
    .prepare("SELECT * FROM work_sessions ORDER BY id DESC LIMIT ?")
    .all(limit) as WorkSessionRow[];
  return rows.map(toWorkSession);
}

export function updateSession(
  db: Database.Database,
  id: number,
  fields: { project?: string; statusText?: string },
): WorkSession | undefined {
  const current = getSession(db, id);
  if (!current) return undefined;
  db.prepare("UPDATE work_sessions SET project = ?, status_text = ?, last_activity_at = ? WHERE id = ?").run(
    fields.project ?? current.project,
    fields.statusText ?? current.status_text,
    Date.now(),
    id,
  );
  return getSession(db, id);
}

export function appendNote(db: Database.Database, id: number, text: string): WorkSession | undefined {
  const current = getSession(db, id);
  if (!current) return undefined;
  const notes = current.notes ? `${current.notes}\n${text}` : text;
  db.prepare("UPDATE work_sessions SET notes = ?, last_activity_at = ? WHERE id = ?").run(
    notes,
    Date.now(),
    id,
  );
  return getSession(db, id);
}

export function appendNextTask(db: Database.Database, id: number, text: string): WorkSession | undefined {
  const current = getSession(db, id);
  if (!current) return undefined;
  const nextTasks = [...current.nextTasks, text];
  db.prepare("UPDATE work_sessions SET next_tasks = ?, last_activity_at = ? WHERE id = ?").run(
    JSON.stringify(nextTasks),
    Date.now(),
    id,
  );
  return getSession(db, id);
}

/** Claude usage for `kind` hit its limit -- checkpoint the active session as interrupted. */
export function markInterrupted(
  db: Database.Database,
  id: number,
  kind: UsageKind,
  reason: string,
): WorkSession | undefined {
  const current = getSession(db, id);
  if (!current || current.lifecycle !== "active") return current;
  const now = Date.now();
  db.prepare(
    "UPDATE work_sessions SET lifecycle = 'interrupted', interrupted_at = ?, interruption_kind = ?, interruption_reason = ? WHERE id = ?",
  ).run(now, kind, reason, id);
  return getSession(db, id);
}

/** Claude reset for `kind` -- the interrupted session (if it matches) is ready to resume. */
export function markReadyToResume(
  db: Database.Database,
  id: number,
  kind: UsageKind,
): WorkSession | undefined {
  const current = getSession(db, id);
  if (!current || current.lifecycle !== "interrupted" || current.interruption_kind !== kind) {
    return current;
  }
  db.prepare("UPDATE work_sessions SET lifecycle = 'ready_to_resume', reset_at = ? WHERE id = ?").run(
    Date.now(),
    id,
  );
  return getSession(db, id);
}

export function resumeSession(db: Database.Database, id: number): WorkSession | undefined {
  const current = getSession(db, id);
  if (!current || current.lifecycle !== "ready_to_resume") return current;
  const now = Date.now();
  db.prepare(
    "UPDATE work_sessions SET lifecycle = 'active', resumed_at = ?, last_activity_at = ? WHERE id = ?",
  ).run(now, now, id);
  return getSession(db, id);
}

export function completeSession(db: Database.Database, id: number): WorkSession | undefined {
  db.prepare("UPDATE work_sessions SET lifecycle = 'completed', completed_at = ? WHERE id = ?").run(
    Date.now(),
    id,
  );
  return getSession(db, id);
}
