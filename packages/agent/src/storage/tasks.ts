import type Database from "better-sqlite3";

export interface Task {
  id: number;
  title: string;
  priority: number;
  status: "pending" | "done";
  created_at: number;
  completed_at: number | null;
}

/** Runs an INSERT/UPDATE with a `RETURNING *` clause and returns the row in one round trip. */
function mutateReturning(db: Database.Database, sql: string, params: unknown[]): Task | undefined {
  return db.prepare(sql).get(...params) as Task | undefined;
}

export function createTask(db: Database.Database, title: string, priority = 0): Task {
  return mutateReturning(
    db,
    "INSERT INTO tasks (title, priority, status, created_at) VALUES (?, ?, 'pending', ?) RETURNING *",
    [title, priority, Date.now()],
  )!;
}

export function getTask(db: Database.Database, id: number): Task | undefined {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Task | undefined;
}

export function listTasks(db: Database.Database, status?: "pending" | "done"): Task[] {
  if (status) {
    return db
      .prepare("SELECT * FROM tasks WHERE status = ? ORDER BY priority DESC, created_at ASC")
      .all(status) as Task[];
  }
  return db.prepare("SELECT * FROM tasks ORDER BY priority DESC, created_at ASC").all() as Task[];
}

export function nextRecommendedTask(db: Database.Database): Task | undefined {
  return db
    .prepare(
      "SELECT * FROM tasks WHERE status = 'pending' ORDER BY priority DESC, created_at ASC LIMIT 1",
    )
    .get() as Task | undefined;
}

export function completeTask(db: Database.Database, id: number): Task | undefined {
  return mutateReturning(
    db,
    "UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ? RETURNING *",
    [Date.now(), id],
  );
}

export function updateTask(
  db: Database.Database,
  id: number,
  fields: { title?: string; priority?: number },
): Task | undefined {
  const current = getTask(db, id);
  if (!current) return undefined;
  return mutateReturning(
    db,
    "UPDATE tasks SET title = ?, priority = ? WHERE id = ? RETURNING *",
    [fields.title ?? current.title, fields.priority ?? current.priority, id],
  );
}

export function deleteTask(db: Database.Database, id: number): boolean {
  const info = db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  return info.changes > 0;
}
