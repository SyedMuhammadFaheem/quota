import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { generatePlist, plistPath, logDir } from "../launchd/plist.ts";
import type { AutostartResult } from "./types.ts";

const execFileAsync = promisify(execFile);

function escapeForAppleScript(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

type Runner = (cmd: string, args: string[]) => void;
type AsyncRunner = (cmd: string, args: string[]) => Promise<unknown>;

const defaultRunner: Runner = (cmd, args) => {
  execFileSync(cmd, args);
};
const defaultInheritRunner: Runner = (cmd, args) => {
  execFileSync(cmd, args, { stdio: "inherit" });
};
const defaultAsyncRunner: AsyncRunner = (cmd, args) => execFileAsync(cmd, args);

export async function sendNotification(
  title: string,
  message: string,
  run: AsyncRunner = defaultAsyncRunner,
): Promise<boolean> {
  const script = `display notification "${escapeForAppleScript(message)}" with title "${escapeForAppleScript(title)}"`;
  try {
    await run("osascript", ["-e", script]);
    return true;
  } catch {
    return false;
  }
}

export function isAutostartInstalled(): boolean {
  return fs.existsSync(plistPath());
}

export function installAutostart(
  nodePath: string,
  entryScript: string,
  run: Runner = defaultRunner,
): AutostartResult {
  fs.mkdirSync(logDir(), { recursive: true });
  fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
  fs.writeFileSync(plistPath(), generatePlist(nodePath, entryScript));
  try {
    run("launchctl", ["load", plistPath()]);
    return {
      ok: true,
      message: `Wrote launchd plist to ${plistPath()} and loaded it (starts automatically at login).`,
    };
  } catch (err) {
    return {
      ok: false,
      message: `Wrote launchd plist to ${plistPath()}, but launchctl load failed: ${(err as Error).message}`,
    };
  }
}

export function startAutostart(run: Runner = defaultInheritRunner): AutostartResult {
  try {
    run("launchctl", ["load", plistPath()]);
    return { ok: true, message: "Started via launchd." };
  } catch (err) {
    return { ok: false, message: `launchctl load failed: ${(err as Error).message}` };
  }
}

export function stopAutostart(run: Runner = defaultInheritRunner): AutostartResult {
  try {
    run("launchctl", ["unload", plistPath()]);
    return { ok: true, message: "Stopped launchd agent." };
  } catch (err) {
    return { ok: false, message: `launchctl unload failed: ${(err as Error).message}` };
  }
}
