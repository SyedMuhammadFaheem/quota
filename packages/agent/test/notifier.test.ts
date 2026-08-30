import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/storage/db.ts";
import { Notifier } from "../src/notifications/notifier.ts";
import { recentNotifications } from "../src/storage/notifications-log.ts";

test("threshold crossing sends once and dedups repeat crossings of the same window", async () => {
  const db = openDb(":memory:");
  const notifier = new Notifier(db, { ntfy: { topic: "test" }, macNotifications: false });
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  try {
    await notifier.notifyThresholds({
      capturedAt: 1,
      source: "statusline",
      raw: {},
      windows: [{ kind: "five_hour", utilization: 82, resetsAt: 9999 }],
    });
    assert.equal(fetchCalls, 1, "82% crosses the 80% threshold, should send once");

    await notifier.notifyThresholds({
      capturedAt: 2,
      source: "statusline",
      raw: {},
      windows: [{ kind: "five_hour", utilization: 85, resetsAt: 9999 }],
    });
    assert.equal(fetchCalls, 1, "still under the 90% threshold for the same window, no new send");

    await notifier.notifyThresholds({
      capturedAt: 3,
      source: "statusline",
      raw: {},
      windows: [{ kind: "five_hour", utilization: 91, resetsAt: 9999 }],
    });
    assert.equal(fetchCalls, 2, "crossing 90% is a new trigger key");

    const logs = recentNotifications(db, 10) as { trigger_key: string }[];
    assert.equal(logs.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reset notification fires once per reset event", async () => {
  const db = openDb(":memory:");
  const notifier = new Notifier(db, { ntfy: { topic: "test" }, macNotifications: false });
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  try {
    await notifier.notifyReset("five_hour", 1000);
    await notifier.notifyReset("five_hour", 1000);
    assert.equal(fetchCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
