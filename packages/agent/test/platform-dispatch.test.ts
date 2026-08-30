import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adapters,
  sendNativeNotification,
  isAutostartInstalled,
  installAutostart,
  startAutostart,
  stopAutostart,
} from "../src/platform/index.ts";

function fakeAdapter(name: string) {
  const calls: string[] = [];
  return {
    calls,
    adapter: {
      sendNotification: async (title: string, message: string) => {
        calls.push(`notify:${name}:${title}:${message}`);
        return true;
      },
      isAutostartInstalled: () => {
        calls.push(`installed:${name}`);
        return true;
      },
      installAutostart: (nodePath: string, entryScript: string) => {
        calls.push(`install:${name}:${nodePath}:${entryScript}`);
        return { ok: true, message: `installed on ${name}` };
      },
      startAutostart: (nodePath: string, entryScript: string) => {
        calls.push(`start:${name}:${nodePath}:${entryScript}`);
        return { ok: true, message: `started on ${name}` };
      },
      stopAutostart: () => {
        calls.push(`stop:${name}`);
        return { ok: true, message: `stopped on ${name}` };
      },
    },
  };
}

test("real adapters registry wires darwin/linux/win32 to distinct implementations", () => {
  assert.ok(adapters.darwin);
  assert.ok(adapters.linux);
  assert.ok(adapters.win32);
  assert.notEqual(adapters.darwin!.sendNotification, adapters.linux!.sendNotification);
  assert.notEqual(adapters.linux!.sendNotification, adapters.win32!.sendNotification);
});

for (const platform of ["darwin", "linux", "win32"] as const) {
  test(`dispatch routes every call to the ${platform} adapter and nowhere else`, async () => {
    const { calls, adapter } = fakeAdapter(platform);
    const registry = { [platform]: adapter };

    assert.equal(await sendNativeNotification("Title", "msg", platform, registry), true);
    assert.equal(isAutostartInstalled(platform, registry), true);
    assert.deepEqual(installAutostart("node", "entry.ts", platform, registry), {
      ok: true,
      message: `installed on ${platform}`,
    });
    assert.deepEqual(startAutostart("node", "entry.ts", platform, registry), {
      ok: true,
      message: `started on ${platform}`,
    });
    assert.deepEqual(stopAutostart(platform, registry), { ok: true, message: `stopped on ${platform}` });

    assert.deepEqual(calls, [
      `notify:${platform}:Title:msg`,
      `installed:${platform}`,
      `install:${platform}:node:entry.ts`,
      `start:${platform}:node:entry.ts`,
      `stop:${platform}`,
    ]);
  });
}

test("an unsupported platform never crashes -- notifications no-op, autostart reports clearly", async () => {
  const registry = {};
  assert.equal(await sendNativeNotification("t", "m", "freebsd" as NodeJS.Platform, registry), false);
  assert.equal(isAutostartInstalled("freebsd" as NodeJS.Platform, registry), false);

  const install = installAutostart("node", "entry.ts", "freebsd" as NodeJS.Platform, registry);
  assert.equal(install.ok, false);
  assert.match(install.message, /No autostart support for platform "freebsd"/);

  const start = startAutostart("node", "entry.ts", "freebsd" as NodeJS.Platform, registry);
  assert.equal(start.ok, false);

  const stop = stopAutostart("freebsd" as NodeJS.Platform, registry);
  assert.equal(stop.ok, false);
});

test("sendNativeNotification never throws even if the underlying adapter rejects", async () => {
  const registry = {
    linux: {
      sendNotification: async () => {
        throw new Error("boom");
      },
      isAutostartInstalled: () => false,
      installAutostart: () => ({ ok: false, message: "n/a" }),
      startAutostart: () => ({ ok: false, message: "n/a" }),
      stopAutostart: () => ({ ok: false, message: "n/a" }),
    },
  };
  const ok = await sendNativeNotification("t", "m", "linux", registry);
  assert.equal(ok, false);
});
