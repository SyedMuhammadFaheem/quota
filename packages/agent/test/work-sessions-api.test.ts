import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type Database from "better-sqlite3";
import { openDb } from "../src/storage/db.ts";
import { createApp } from "../src/api/server.ts";
import { Notifier } from "../src/notifications/notifier.ts";
import { markInterrupted, markReadyToResume } from "../src/storage/sessions.ts";

async function withServer(fn: (base: string, db: Database.Database) => Promise<void>) {
  const db = openDb(":memory:");
  const notifier = new Notifier(db, { osNotifications: false });
  const app = createApp({ db, notifier });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}`, db);
  } finally {
    server.close();
  }
}

test("work session lifecycle via the HTTP API", async () => {
  await withServer(async (base) => {
    const empty = await (await fetch(`${base}/api/work-sessions/current`)).json();
    assert.equal(empty.session, null);

    const create = await fetch(`${base}/api/work-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "Redis Pattern Profiler", statusText: "Implementing pattern detection" }),
    });
    assert.equal(create.status, 201);
    const session = await create.json();
    assert.equal(session.project, "Redis Pattern Profiler");
    assert.equal(session.lifecycle, "active");

    await fetch(`${base}/api/work-sessions/${session.id}/note`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Investigate Redis timeout handling" }),
    });
    await fetch(`${base}/api/work-sessions/${session.id}/next`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Fix authentication" }),
    });

    const current = await (await fetch(`${base}/api/work-sessions/current`)).json();
    assert.equal(current.session.notes, "Investigate Redis timeout handling");
    assert.deepEqual(current.session.nextTasks, ["Fix authentication"]);

    const status = await (await fetch(`${base}/api/status`)).json();
    assert.equal(status.session.id, session.id);

    const complete = await fetch(`${base}/api/work-sessions/${session.id}/complete`, { method: "POST" });
    assert.equal((await complete.json()).lifecycle, "completed");

    const history = await (await fetch(`${base}/api/work-sessions`)).json();
    assert.equal(history.sessions.length, 1);
    assert.equal(history.sessions[0].lifecycle, "completed");
  });
});

test("POST /api/work-sessions rejects a missing project", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/work-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });
});

test("session-activity auto-creates a session named from cwd when none is open", async () => {
  await withServer(async (base) => {
    await fetch(`${base}/api/internal/session-activity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ statusText: "Implementing pattern detection", cwd: "/Users/dev/redis-pattern-profiler" }),
    });
    const current = await (await fetch(`${base}/api/work-sessions/current`)).json();
    assert.equal(current.session.project, "redis-pattern-profiler");
    assert.equal(current.session.status_text, "Implementing pattern detection");
  });
});

test("session-activity updates status, appends notes, and dedups next tasks", async () => {
  await withServer(async (base) => {
    const create = await fetch(`${base}/api/work-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "Redis Pattern Profiler" }),
    });
    const session = await create.json();

    await fetch(`${base}/api/internal/session-activity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ statusText: "turn 1", nextTasks: ["Fix authentication"] }),
    });
    await fetch(`${base}/api/internal/session-activity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ statusText: "turn 2", nextTasks: ["Fix authentication", "Add tests"] }),
    });
    await fetch(`${base}/api/internal/session-activity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "[auto] Session ended (other)" }),
    });

    const current = await (await fetch(`${base}/api/work-sessions/current`)).json();
    assert.equal(current.session.id, session.id, "reuses the existing session, doesn't create a new one");
    assert.equal(current.session.status_text, "turn 2", "status is overwritten, not appended");
    assert.deepEqual(current.session.nextTasks, ["Fix authentication", "Add tests"], "next tasks are deduped");
    assert.equal(current.session.notes, "[auto] Session ended (other)");
  });
});

test("resuming only succeeds once a session is ready_to_resume", async () => {
  await withServer(async (base) => {
    const create = await fetch(`${base}/api/work-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "Redis Pattern Profiler" }),
    });
    const session = await create.json();

    const resumeTooSoon = await fetch(`${base}/api/work-sessions/${session.id}/resume`, { method: "POST" });
    assert.equal((await resumeTooSoon.json()).lifecycle, "active", "resume is a no-op outside ready_to_resume");
  });
});

