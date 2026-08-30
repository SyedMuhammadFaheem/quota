import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { generateUnit, unitPath, UNIT_NAME } from "./systemd.ts";
import type { AutostartResult } from "./types.ts";

const execFileAsync = promisify(execFile);

type Runner = (cmd: string, args: string[]) => void;
type AsyncRunner = (cmd: string, args: string[]) => Promise<unknown>;

const defaultRunner: Runner = (cmd, args) => {
  execFileSync(cmd, args);
};
const defaultInheritRunner: Runner = (cmd, args) => {
  execFileSync(cmd, args, { stdio: "inherit" });
};
const defaultAsyncRunner: AsyncRunner = (cmd, args) => execFileAsync(cmd, args);

/** Requires a `notify-send`-providing daemon (present on virtually every desktop Linux). */
export async function sendNotification(
  title: string,
  message: string,
  run: AsyncRunner = defaultAsyncRunner,
): Promise<boolean> {
  try {
    await run("notify-send", [title, message]);
    return true;
  } catch {
    return false;
  }
}

export function isAutostartInstalled(): boolean {
  return fs.existsSync(unitPath());
}

export function installAutostart(
  nodePath: string,
  entryScript: string,
  run: Runner = defaultRunner,
): AutostartResult {
  fs.mkdirSync(path.dirname(unitPath()), { recursive: true });
  fs.writeFileSync(unitPath(), generateUnit(nodePath, entryScript));
  try {
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", UNIT_NAME]);
    return {
      ok: true,
      message:
        `Wrote systemd user unit to ${unitPath()} and enabled it (starts automatically at login). ` +
        `To also have it running before you log in, run: loginctl enable-linger $USER`,
    };
  } catch (err) {
    return {
      ok: false,
      message:
        `Wrote systemd user unit to ${unitPath()}, but enabling it failed: ${(err as Error).message}. ` +
        `Run "systemctl --user enable --now ${UNIT_NAME}" manually.`,
    };
  }
}

export function startAutostart(run: Runner = defaultInheritRunner): AutostartResult {
  try {
    run("systemctl", ["--user", "start", UNIT_NAME]);
    return { ok: true, message: "Started via systemd." };
  } catch (err) {
    return { ok: false, message: `systemctl --user start failed: ${(err as Error).message}` };
  }
}

export function stopAutostart(run: Runner = defaultInheritRunner): AutostartResult {
  try {
    run("systemctl", ["--user", "stop", UNIT_NAME]);
    return { ok: true, message: "Stopped systemd unit." };
  } catch (err) {
    return { ok: false, message: `systemctl --user stop failed: ${(err as Error).message}` };
  }
}
