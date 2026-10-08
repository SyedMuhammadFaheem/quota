// E2E: drives the real `quota` binary as a subprocess against a real, separately
// spawned agent process -- no in-process shortcuts -- exactly how a user's shell
// and background daemon interact. Isolated via QUOTA_HOME/QUOTA_PORT so it never
// touches the developer's real ~/.quota or ~/.claude/settings.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BIN = path.join(import.meta.dirname, "..", "bin", "quota.ts");
const AGENT_DIR = path.join(import.meta.dirname, "..");

function freePort(): number {
  return 41000 + Math.floor(Math.random() * 8000);
}

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: string,
): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      env,
      cwd: AGENT_DIR,
      encoding: "utf8",
      input,
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", status: e.status ?? 1 };
  }
}

async function waitForAgent(port: number, deadline = Date.now() + 5000): Promise<void> {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/status`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`agent on port ${port} never became reachable`);
}

async function withRealAgent(fn: (env: NodeJS.ProcessEnv, port: number) => Promise<void>) {
  const quotaHome = fs.mkdtempSync(path.join(os.tmpdir(), "quota-e2e-cli-"));
  const port = freePort();
  const env = { ...process.env, QUOTA_HOME: quotaHome, QUOTA_PORT: String(port) };
  const child = spawn(process.execPath, [BIN], { env, cwd: AGENT_DIR, stdio: "pipe" });
  // Subscribe at spawn: if the agent crashes on startup, a listener attached later never fires and the test hangs.
  const exited = new Promise((r) => child.once("exit", r));
  const errChunks: string[] = [];
  child.stderr?.on("data", (d) => errChunks.push(d.toString()));
  try {
    await waitForAgent(port);
    await fn(env, port);
  } finally {
    child.kill("SIGTERM");
    await exited;
    if (errChunks.length) {
      // surface anything the daemon logged to stderr for debugging, but don't fail the test on it
    }
  }
  fs.rmSync(quotaHome, { recursive: true, force: true });
}

test("e2e: CLI reports a clear error when the agent isn't running", () => {
  const quotaHome = fs.mkdtempSync(path.join(os.tmpdir(), "quota-e2e-cli-down-"));
  const env = { ...process.env, QUOTA_HOME: quotaHome, QUOTA_PORT: String(freePort()) };
  try {
    const status = runCli(["status"], env);
    assert.equal(status.status, 1);
    assert.match(status.stderr, /Could not reach the quota agent/);

    const start = runCli(["session", "start", "Some Project"], env);
    assert.equal(start.status, 1);
    assert.match(start.stderr, /Could not reach the quota agent/);
  } finally {
    fs.rmSync(quotaHome, { recursive: true, force: true });
  }
});

test("e2e: full work-session flow through the real CLI against a real agent process", async () => {
  await withRealAgent(async (env) => {
    // no session yet
    const initialStatus = runCli(["session", "status"], env);
    assert.match(initialStatus.stdout, /No active session/);

    const start = runCli(["session", "start", "Redis Pattern Profiler", "Implementing pattern detection"], env);
    assert.match(start.stdout, /Started session #\d+: Redis Pattern Profiler/);

    const note = runCli(["session", "note", "Investigate Redis timeout handling"], env);
    assert.match(note.stdout, /Noted\./);

    const next = runCli(["session", "next", "Fix authentication"], env);
    assert.match(next.stdout, /Added\./);

    const setStatus = runCli(["session", "set", "Waiting on timeout repro"], env);
    assert.match(setStatus.stdout, /Status updated\./);

    const status = runCli(["session", "status"], env);
    assert.match(status.stdout, /Redis Pattern Profiler/);
    assert.match(status.stdout, /Waiting on timeout repro/);
    assert.match(status.stdout, /Fix authentication/);

    const notResumable = runCli(["session", "resume"], env);
    assert.match(notResumable.stdout, /No session is waiting to be resumed/);

    const done = runCli(["session", "done"], env);
    assert.match(done.stdout, /Completed: Redis Pattern Profiler/);

    const history = runCli(["session", "history"], env);
    assert.match(history.stdout, /\[completed\] Redis Pattern Profiler/);
  });
});

async function markCurrentSessionReadyToResume(quotaHome: string): Promise<void> {
  const { openDb } = await import("../src/storage/db.ts");
  const { getCurrentSession, markInterrupted, markReadyToResume } = await import("../src/storage/sessions.ts");
  const db = openDb(path.join(quotaHome, "quota.db"));
  const current = getCurrentSession(db)!;
  markInterrupted(db, current.id, "five_hour", "Claude 5-hour limit reached");
  markReadyToResume(db, current.id, "five_hour");
  db.close();
}

test("e2e: session start warns and requires confirmation before discarding a ready_to_resume session", async () => {
  await withRealAgent(async (env) => {
    runCli(["session", "start", "Redis Pattern Profiler"], env);
    await markCurrentSessionReadyToResume(env.QUOTA_HOME!);

    // Declining leaves the ready_to_resume session untouched and starts nothing new.
    const declined = runCli(["session", "start", "Auth rewrite"], env, "n\n");
    assert.match(declined.stdout, /still ready to resume/);
    assert.match(declined.stdout, /Cancelled\./);
    const afterDecline = runCli(["session", "status"], env);
    assert.match(afterDecline.stdout, /Redis Pattern Profiler \(interrupted\)|Redis Pattern Profiler/);
    const historyAfterDecline = runCli(["session", "history"], env);
    assert.doesNotMatch(historyAfterDecline.stdout, /Auth rewrite/);

    // Confirming proceeds exactly like the old unconditional behavior.
    const confirmed = runCli(["session", "start", "Auth rewrite"], env, "y\n");
    assert.match(confirmed.stdout, /still ready to resume/);
    assert.match(confirmed.stdout, /Started session #\d+: Auth rewrite/);
    const historyAfterConfirm = runCli(["session", "history"], env);
    assert.match(historyAfterConfirm.stdout, /\[active\] Auth rewrite/);
    assert.match(historyAfterConfirm.stdout, /\[completed\] Redis Pattern Profiler/);
  });
});

test("e2e: session start does not prompt when superseding a plain active session", async () => {
  await withRealAgent(async (env) => {
    runCli(["session", "start", "Redis Pattern Profiler"], env);
    // no stdin provided at all -- if this prompted, it would hang and the test would time out
    const second = runCli(["session", "start", "Auth rewrite"], env, "");
    assert.doesNotMatch(second.stdout, /Continue\?/);
    assert.match(second.stdout, /Started session #\d+: Auth rewrite/);
  });
});

test("e2e: task queue flow through the real CLI against a real agent process", async () => {
  await withRealAgent(async (env) => {
    const add = runCli(["tasks", "add", "Fix the thing", "-p", "5"], env);
    assert.match(add.stdout, /Added #\d+: Fix the thing/);
    const id = add.stdout.match(/#(\d+)/)![1];

    const list = runCli(["tasks", "list"], env);
    assert.match(list.stdout, new RegExp(`#${id} \\[pending\\] \\(p5\\) Fix the thing`));

    const complete = runCli(["tasks", "complete", id], env);
    assert.match(complete.stdout, new RegExp(`Completed #${id}`));

    const missing = runCli(["tasks", "complete", "999999"], env);
    assert.match(missing.stdout, /No task #999999/);

    const del = runCli(["tasks", "delete", id], env);
    assert.match(del.stdout, new RegExp(`Deleted #${id}`));
  });
});

