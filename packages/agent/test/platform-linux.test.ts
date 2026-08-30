import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  sendNotification,
  installAutostart,
  isAutostartInstalled,
  startAutostart,
  stopAutostart,
} from "../src/platform/linux.ts";
import { unitPath } from "../src/platform/systemd.ts";

test("linux sendNotification runs notify-send with title and message", async () => {
  const calls: { cmd: string; args: string[] }[] = [];
  const ok = await sendNotification("Claude Quota", "hello", async (cmd, args) => {
    calls.push({ cmd, args });
  });
  assert.equal(ok, true);
  assert.deepEqual(calls[0], { cmd: "notify-send", args: ["Claude Quota", "hello"] });
});

test("linux sendNotification returns false when notify-send is missing (headless/no daemon)", async () => {
  const ok = await sendNotification("t", "m", async () => {
    throw new Error("ENOENT");
  });
  assert.equal(ok, false);
});

test("linux installAutostart writes a systemd user unit and enables it", () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "quota-linux-home-"));
  const originalHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    assert.equal(isAutostartInstalled(), false);
    const calls: { cmd: string; args: string[] }[] = [];
    const result = installAutostart("/usr/bin/node", "/opt/quota/bin/quota.ts", (cmd, args) => {
      calls.push({ cmd, args });
    });
    assert.equal(result.ok, true);
    assert.equal(isAutostartInstalled(), true);
    assert.match(fs.readFileSync(unitPath(), "utf8"), /ExecStart=\/usr\/bin\/node \/opt\/quota\/bin\/quota\.ts/);
    assert.deepEqual(
      calls.map((c) => c.args[1]),
      ["daemon-reload", "enable"],
    );
  } finally {
    process.env.HOME = originalHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("linux installAutostart reports failure without throwing when systemctl is unavailable", () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "quota-linux-home-"));
  const originalHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const result = installAutostart("/usr/bin/node", "/opt/quota/bin/quota.ts", () => {
      throw new Error("systemctl: command not found");
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /enabling it failed/);
  } finally {
    process.env.HOME = originalHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("linux startAutostart/stopAutostart drive systemctl --user", () => {
  const startCalls: string[][] = [];
  const startResult = startAutostart((cmd, args) => {
    startCalls.push(args);
    assert.equal(cmd, "systemctl");
  });
  assert.equal(startResult.ok, true);
  assert.deepEqual(startCalls[0], ["--user", "start", "quota-agent.service"]);

  const stopResult = stopAutostart(() => {
    throw new Error("unit not loaded");
  });
  assert.equal(stopResult.ok, false);
  assert.match(stopResult.message, /systemctl --user stop failed/);
});
