import type Database from "better-sqlite3";

export function logNotification(
  db: Database.Database,
  channel: string,
  message: string,
  triggerKey: string,
): void {
  db.prepare(
    "INSERT INTO notifications_log (sent_at, channel, message, trigger_key) VALUES (?, ?, ?, ?)",
  ).run(Date.now(), channel, message, triggerKey);
}

export function wasTriggerSent(db: Database.Database, triggerKey: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM notifications_log WHERE trigger_key = ? LIMIT 1")
    .get(triggerKey);
  return row !== undefined;
}

export function recentNotifications(db: Database.Database, limit: number) {
  return db
    .prepare("SELECT * FROM notifications_log ORDER BY sent_at DESC LIMIT ?")
    .all(limit);
}
