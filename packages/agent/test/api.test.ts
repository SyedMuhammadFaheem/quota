import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { openDb } from "../src/storage/db.ts";
import { createApp } from "../src/api/server.ts";
import { Notifier } from "../src/notifications/notifier.ts";
import { insertSnapshot } from "../src/storage/snapshots.ts";

async function withServer(fn: (base: string) => Promise<void>) {
  const db = openDb(":memory:");
  const notifier = new Notifier(db, { osNotifications: false });
  const app = createApp({ db, notifier });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
  return db;
}

test("GET /api/status reflects the latest ingested snapshot", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/status`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.usage.five_hour, null);
    assert.equal(body.nextTask, null);
  });
});

test("task lifecycle via the HTTP API", async () => {
  await withServer(async (base) => {
    const create = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Fix Redis Pattern Profiler", priority: 5 }),
    });
    assert.equal(create.status, 201);
    const task = await create.json();
    assert.equal(task.title, "Fix Redis Pattern Profiler");

    const list = await (await fetch(`${base}/api/tasks?status=pending`)).json();
    assert.equal(list.tasks.length, 1);

    const status = await (await fetch(`${base}/api/status`)).json();
    assert.equal(status.nextTask.id, task.id);

    const patch = await fetch(`${base}/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    assert.equal((await patch.json()).status, "done");

    const del = await fetch(`${base}/api/tasks/${task.id}`, { method: "DELETE" });
    assert.equal(del.status, 204);
  });
});

test("POST /api/tasks rejects a missing title", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });
});

test("POST /api/notify/test reports per-channel results without a real send", async () => {
  // no channels configured in withServer's Notifier, so this never touches the network
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/notify/test`, { method: "POST" });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(body.results, []);
  });
});

test("state persists across a simulated agent restart (reopen the same db file)", async () => {
  const os = await import("node:os");
  const path = await import("node:path");
  const fs = await import("node:fs");
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "quota-test-")), "quota.db");

  let db = openDb(dbFile);
  insertSnapshot(db, {
    capturedAt: Date.now(),
    source: "statusline",
    raw: {},
    windows: [{ kind: "five_hour", utilization: 50, resetsAt: Date.now() + 60_000 }],
  });
  db.close();

  db = openDb(dbFile);
  const notifier = new Notifier(db, { osNotifications: false });
  const app = createApp({ db, notifier });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    assert.equal(res.usage.five_hour.utilization, 50);
  } finally {
    server.close();
  }
});

test("only localhost callers are allowed: foreign Origin and foreign Host are rejected", async () => {
  const http = await import("node:http");
  await withServer(async (base) => {
    const noOrigin = await fetch(`${base}/api/status`);
    assert.equal(noOrigin.status, 200, "CLI/hook callers send no Origin");
    assert.equal(noOrigin.headers.get("access-control-allow-origin"), null);

    const dashboard = await fetch(`${base}/api/status`, { headers: { origin: "http://localhost:3000" } });
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.headers.get("access-control-allow-origin"), "http://localhost:3000");

    const evil = await fetch(`${base}/api/notify/test`, { method: "POST", headers: { origin: "https://evil.example" } });
    assert.equal(evil.status, 403);

    // DNS rebinding: a foreign hostname resolving to 127.0.0.1 arrives with its own Host header.
    const rebound = await new Promise<number>((resolve, reject) => {
      http
        .get(`${base}/api/status`, { headers: { host: "evil.example:4317" } }, (res) => {
          res.resume();
          resolve(res.statusCode!);
        })
        .on("error", reject);
    });
    assert.equal(rebound, 403);
  });
});

test("bad input gets a JSON 4xx, never a 500 or an HTML stack trace", async () => {
  await withServer(async (base) => {
    const badLimit = await fetch(`${base}/api/work-sessions?limit=abc`);
    assert.equal(badLimit.status, 200);
    assert.equal((await fetch(`${base}/api/notifications?limit=-1`)).status, 200);

    const badPriority = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "t", priority: "high" }),
    });
    assert.equal(badPriority.status, 400);
    assert.match((await badPriority.json()).error, /priority/);

    const task = await (
      await fetch(`${base}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "t", priority: 2 }),
      })
    ).json();
    const badPatch = await fetch(`${base}/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ priority: "high" }),
    });
    assert.equal(badPatch.status, 400);

    const badJson = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{bad json",
    });
    assert.equal(badJson.status, 400);
    assert.match(badJson.headers.get("content-type") ?? "", /application\/json/);
    assert.doesNotMatch(await badJson.text(), /<html|at .*\.js/i);
  });
});
