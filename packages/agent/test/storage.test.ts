import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/storage/db.ts";
import { insertSnapshot, latestSnapshot, recordResetEvent, recentResetEvents } from "../src/storage/snapshots.ts";
import { getSetting, setSetting, getSettingJson, setSettingJson } from "../src/storage/settings.ts";
import { createTask, completeTask, listTasks, nextRecommendedTask, deleteTask } from "../src/storage/tasks.ts";
import { logNotification, wasTriggerSent } from "../src/storage/notifications-log.ts";

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