test("e2e: notify test reaches the real agent and reports per-channel results", async () => {
  await withRealAgent(async (env) => {
    const result = runCli(["notify", "test"], env);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Test results:/);
  });
});

test("e2e: setup wizard completes and writes both files when driven by piped multi-line stdin", () => {
  // Regression test: readline's `.question()` drops lines that arrive in the same buffered
  // chunk as the one it's currently waiting on (common for piped/redirected stdin), which
  // used to make `quota setup` silently abandon the wizard partway through. See cmdSetup's
  // `makePrompter` helper -- this exercises the exact failure mode it fixes.
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "quota-e2e-setup-home-"));
  const quotaHome = fs.mkdtempSync(path.join(os.tmpdir(), "quota-e2e-setup-quota-"));
  const env = { ...process.env, HOME: fakeHome, QUOTA_HOME: quotaHome };
  try {
    const result = execFileSync(process.execPath, [BIN, "setup"], {
      env,
      cwd: AGENT_DIR,
      encoding: "utf8",
      input: "mytopic\n\nmytoken\nmychat\nn\nn\n",
    });
    assert.match(result, /Setup complete/);

    const envFile = fs.readFileSync(path.join(quotaHome, ".env"), "utf8");
    assert.match(envFile, /NTFY_TOPIC=mytopic/);
    assert.match(envFile, /TELEGRAM_BOT_TOKEN=mytoken/);
    assert.match(envFile, /TELEGRAM_CHAT_ID=mychat/);
    assert.match(envFile, /OS_NOTIFICATIONS=false/);

    const settings = JSON.parse(fs.readFileSync(path.join(fakeHome, ".claude", "settings.json"), "utf8"));
    assert.equal(settings.statusLine.command, "quota-statusline");
    assert.equal(settings.hooks.Stop[0].hooks[0].command, "quota-session-hook");
    assert.equal(settings.hooks.SessionEnd[0].hooks[0].command, "quota-session-hook");
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(quotaHome, { recursive: true, force: true });
  }
});

test("e2e: state persists across an agent restart (same QUOTA_HOME)", async () => {
  const quotaHome = fs.mkdtempSync(path.join(os.tmpdir(), "quota-e2e-restart-"));
  const port = freePort();
  const env = { ...process.env, QUOTA_HOME: quotaHome, QUOTA_PORT: String(port) };

  const spawnAgent = () => {
    const child = spawn(process.execPath, [BIN], { env, cwd: AGENT_DIR, stdio: "ignore" });
    return { child, exited: new Promise((r) => child.once("exit", r)) };
  };

  let agent = spawnAgent();
  try {
    await waitForAgent(port);
    runCli(["session", "start", "Persisted Project"], env);
  } finally {
    agent.child.kill("SIGTERM");
    await agent.exited;
  }

  agent = spawnAgent();
  try {
    await waitForAgent(port);
    const status = runCli(["session", "status"], env);
    assert.match(status.stdout, /Persisted Project/);
  } finally {
    agent.child.kill("SIGTERM");
    await agent.exited;
  }

  fs.rmSync(quotaHome, { recursive: true, force: true });
});
