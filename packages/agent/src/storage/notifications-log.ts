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

/**
 * Atomically claims a trigger key: returns true only for the caller that wins the
 * claim, false for every other (including concurrent) caller. Synchronous and
 * runs before any await, so two overlapping notifier.send() calls for the same
 * trigger can't both pass a check-then-act race the way a separate SELECT+INSERT
 * (or reading notifications_log, which is only written *after* the async sends
 * resolve) would allow.
 */
export function claimTrigger(db: Database.Database, triggerKey: string, now = Date.now()): boolean {
  const info = db
    .prepare("INSERT OR IGNORE INTO sent_triggers (trigger_key, claimed_at) VALUES (?, ?)")
    .run(triggerKey, now);
  return info.changes === 1;
}

export function recentNotifications(db: Database.Database, limit: number) {
  return db
    .prepare("SELECT * FROM notifications_log ORDER BY sent_at DESC LIMIT ?")
    .all(limit);
}
