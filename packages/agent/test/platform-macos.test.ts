import { test } from "node:test";
import assert from "node:assert/strict";
import { sendNotification, startAutostart, stopAutostart } from "../src/platform/macos.ts";

test("macos sendNotification runs osascript with an escaped display-notification script", async () => {
  const calls: { cmd: string; args: string[] }[] = [];
  const ok = await sendNotification("Title \"quoted\"", "hello \\ world", async (cmd, args) => {
    calls.push({ cmd, args });
  });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "osascript");
  assert.equal(calls[0].args[0], "-e");
  assert.match(calls[0].args[1], /display notification "hello \\\\ world" with title "Title \\"quoted\\""/);
});

test("macos sendNotification returns false instead of throwing when osascript fails", async () => {
  const ok = await sendNotification("t", "m", async () => {
    throw new Error("osascript: command not found");
  });
  assert.equal(ok, false);
});

test("macos startAutostart runs launchctl load and reports success", () => {
  const calls: { cmd: string; args: string[] }[] = [];
  const result = startAutostart((cmd, args) => {
    calls.push({ cmd, args });
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0].cmd, "launchctl");
  assert.equal(calls[0].args[0], "load");
});

test("macos stopAutostart surfaces a launchctl failure instead of throwing", () => {
  const result = stopAutostart(() => {
    throw new Error("launchctl: no such process");
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /launchctl unload failed/);
});
