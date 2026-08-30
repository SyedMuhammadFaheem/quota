import type Database from "better-sqlite3";
import type { UsageKind, UsageSnapshot, UsageSource } from "../provider/types.ts";

export interface SnapshotRow {
  id: number;
  captured_at: number;
  kind: UsageKind;
  utilization: number;
  resets_at: number | null;
  source: UsageSource;
  raw_json: string | null;
}

export function insertSnapshot(db: Database.Database, snapshot: UsageSnapshot): void {
  const stmt = db.prepare(
    `INSERT INTO usage_snapshots (captured_at, kind, utilization, resets_at, source, raw_json)
     VALUES (@captured_at, @kind, @utilization, @resets_at, @source, @raw_json)`,
  );
  const insertMany = db.transaction((windows: UsageSnapshot["windows"]) => {
    for (const w of windows) {
      stmt.run({
        captured_at: snapshot.capturedAt,
        kind: w.kind,
        utilization: w.utilization,
        resets_at: w.resetsAt ?? null,
        source: snapshot.source,
        raw_json: JSON.stringify(snapshot.raw),
      });
    }
  });
  insertMany(snapshot.windows);
}

export function latestSnapshot(db: Database.Database, kind: UsageKind): SnapshotRow | undefined {
  return db
    .prepare(
      "SELECT * FROM usage_snapshots WHERE kind = ? ORDER BY captured_at DESC LIMIT 1",
    )
    .get(kind) as SnapshotRow | undefined;
}

export function recentSnapshots(
  db: Database.Database,
  kind: UsageKind,
  limit: number,
): SnapshotRow[] {
  return db
    .prepare(
      "SELECT * FROM usage_snapshots WHERE kind = ? ORDER BY captured_at DESC LIMIT ?",
    )
    .all(kind, limit) as SnapshotRow[];
}

export function averageUtilization(db: Database.Database, kind: UsageKind): number | undefined {
  const row = db
    .prepare("SELECT AVG(utilization) AS avg FROM usage_snapshots WHERE kind = ?")
    .get(kind) as { avg: number | null };
  return row.avg ?? undefined;
}

export function recordResetEvent(db: Database.Database, kind: UsageKind, occurredAt: number): void {
  db.prepare("INSERT INTO reset_events (kind, occurred_at, notified) VALUES (?, ?, 0)").run(
    kind,
    occurredAt,
  );
}

export function markResetEventsNotified(db: Database.Database, kind: UsageKind): void {
  db.prepare("UPDATE reset_events SET notified = 1 WHERE kind = ? AND notified = 0").run(kind);
}

export function recentResetEvents(db: Database.Database, limit: number) {
  return db
    .prepare("SELECT * FROM reset_events ORDER BY occurred_at DESC LIMIT ?")
    .all(limit) as { id: number; kind: UsageKind; occurred_at: number; notified: number }[];
}