test("POST /api/work-sessions is a no-op error (409) when it would discard a ready_to_resume session, unless forced", async () => {
  await withServer(async (base, db) => {
    const create = await fetch(`${base}/api/work-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "Redis Pattern Profiler" }),
    });
    const session = await create.json();
    markInterrupted(db, session.id, "five_hour", "Claude 5-hour limit reached");
    markReadyToResume(db, session.id, "five_hour");

    const blocked = await fetch(`${base}/api/work-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "Auth rewrite" }),
    });
    assert.equal(blocked.status, 409);
    const body = await blocked.json();
    assert.equal(body.error, "unresumed_session");
    assert.match(body.message, /Redis Pattern Profiler/);
    assert.match(body.message, /ready to resume/);
    assert.equal(body.session.id, session.id);

    // still ready_to_resume -- the blocked request must not have touched it
    const stillCurrent = await (await fetch(`${base}/api/work-sessions/current`)).json();
    assert.equal(stillCurrent.session.id, session.id);
    assert.equal(stillCurrent.session.lifecycle, "ready_to_resume");

    const forced = await fetch(`${base}/api/work-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "Auth rewrite", force: true }),
    });
    assert.equal(forced.status, 201);
    const newSession = await forced.json();
    assert.equal(newSession.project, "Auth rewrite");

    const history = await (await fetch(`${base}/api/work-sessions`)).json();
    const oldEntry = history.sessions.find((s: { id: number }) => s.id === session.id);
    assert.equal(oldEntry.lifecycle, "completed", "forcing past the warning discards the old session as before");
  });
});

test("POST /api/work-sessions is blocked (409) when it would discard an interrupted (not yet reset) session", async () => {
  await withServer(async (base, db) => {
    const create = await fetch(`${base}/api/work-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "Redis Pattern Profiler" }),
    });
    const session = await create.json();
    markInterrupted(db, session.id, "five_hour", "Claude 5-hour limit reached");

    const blocked = await fetch(`${base}/api/work-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "Auth rewrite" }),
    });
    assert.equal(blocked.status, 409);
    const body = await blocked.json();
    assert.match(body.message, /interrupted/);
  });
});

test("POST /api/work-sessions does NOT require force when superseding a plain active session", async () => {
  await withServer(async (base) => {
    await fetch(`${base}/api/work-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "Redis Pattern Profiler" }),
    });

    const second = await fetch(`${base}/api/work-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "Auth rewrite" }),
    });
    assert.equal(second.status, 201, "no warning/force needed when the prior session was just active");
  });
});

test("POST /api/work-sessions/:id/complete is blocked (409) when it would discard a ready_to_resume session, unless forced", async () => {
  await withServer(async (base, db) => {
    const create = await fetch(`${base}/api/work-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "Redis Pattern Profiler" }),
    });
    const session = await create.json();
    markInterrupted(db, session.id, "five_hour", "Claude 5-hour limit reached");
    markReadyToResume(db, session.id, "five_hour");

    const blocked = await fetch(`${base}/api/work-sessions/${session.id}/complete`, { method: "POST" });
    assert.equal(blocked.status, 409);
    const body = await blocked.json();
    assert.equal(body.error, "unresumed_session");

    const stillCurrent = await (await fetch(`${base}/api/work-sessions/current`)).json();
    assert.equal(stillCurrent.session.lifecycle, "ready_to_resume", "blocked complete must not have touched it");

    const forced = await fetch(`${base}/api/work-sessions/${session.id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    assert.equal((await forced.json()).lifecycle, "completed");
  });
});
