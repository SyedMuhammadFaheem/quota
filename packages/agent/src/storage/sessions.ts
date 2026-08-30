import type Database from "better-sqlite3";
import path from "node:path";
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

/** Runs an INSERT/UPDATE with a `RETURNING *` clause and maps the row back in one round trip. */
function mutateReturning(db: Database.Database, sql: string, params: unknown[]): WorkSession | undefined {
  const row = db.prepare(sql).get(...params) as WorkSessionRow | undefined;
  return row ? toWorkSession(row) : undefined;
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
  return mutateReturning(
    db,
    "INSERT INTO work_sessions (project, status_text, started_at, last_activity_at) VALUES (?, ?, ?, ?) RETURNING *",
    [project, statusText ?? null, now, now],
  )!;
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
  return mutateReturning(
    db,
    "UPDATE work_sessions SET project = ?, status_text = ?, last_activity_at = ? WHERE id = ? RETURNING *",
    [fields.project ?? current.project, fields.statusText ?? current.status_text, Date.now(), id],
  );
}

export function appendNote(db: Database.Database, id: number, text: string): WorkSession | undefined {
  const current = getSession(db, id);
  if (!current) return undefined;
  const notes = current.notes ? `${current.notes}\n${text}` : text;
  return mutateReturning(
    db,
    "UPDATE work_sessions SET notes = ?, last_activity_at = ? WHERE id = ? RETURNING *",
    [notes, Date.now(), id],
  );
}

export function appendNextTask(db: Database.Database, id: number, text: string): WorkSession | undefined {
  const current = getSession(db, id);
  if (!current) return undefined;
  const nextTasks = [...current.nextTasks, text];
  return mutateReturning(
    db,
    "UPDATE work_sessions SET next_tasks = ?, last_activity_at = ? WHERE id = ? RETURNING *",
    [JSON.stringify(nextTasks), Date.now(), id],
  );
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
  return mutateReturning(
    db,
    "UPDATE work_sessions SET lifecycle = 'interrupted', interrupted_at = ?, interruption_kind = ?, interruption_reason = ? WHERE id = ? RETURNING *",
    [Date.now(), kind, reason, id],
  );
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
  return mutateReturning(
    db,
    "UPDATE work_sessions SET lifecycle = 'ready_to_resume', reset_at = ? WHERE id = ? RETURNING *",
    [Date.now(), id],
  );
}

export function resumeSession(db: Database.Database, id: number): WorkSession | undefined {
  const current = getSession(db, id);
  if (!current || current.lifecycle !== "ready_to_resume") return current;
  const now = Date.now();
  return mutateReturning(
    db,
    "UPDATE work_sessions SET lifecycle = 'active', resumed_at = ?, last_activity_at = ? WHERE id = ? RETURNING *",
    [now, now, id],
  );
}

export interface SessionActivityUpdate {
  statusText?: string;
  note?: string;
  nextTasks?: string[];
}

/**
 * Finds (or creates, named from `cwd`) the current session and applies a status/note/next-task
 * update to it. Shared by the live `/api/internal/session-activity` route and the SessionEnd
 * hook's direct-DB fallback (bin/quota-session-hook.ts) so the two paths can't drift apart.
 */
export function applySessionActivity(
  db: Database.Database,
  update: SessionActivityUpdate,
  cwd?: string,
): WorkSession {
  let session = getCurrentSession(db);
  if (!session) {
    const project = cwd ? path.basename(cwd) : "Untitled session";
    session = startSession(db, project);
  }
  if (update.statusText) session = updateSession(db, session.id, { statusText: update.statusText }) ?? session;
  if (update.note) session = appendNote(db, session.id, update.note) ?? session;
  for (const t of update.nextTasks ?? []) {
    if (!session.nextTasks.includes(t)) session = appendNextTask(db, session.id, t) ?? session;
  }
  return session;
}

export function completeSession(db: Database.Database, id: number): WorkSession | undefined {
  return mutateReturning(
    db,
    "UPDATE work_sessions SET lifecycle = 'completed', completed_at = ? WHERE id = ? RETURNING *",
    [Date.now(), id],
  );
}
