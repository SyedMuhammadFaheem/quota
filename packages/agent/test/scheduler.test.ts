import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/storage/db.ts";
import { insertSnapshot, recentResetEvents } from "../src/storage/snapshots.ts";
import { Scheduler } from "../src/scheduler/scheduler.ts";

function fakeClock(start: number) {
  let time = start;
  let seq = 0;
  const pending: { id: number; at: number; fn: () => void }[] = [];
  const setTimeoutFn = ((fn: () => void, delay: number) => {
    const entry = { id: ++seq, at: time + delay, fn };
    pending.push(entry);
    return entry.id as unknown as NodeJS.Timeout;
  }) as unknown as typeof setTimeout;
  const clearTimeoutFn = ((id: unknown) => {
    const idx = pending.findIndex((e) => e.id === id);
    if (idx !== -1) pending.splice(idx, 1);
  }) as unknown as typeof clearTimeout;
  return {
    now: () => time,
    setTimeoutFn,
    clearTimeoutFn,
    // runs due timers, advancing time as needed; returns number fired
    advanceTo(target: number) {
      time = target;
      let fired = 0;
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i].at <= time) {
          const [entry] = pending.splice(i, 1);
          entry.fn();
          fired++;
        }
      }
      return fired;
    },
  };
}

test("scheduler fires reset alarm exactly at persisted resets_at, no polling required", async () => {
  const db = openDb(":memory:");
  const clock = fakeClock(1_000_000);
  insertSnapshot(db, {
    capturedAt: clock.now(),
    source: "statusline",
    raw: {},
    windows: [{ kind: "five_hour", utilization: 90, resetsAt: clock.now() + 10_000 }],
  });

  const resets: string[] = [];
  const scheduler = new Scheduler({
    db,
    poll: async () => undefined,
    onReset: (kind) => resets.push(kind),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    pollIntervalMs: 999_999_999,
  });
  scheduler.start();

  clock.advanceTo(clock.now() + 5_000);
  assert.deepEqual(resets, [], "the initial cold-start poll firing must not itself trigger a reset");
  clock.advanceTo(1_000_000 + 10_000);
  assert.deepEqual(resets, ["five_hour"]);

  const events = recentResetEvents(db, 10);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "five_hour");
});

test("scheduler catches up immediately if resets_at already passed on startup", async () => {
  const db = openDb(":memory:");
  const clock = fakeClock(2_000_000);
  insertSnapshot(db, {
    capturedAt: clock.now() - 20_000,
    source: "statusline",
    raw: {},
    windows: [{ kind: "five_hour", utilization: 100, resetsAt: clock.now() - 5_000 }],
  });

  const resets: string[] = [];
  const scheduler = new Scheduler({
    db,
    poll: async () => undefined,
    onReset: (kind) => resets.push(kind),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    pollIntervalMs: 999_999_999,
  });
  scheduler.start();

  // delay is clamped to 0, so it fires on the very next tick
  clock.advanceTo(clock.now());
  assert.deepEqual(resets, ["five_hour"]);
});

test("ingest reschedules the alarm when a new resets_at arrives", async () => {
  const db = openDb(":memory:");
  const clock = fakeClock(0);
  const resets: string[] = [];
  const scheduler = new Scheduler({
    db,
    poll: async () => undefined,
    onReset: (kind) => resets.push(kind),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    pollIntervalMs: 999_999_999,
  });
  scheduler.start();

  scheduler.ingest({
    capturedAt: clock.now(),
    source: "statusline",
    raw: {},
    windows: [{ kind: "five_hour", utilization: 10, resetsAt: 10_000 }],
  });
  scheduler.ingest({
    capturedAt: clock.now(),
    source: "statusline",
    raw: {},
    windows: [{ kind: "five_hour", utilization: 20, resetsAt: 20_000 }],
  });

  clock.advanceTo(10_000);
  assert.deepEqual(resets, [], "original 10s alarm should have been cleared");
  clock.advanceTo(20_000);
  assert.deepEqual(resets, ["five_hour"]);
});

test("a past resets_at re-sent or replayed on restart fires its reset only once", async () => {
  const db = openDb(":memory:");
  const clock = fakeClock(3_000_000);
  const resets: string[] = [];
  const makeScheduler = () =>
    new Scheduler({
      db,
      poll: async () => undefined,
      onReset: (kind) => resets.push(kind),
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      pollIntervalMs: 999_999_999,
    });
  const stale = {
    capturedAt: clock.now(),
    source: "statusline" as const,
    raw: {},
    windows: [{ kind: "five_hour" as const, utilization: 20, resetsAt: clock.now() - 60_000 }],
  };

  const first = makeScheduler();
  first.start();
  for (let i = 0; i < 3; i++) {
    first.ingest(stale);
    clock.advanceTo(clock.now() + 1);
  }
  first.stop();

  const restarted = makeScheduler();
  restarted.start();
  clock.advanceTo(clock.now() + 1);

  assert.deepEqual(resets, ["five_hour"]);
  assert.equal(recentResetEvents(db, 10).length, 1);
});
