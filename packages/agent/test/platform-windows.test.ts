import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  sendNotification,
  installAutostart,
  isAutostartInstalled,
  startAutostart,
  stopAutostart,
  startupScriptPath,
} from "../src/platform/windows.ts";

function withFakeAppData<T>(fn: () => T): T {
  const fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), "quota-win-appdata-"));
  const original = process.env.APPDATA;
  process.env.APPDATA = fakeAppData;
  try {
    return fn();
  } finally {
    process.env.APPDATA = original;
    fs.rmSync(fakeAppData, { recursive: true, force: true });
  }
}

test("windows sendNotification drives a PowerShell balloon-tip script", async () => {
  const calls: { cmd: string; args: string[] }[] = [];
  const ok = await sendNotification("Claude Quota", "hello", async (cmd, args) => {
    calls.push({ cmd, args });
  });
  assert.equal(ok, true);
  assert.equal(calls[0].cmd, "powershell");
  assert.match(calls[0].args.join(" "), /ShowBalloonTip.*Claude Quota.*hello/);
});

test("windows sendNotification returns false, not a throw, when PowerShell is unavailable", async () => {
  const ok = await sendNotification("t", "m", async () => {
    throw new Error("ENOENT");
  });
  assert.equal(ok, false);
});

test("windows installAutostart writes a .cmd into the Startup folder", () => {
  withFakeAppData(() => {
    assert.equal(isAutostartInstalled(), false);
    const result = installAutostart("C:\\node\\node.exe", "C:\\quota\\bin\\quota.ts");
    assert.equal(result.ok, true);
    assert.equal(isAutostartInstalled(), true);
    const script = fs.readFileSync(startupScriptPath(), "utf8");
    assert.match(script, /"C:\\node\\node.exe" "C:\\quota\\bin\\quota.ts"/);
  });
});

test("windows startAutostart spawns detached and stopAutostart kills the tracked pid", () => {
  withFakeAppData(() => {
    const fakeQuotaHome = fs.mkdtempSync(path.join(os.tmpdir(), "quota-win-home-"));
    const originalQuotaHome = process.env.QUOTA_HOME;
    process.env.QUOTA_HOME = fakeQuotaHome;
    try {
      const fakeChild = Object.assign(new EventEmitter(), { pid: 4242, unref: () => {} });
      const startResult = startAutostart(
        "C:\\node\\node.exe",
        "C:\\quota\\bin\\quota.ts",
        () => fakeChild as any,
      );
      assert.equal(startResult.ok, true);
      assert.equal(fs.readFileSync(path.join(fakeQuotaHome, "agent.pid"), "utf8"), "4242");

      const killed: number[] = [];
      const stopResult = stopAutostart((pid) => killed.push(pid));
      assert.equal(stopResult.ok, true);
      assert.deepEqual(killed, [4242]);

      // second stop: pid file already removed, fails gracefully instead of throwing
      const secondStop = stopAutostart((pid) => killed.push(pid));
      assert.equal(secondStop.ok, false);
      assert.match(secondStop.message, /No background agent tracked/);
    } finally {
      process.env.QUOTA_HOME = originalQuotaHome;
      fs.rmSync(fakeQuotaHome, { recursive: true, force: true });
    }
  });
});
