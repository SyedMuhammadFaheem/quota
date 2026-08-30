import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AutostartResult } from "./types.ts";

const execFileAsync = promisify(execFile);

type AsyncRunner = (cmd: string, args: string[]) => Promise<unknown>;
type SpawnFn = (cmd: string, args: string[]) => ChildProcess;

const defaultAsyncRunner: AsyncRunner = (cmd, args) => execFileAsync(cmd, args);
const defaultSpawn: SpawnFn = (cmd, args) => spawn(cmd, args, { detached: true, stdio: "ignore" });

export function startupDir(): string {
  const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}

export function startupScriptPath(): string {
  return path.join(startupDir(), "quota-agent.cmd");
}

// Mirrors storage/db.ts's QUOTA_DIR, resolved per-call (not at import time) so tests can
// point it at a temp dir via QUOTA_HOME without touching the developer's real ~/.quota.
function quotaDir(): string {
  return process.env.QUOTA_HOME ?? path.join(os.homedir(), ".quota");
}

function pidFile(): string {
  return path.join(quotaDir(), "agent.pid");
}

export function generateStartupScript(nodePath: string, entryScript: string): string {
  return `@echo off\r\n"${nodePath}" "${entryScript}"\r\n`;
}

/**
 * No extra dependency: a PowerShell one-liner driving the .NET Windows Forms
 * balloon-tip API, which ships with every Windows install. Reliable enough for a
 * best-effort desktop ping; Telegram/ntfy remain the dependable remote channels.
 */
export async function sendNotification(
  title: string,
  message: string,
  run: AsyncRunner = defaultAsyncRunner,
): Promise<boolean> {
  const escape = (s: string) => s.replace(/'/g, "''");
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$n = New-Object System.Windows.Forms.NotifyIcon",
    "$n.Icon = [System.Drawing.SystemIcons]::Information",
    "$n.Visible = $true",
    `$n.ShowBalloonTip(5000, '${escape(title)}', '${escape(message)}', [System.Windows.Forms.ToolTipIcon]::Info)`,
    "Start-Sleep -Milliseconds 500",
    "$n.Dispose()",
  ].join("; ");
  try {
    await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
    return true;
  } catch {
    return false;
  }
}

export function isAutostartInstalled(): boolean {
  return fs.existsSync(startupScriptPath());
}

/** Drops a .cmd into the per-user Startup folder -- no admin rights needed, unlike a Windows Service. */
export function installAutostart(nodePath: string, entryScript: string): AutostartResult {
  try {
    fs.mkdirSync(startupDir(), { recursive: true });
    fs.writeFileSync(startupScriptPath(), generateStartupScript(nodePath, entryScript));
    return {
      ok: true,
      message: `Installed a startup script at ${startupScriptPath()} (runs at next login). Run "quota start" now to start it immediately.`,
    };
  } catch (err) {
    return {
      ok: false,
      message:
        `Could not install autostart (${(err as Error).message}). Start the agent manually with "quota start", ` +
        `or add "${nodePath} ${entryScript}" to Task Scheduler / your Startup folder yourself.`,
    };
  }
}

/** No Windows Service is installed, so "start" launches the agent detached and tracks its pid for `stop`. */
export function startAutostart(
  nodePath: string,
  entryScript: string,
  spawnFn: SpawnFn = defaultSpawn,
): AutostartResult {
  try {
    const child = spawnFn(nodePath, [entryScript]);
    child.unref();
    fs.mkdirSync(quotaDir(), { recursive: true });
    fs.writeFileSync(pidFile(), String(child.pid));
    return { ok: true, message: "Started quota agent in the background." };
  } catch (err) {
    return { ok: false, message: `Could not start agent: ${(err as Error).message}` };
  }
}

export function stopAutostart(kill: (pid: number) => void = (pid) => process.kill(pid)): AutostartResult {
  if (!fs.existsSync(pidFile())) {
    return {
      ok: false,
      message: `No background agent tracked by quota. If it's running in the foreground, press Ctrl+C there.`,
    };
  }
  const pid = Number(fs.readFileSync(pidFile(), "utf8"));
  try {
    kill(pid);
  } catch (err) {
    fs.rmSync(pidFile(), { force: true });
    return { ok: false, message: `Could not stop agent (pid ${pid}): ${(err as Error).message}` };
  }
  fs.rmSync(pidFile(), { force: true });
  return { ok: true, message: "Stopped background agent." };
}
