import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnvFile, writeEnvFile, loadConfig } from "../src/config.ts";

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) original[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("OS_NOTIFICATIONS controls osNotifications, defaulting to true", () => {
  withEnv({ OS_NOTIFICATIONS: undefined, MAC_NOTIFICATIONS: undefined }, () => {
    assert.equal(loadConfig().osNotifications, true);
  });
  withEnv({ OS_NOTIFICATIONS: "false", MAC_NOTIFICATIONS: undefined }, () => {
    assert.equal(loadConfig().osNotifications, false);
  });
});

test("MAC_NOTIFICATIONS=false still disables notifications for old .env files (backwards-compat alias)", () => {
  withEnv({ OS_NOTIFICATIONS: undefined, MAC_NOTIFICATIONS: "false" }, () => {
    assert.equal(loadConfig().osNotifications, false);
  });
});

test("OS_NOTIFICATIONS takes precedence when both keys are set", () => {
  withEnv({ OS_NOTIFICATIONS: "true", MAC_NOTIFICATIONS: "false" }, () => {
    assert.equal(loadConfig().osNotifications, true);
  });
});

test("writeEnvFile/loadEnvFile round-trip the OS_NOTIFICATIONS key", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quota-config-test-"));
  const file = path.join(dir, ".env");
  try {
    writeEnvFile({ OS_NOTIFICATIONS: "false" }, file);
    assert.deepEqual(loadEnvFile(file), { OS_NOTIFICATIONS: "false" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
