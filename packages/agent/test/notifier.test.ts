import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/storage/db.ts";
import { Notifier } from "../src/notifications/notifier.ts";
import { recentNotifications } from "../src/storage/notifications-log.ts";

test("threshold crossing sends once and dedups repeat crossings of the same window", async () => {
  const db = openDb(":memory:");
  const notifier = new Notifier(db, { ntfy: { topic: "test" }, osNotifications: false });
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

test("concurrent notifyThresholds calls for the same crossing only send once (claim race)", async () => {
  const db = openDb(":memory:");
  const notifier = new Notifier(db, { ntfy: { topic: "test" }, osNotifications: false });
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  // Simulate a slow network call: both concurrent notifyThresholds() calls reach their
  // dedup check before either one's fetch resolves and logs the trigger.
  globalThis.fetch = (async () => {
    fetchCalls++;
    await new Promise((r) => setTimeout(r, 10));
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  try {
    const snapshot = {
      capturedAt: 1,
      source: "statusline" as const,
      raw: {},
      windows: [{ kind: "five_hour" as const, utilization: 82, resetsAt: 9999 }],
    };
    await Promise.all([notifier.notifyThresholds(snapshot), notifier.notifyThresholds(snapshot)]);
    assert.equal(fetchCalls, 1, "the trigger is claimed synchronously, so only one concurrent call sends");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a threshold under an unknown resets_at renotifies on a new day instead of being suppressed forever", async () => {
  const db = openDb(":memory:");
  const notifier = new Notifier(db, { ntfy: { topic: "test" }, osNotifications: false });
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  try {
    const day1 = Date.UTC(2026, 0, 1, 12);
    const day2 = Date.UTC(2026, 0, 2, 12);
    await notifier.notifyThresholds({
      capturedAt: day1,
      source: "statusline",
      raw: {},
      windows: [{ kind: "five_hour", utilization: 82, resetsAt: undefined }],
    });
    assert.equal(fetchCalls, 1);

    await notifier.notifyThresholds({
      capturedAt: day1 + 1000,
      source: "statusline",
      raw: {},
      windows: [{ kind: "five_hour", utilization: 83, resetsAt: undefined }],
    });
    assert.equal(fetchCalls, 1, "still the same day and threshold -- deduped as before");

    await notifier.notifyThresholds({
      capturedAt: day2,
      source: "statusline",
      raw: {},
      windows: [{ kind: "five_hour", utilization: 82, resetsAt: undefined }],
    });
    assert.equal(fetchCalls, 2, "a new day is a new cycle key, so it renotifies instead of staying suppressed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reset notification fires once per reset event", async () => {
  const db = openDb(":memory:");
  const notifier = new Notifier(db, { ntfy: { topic: "test" }, osNotifications: false });
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
