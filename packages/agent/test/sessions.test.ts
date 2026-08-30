import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/storage/db.ts";
import {
  startSession,
  getCurrentSession,
  getSession,
  listSessions,
  updateSession,
  appendNote,
  appendNextTask,
  markInterrupted,
  markReadyToResume,
  resumeSession,
  completeSession,
} from "../src/storage/sessions.ts";

function testDb() {
  return openDb(":memory:");
}

test("starting a session makes it current, with the right defaults", () => {
  const db = testDb();
  const s = startSession(db, "Redis Pattern Profiler", "Implementing pattern detection");
  assert.equal(s.project, "Redis Pattern Profiler");
  assert.equal(s.status_text, "Implementing pattern detection");
  assert.deepEqual(s.nextTasks, []);
  assert.equal(s.lifecycle, "active");
  assert.equal(getCurrentSession(db)?.id, s.id);
});

test("starting a new session completes the previous open one", () => {
  const db = testDb();
  const first = startSession(db, "Redis Pattern Profiler");
  const second = startSession(db, "Auth rewrite");
  assert.equal(getSession(db, first.id)?.lifecycle, "completed");
  assert.equal(getCurrentSession(db)?.id, second.id);
});

test("notes and next tasks accumulate", () => {
  const db = testDb();
  const s = startSession(db, "Redis Pattern Profiler");
  appendNote(db, s.id, "Investigate timeout handling");
  appendNote(db, s.id, "Also check retry logic");
  appendNextTask(db, s.id, "Fix authentication");
  appendNextTask(db, s.id, "Add integration tests");
  const updated = getSession(db, s.id)!;
  assert.equal(updated.notes, "Investigate timeout handling\nAlso check retry logic");
  assert.deepEqual(updated.nextTasks, ["Fix authentication", "Add integration tests"]);
});

test("updateSession changes project/status without touching other fields", () => {
  const db = testDb();
  const s = startSession(db, "Redis Pattern Profiler", "old status");
  const updated = updateSession(db, s.id, { statusText: "new status" });
  assert.equal(updated?.project, "Redis Pattern Profiler");
  assert.equal(updated?.status_text, "new status");
});

test("full interruption/reset/resume lifecycle", () => {
  const db = testDb();
  const s = startSession(db, "Redis Pattern Profiler");

  const interrupted = markInterrupted(db, s.id, "five_hour", "Claude 5-hour limit reached");
  assert.equal(interrupted?.lifecycle, "interrupted");
  assert.equal(interrupted?.interruption_kind, "five_hour");
  assert.ok(interrupted?.interrupted_at);

  // a seven_day reset shouldn't resolve a five_hour interruption
  const stillInterrupted = markReadyToResume(db, s.id, "seven_day");
  assert.equal(stillInterrupted?.lifecycle, "interrupted");

  const ready = markReadyToResume(db, s.id, "five_hour");
  assert.equal(ready?.lifecycle, "ready_to_resume");
  assert.ok(ready?.reset_at);

  const resumed = resumeSession(db, s.id);
  assert.equal(resumed?.lifecycle, "active");
  assert.ok(resumed?.resumed_at);

  // history preserves the full timeline even after resuming
  const full = getSession(db, s.id)!;
  assert.ok(full.interrupted_at && full.reset_at && full.resumed_at);
});

test("starting a new session supersedes one that's interrupted or ready_to_resume (documented, not just active)", () => {
  const db = testDb();
  const interruptedFirst = startSession(db, "First (interrupted)");
  markInterrupted(db, interruptedFirst.id, "five_hour", "limit reached");
  const second = startSession(db, "Second");
  assert.equal(getSession(db, interruptedFirst.id)?.lifecycle, "completed");
  assert.equal(getCurrentSession(db)?.id, second.id);

  const readyThird = startSession(db, "Third (ready to resume)");
  markInterrupted(db, readyThird.id, "five_hour", "limit reached");
  markReadyToResume(db, readyThird.id, "five_hour");
  const fourth = startSession(db, "Fourth");
  assert.equal(getSession(db, readyThird.id)?.lifecycle, "completed", "Resume Brief is discarded, not preserved");
  assert.equal(getCurrentSession(db)?.id, fourth.id);
});

test("markInterrupted is a no-op outside the active state", () => {
  const db = testDb();
  const s = startSession(db, "Redis Pattern Profiler");
  markInterrupted(db, s.id, "five_hour", "limit reached");
  const again = markInterrupted(db, s.id, "five_hour", "limit reached again");
  assert.equal(again?.interruption_reason, "limit reached", "already interrupted, second call ignored");
});

test("completeSession and history ordering", () => {
  const db = testDb();
  const first = startSession(db, "First");
  completeSession(db, first.id);
  const second = startSession(db, "Second");
  const history = listSessions(db, 10);
  assert.equal(history.length, 2);
  assert.equal(history[0].id, second.id, "newest first");
  assert.equal(history[1].lifecycle, "completed");
});
