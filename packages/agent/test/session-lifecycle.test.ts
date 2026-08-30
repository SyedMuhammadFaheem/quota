import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/storage/db.ts";
import { Scheduler } from "../src/scheduler/scheduler.ts";
import { Notifier } from "../src/notifications/notifier.ts";
import { buildSchedulerCallbacks } from "../src/index.ts";
import { startSession, getCurrentSession, markInterrupted, markReadyToResume } from "../src/storage/sessions.ts";

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

test("hitting 100% interrupts the active session, and the matching reset makes it ready to resume", async () => {
  const db = openDb(":memory:");
  const clock = fakeClock(1_000_000);
  const notifier = new Notifier(db, { macNotifications: false });
  const sentMessages: string[] = [];
  const originalSend = notifier.send.bind(notifier);
  notifier.send = async (message: string, triggerKey: string) => {
    sentMessages.push(message);
    return originalSend(message, triggerKey);
  };

  startSession(db, "Redis Pattern Profiler", "Implementing pattern detection");

  const callbacks = buildSchedulerCallbacks(db, notifier);
  const resets: string[] = [];
  const scheduler = new Scheduler({
    db,
    poll: async () => undefined,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    pollIntervalMs: 999_999_999,
    onReset: (kind) => {
      resets.push(kind);
      callbacks.onReset(kind);
    },
    onSnapshot: callbacks.onSnapshot,
  });
  scheduler.start();

  // Claude limit hit: ingest a snapshot at 100% utilization with a resets_at 10s out.
  scheduler.ingest({
    capturedAt: clock.now(),
    source: "statusline",
    raw: {},
    windows: [{ kind: "five_hour", utilization: 100, resetsAt: clock.now() + 10_000 }],
  });

  const interrupted = getCurrentSession(db)!;
  assert.equal(interrupted.lifecycle, "interrupted");
  assert.equal(interrupted.interruption_kind, "five_hour");

  // Claude resets.
  clock.advanceTo(clock.now() + 10_000);
  assert.deepEqual(resets, ["five_hour"]);

  const readyToResume = getCurrentSession(db)!;
  assert.equal(readyToResume.lifecycle, "ready_to_resume");
  assert.ok(readyToResume.reset_at);

  // The reset notification should read as a Resume Brief, not a bare "reset" ping.
  // (A threshold-crossing notification also fires on the 100% snapshot itself, via
  // the now-wired-up notifyThresholds -- that's an additional, earlier message.)
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sentMessages.length, 2);
  const resumeBrief = sentMessages[sentMessages.length - 1];
  assert.match(resumeBrief, /Redis Pattern Profiler/);
  assert.match(resumeBrief, /quota session resume/);
});

test("hitting 100% on the seven_day window also interrupts and resumes the session (not just five_hour)", async () => {
  const db = openDb(":memory:");
  const clock = fakeClock(1_000_000);
  const notifier = new Notifier(db, { macNotifications: false });

  startSession(db, "Redis Pattern Profiler", "Implementing pattern detection");

  const callbacks = buildSchedulerCallbacks(db, notifier);
  const resets: string[] = [];
  const scheduler = new Scheduler({
    db,
    poll: async () => undefined,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    pollIntervalMs: 999_999_999,
    onReset: (kind) => {
      resets.push(kind);
      callbacks.onReset(kind);
    },
    onSnapshot: callbacks.onSnapshot,
  });
  scheduler.start();

  scheduler.ingest({
    capturedAt: clock.now(),
    source: "statusline",
    raw: {},
    windows: [{ kind: "seven_day", utilization: 100, resetsAt: clock.now() + 10_000 }],
  });

  const interrupted = getCurrentSession(db)!;
  assert.equal(interrupted.lifecycle, "interrupted");
  assert.equal(interrupted.interruption_kind, "seven_day");

  clock.advanceTo(clock.now() + 10_000);
  assert.deepEqual(resets, ["seven_day"]);

  const readyToResume = getCurrentSession(db)!;
  assert.equal(readyToResume.lifecycle, "ready_to_resume");
});

test("session lifecycle survives an agent restart (reopen the same db file)", async () => {
  const os = await import("node:os");
  const path = await import("node:path");
  const fs = await import("node:fs");
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "quota-session-test-")), "quota.db");

  let db = openDb(dbFile);
  const session = startSession(db, "Redis Pattern Profiler", "Implementing pattern detection");
  markInterrupted(db, session.id, "five_hour", "Claude 5-hour limit reached");
  db.close();

  // simulate process restart
  db = openDb(dbFile);
  const stillInterrupted = getCurrentSession(db)!;
  assert.equal(stillInterrupted.lifecycle, "interrupted");
  assert.equal(stillInterrupted.project, "Redis Pattern Profiler");

  const ready = markReadyToResume(db, stillInterrupted.id, "five_hour");
  assert.equal(ready?.lifecycle, "ready_to_resume");
  db.close();
});
