import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/storage/db.ts";
import { insertSnapshot, latestSnapshot, recordResetEvent, recentResetEvents } from "../src/storage/snapshots.ts";
import { getSetting, setSetting, getSettingJson, setSettingJson } from "../src/storage/settings.ts";
import { createTask, completeTask, listTasks, nextRecommendedTask, deleteTask } from "../src/storage/tasks.ts";
import { logNotification, wasTriggerSent, claimTrigger } from "../src/storage/notifications-log.ts";

function testDb() {
  return openDb(":memory:");
}

test("settings round-trip", () => {
  const db = testDb();
  assert.equal(getSetting(db, "missing"), undefined);
  setSetting(db, "foo", "bar");
  assert.equal(getSetting(db, "foo"), "bar");
  setSetting(db, "foo", "baz");
  assert.equal(getSetting(db, "foo"), "baz");
  setSettingJson(db, "thresholds", [80, 90]);
  assert.deepEqual(getSettingJson(db, "thresholds", []), [80, 90]);
  assert.deepEqual(getSettingJson(db, "missing-json", { x: 1 }), { x: 1 });
});

test("snapshots insert and latest", () => {
  const db = testDb();
  insertSnapshot(db, {
    capturedAt: 1000,
    source: "statusline",
    raw: { a: 1 },
    windows: [{ kind: "five_hour", utilization: 42, resetsAt: 5000 }],
  });
  insertSnapshot(db, {
    capturedAt: 2000,
    source: "statusline",
    raw: { a: 2 },
    windows: [{ kind: "five_hour", utilization: 55, resetsAt: 5000 }],
  });
  const latest = latestSnapshot(db, "five_hour");
  assert.equal(latest?.utilization, 55);
  assert.equal(latest?.captured_at, 2000);
});

test("reset events recorded and listed newest first", () => {
  const db = testDb();
  recordResetEvent(db, "five_hour", 1000);
  recordResetEvent(db, "five_hour", 2000);
  const events = recentResetEvents(db, 10);
  assert.equal(events.length, 2);
  assert.equal(events[0].occurred_at, 2000);
});

test("tasks CRUD and recommendation ordering", () => {
  const db = testDb();
  const low = createTask(db, "low priority", 1);
  const high = createTask(db, "high priority", 5);
  assert.equal(nextRecommendedTask(db)?.id, high.id);
  const pending = listTasks(db, "pending");
  assert.equal(pending.length, 2);
  const done = completeTask(db, high.id);
  assert.equal(done?.status, "done");
  assert.equal(nextRecommendedTask(db)?.id, low.id);
  assert.equal(deleteTask(db, low.id), true);
  assert.equal(deleteTask(db, low.id), false);
});

test("notification dedup by trigger key", () => {
  const db = testDb();
  assert.equal(wasTriggerSent(db, "five_hour:80"), false);
  logNotification(db, "ntfy", "hit 80%", "five_hour:80");
  assert.equal(wasTriggerSent(db, "five_hour:80"), true);
});

test("claimTrigger wins exactly once per trigger key, regardless of call order", () => {
  const db = testDb();
  assert.equal(claimTrigger(db, "five_hour:80"), true, "first claim wins");
  assert.equal(claimTrigger(db, "five_hour:80"), false, "second claim on the same key loses");
  assert.equal(claimTrigger(db, "five_hour:90"), true, "a different key is unaffected");
});

test("openDb prunes usage_snapshots/notifications_log/sent_triggers older than the retention window", async () => {
  const os = await import("node:os");
  const path = await import("node:path");
  const fs = await import("node:fs");
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "quota-retention-test-")), "quota.db");

  const THIRTY_ONE_DAYS_AGO = Date.now() - 31 * 24 * 60 * 60 * 1000;
  const NOW = Date.now();

  let db = openDb(dbFile);
  insertSnapshot(db, {
    capturedAt: THIRTY_ONE_DAYS_AGO,
    source: "statusline",
    raw: {},
    windows: [{ kind: "five_hour", utilization: 50, resetsAt: undefined }],
  });
  insertSnapshot(db, {
    capturedAt: NOW,
    source: "statusline",
    raw: {},
    windows: [{ kind: "five_hour", utilization: 60, resetsAt: undefined }],
  });
  logNotification(db, "ntfy", "old", "old:trigger");
  db.prepare("UPDATE notifications_log SET sent_at = ? WHERE trigger_key = ?").run(
    THIRTY_ONE_DAYS_AGO,
    "old:trigger",
  );
  logNotification(db, "ntfy", "recent", "recent:trigger");
  claimTrigger(db, "old:claim", THIRTY_ONE_DAYS_AGO);
  claimTrigger(db, "recent:claim", NOW);
  db.close();

  // Reopening re-runs pruneOldData -- this is where the 31-day-old rows get swept.
  db = openDb(dbFile);
  const snapshots = db.prepare("SELECT utilization FROM usage_snapshots").all() as { utilization: number }[];
  assert.deepEqual(snapshots.map((s) => s.utilization), [60], "only the recent snapshot survives");

  const notifications = db.prepare("SELECT trigger_key FROM notifications_log").all() as { trigger_key: string }[];
  assert.deepEqual(notifications.map((n) => n.trigger_key), ["recent:trigger"]);

  const triggers = db.prepare("SELECT trigger_key FROM sent_triggers").all() as { trigger_key: string }[];
  assert.deepEqual(triggers.map((t) => t.trigger_key), ["recent:claim"]);
  db.close();
});
