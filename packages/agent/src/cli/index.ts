import { Command } from "commander";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { openDb } from "../storage/db.ts";
import { setSetting } from "../storage/settings.ts";
import { createTask, listTasks, completeTask, deleteTask } from "../storage/tasks.ts";
import { writeEnvFile, loadEnvFile, ENV_PATH, AGENT_PORT } from "../config.ts";
import { generatePlist, plistPath, logDir } from "../launchd/plist.ts";

const AGENT_BASE = `http://127.0.0.1:${AGENT_PORT}`;
const STATUSLINE_BIN = "quota-statusline";
const SESSION_HOOK_BIN = "quota-session-hook";
const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");

interface SessionDto {
  id: number;
  project: string;
  status_text: string | null;
  notes: string | null;
  nextTasks: string[];
  lifecycle: "active" | "interrupted" | "ready_to_resume" | "completed";
  started_at: number;
}

async function apiGet(pathname: string) {
  const res = await fetch(`${AGENT_BASE}${pathname}`);
  if (!res.ok) throw new Error(`agent returned ${res.status} for ${pathname}`);
  return res.json();
}

async function apiCall(method: string, pathname: string, body?: unknown) {
  const res = await fetch(`${AGENT_BASE}${pathname}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

function formatCountdown(resetsAt: number | null | undefined): string {
  if (!resetsAt) return "unknown";
  const ms = resetsAt - Date.now();
  if (ms <= 0) return "now";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function printSessionBrief(session: SessionDto | null) {
  if (!session) return;
  if (session.lifecycle === "ready_to_resume") {
    console.log("Welcome back.\n");
    console.log(`You were working on:\n${session.project}\n`);
    if (session.status_text) console.log(`Last state:\n${session.status_text}\n`);
    if (session.nextTasks.length) {
      console.log("Next:");
      session.nextTasks.forEach((t, i) => console.log(`${i + 1}. ${t}`));
      console.log("");
    }
    if (session.notes) console.log(`Note:\n${session.notes}\n`);
    console.log("Claude is available again. Run `quota session resume` to pick back up.\n");
    return;
  }
  console.log(`Session: ${session.project}${session.lifecycle === "interrupted" ? " (interrupted)" : ""}`);
  if (session.status_text) console.log(`Status: ${session.status_text}`);
  if (session.nextTasks.length) console.log(`Next: ${session.nextTasks[0]}`);
  console.log("");
}

async function cmdStatus() {
  try {
    const status = await apiGet("/api/status");
    printSessionBrief(status.session ?? null);
    for (const kind of ["five_hour", "seven_day"] as const) {
      const usage = status.usage[kind];
      const label = kind === "five_hour" ? "5-hour session" : "Weekly";
      if (!usage) {
        console.log(`${label}: no data yet (open Claude Code once, or wait for the next poll)`);
        continue;
      }
      console.log(
        `${label}: ${Math.round(usage.utilization)}% used, resets in ${formatCountdown(usage.resetsAt)}`,
      );
    }
    if (status.nextTask) {
      console.log(`Next queued task: ${status.nextTask.title}`);
    }
  } catch {
    console.error("Could not reach the quota agent. Is it running? Try `quota start`.");
    process.exitCode = 1;
  }
}

/**
 * Sequential prompt helper built on the readline Interface's async iterator instead of
 * repeated `rl.question()` calls. `question()` only attaches its one-shot 'line' listener
 * when invoked, but readline drains all buffered stdin into 'line' events as soon as it
 * arrives -- when input comes in as a single chunk (piped/redirected stdin, common for
 * automated or scripted setup), every line after the first fires with no listener attached
 * yet and is silently dropped, hanging or short-circuiting the wizard. The async iterator
 * queues 'line' events internally instead of discarding them, so no answer is lost
 * regardless of whether stdin is a live TTY or a piped/redirected source.
 */
function makePrompter(rl: readline.Interface) {
  const lines = rl[Symbol.asyncIterator]();
  return async function ask(prompt: string): Promise<string> {
    process.stdout.write(prompt);
    const { value, done } = await lines.next();
    return done ? "" : value;
  };
}

async function cmdSetup() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = makePrompter(rl);
  console.log("Claude Quota setup\n-------------------");

  const existing = loadEnvFile();
  const ntfyTopic = await ask(`ntfy topic (leave blank to skip) [${existing.NTFY_TOPIC ?? ""}]: `);
  const ntfyServer = ntfyTopic ? await ask("ntfy server [https://ntfy.sh]: ") : "";
  const telegramBotToken = await ask("Telegram bot token (leave blank to skip): ");
  const telegramChatId = telegramBotToken ? await ask("Telegram chat id: ") : "";
  const macAnswer = await ask("Enable macOS notifications? [Y/n]: ");

  writeEnvFile({
    NTFY_TOPIC: ntfyTopic || existing.NTFY_TOPIC || "",
    NTFY_SERVER: ntfyServer || existing.NTFY_SERVER || "",
    TELEGRAM_BOT_TOKEN: telegramBotToken || existing.TELEGRAM_BOT_TOKEN || "",
    TELEGRAM_CHAT_ID: telegramChatId || existing.TELEGRAM_CHAT_ID || "",
    MAC_NOTIFICATIONS: /^n/i.test(macAnswer) ? "false" : "true",
  });
  console.log(`Saved notification config to ${ENV_PATH}`);

  installStatusLine();
  installSessionHooks();

  const launchd = await ask("Install a launchd agent so quota starts automatically at login? [Y/n]: ");
  rl.close();
  if (!/^n/i.test(launchd)) installLaunchd();

  console.log("\nSetup complete. Run `quota start` to launch the agent, `quota status` to check usage.");
  process.exit(0);
}

function installStatusLine() {
  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
    try {
      settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, "utf8"));
    } catch {
      console.warn(`Could not parse ${CLAUDE_SETTINGS_PATH}, leaving it untouched.`);
      return;
    }
  }
  const current = settings.statusLine as { command?: string } | undefined;
  if (current?.command && !current.command.includes(STATUSLINE_BIN)) {
    const db = openDb();
    setSetting(db, "chain_statusline_command", current.command);
    db.close();
    console.log(`Chaining your existing statusLine command: ${current.command}`);
  }
  settings.statusLine = { type: "command", command: STATUSLINE_BIN };
  fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
  console.log(`Installed statusLine hook in ${CLAUDE_SETTINGS_PATH}`);
}

interface HookHandler {
  type: string;
  command?: string;
  [key: string]: unknown;
}
interface HookMatcherGroup {
  matcher?: string;
  hooks: HookHandler[];
}

/** Installs quota-session-hook on Stop and SessionEnd, without disturbing any hooks the user already has. */
function installSessionHooks() {
  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
    try {
      settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, "utf8"));
    } catch {
      console.warn(`Could not parse ${CLAUDE_SETTINGS_PATH}, leaving it untouched.`);
      return;
    }
  }
  const hooks = (settings.hooks as Record<string, HookMatcherGroup[]> | undefined) ?? {};
  for (const event of ["Stop", "SessionEnd"] as const) {
    const groups = hooks[event] ?? [];
    const alreadyInstalled = groups.some((g) => g.hooks?.some((h) => h.command === SESSION_HOOK_BIN));
    if (!alreadyInstalled) {
      groups.push({ hooks: [{ type: "command", command: SESSION_HOOK_BIN }] });
    }
    hooks[event] = groups;
  }
  settings.hooks = hooks;
  fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
  console.log(`Installed automatic session capture (Stop/SessionEnd hooks) in ${CLAUDE_SETTINGS_PATH}`);
}

function installLaunchd() {
  const nodePath = process.execPath;
  const entryScript = path.resolve(import.meta.dirname, "..", "..", "bin", "quota.ts");
  fs.mkdirSync(logDir(), { recursive: true });
  fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
  fs.writeFileSync(plistPath(), generatePlist(nodePath, entryScript));
  console.log(`Wrote launchd plist to ${plistPath()}`);
  try {
    execFileSync("launchctl", ["load", plistPath()]);
    console.log("Loaded launchd agent (starts automatically at login).");
  } catch (err) {
    console.warn(`launchctl load failed: ${(err as Error).message}`);
  }
}

function cmdStart() {
  if (fs.existsSync(plistPath())) {
    execFileSync("launchctl", ["load", plistPath()], { stdio: "inherit" });
    console.log("Started via launchd.");
    return;
  }
  console.log("No launchd agent installed (run `quota setup` first). Starting in the foreground...");
  import("../index.ts").then((m) => m.startAgent());
}

function cmdStop() {
  if (fs.existsSync(plistPath())) {
    execFileSync("launchctl", ["unload", plistPath()], { stdio: "inherit" });
    console.log("Stopped launchd agent.");
    return;
  }
  console.log(`No launchd agent installed. If quota is running in the foreground, press Ctrl+C there.`);
}

async function cmdNotifyTest() {
  try {
    const res = await apiCall("POST", "/api/notify/test");
    const body = await res.json();
    console.log("Test results:", body.results);
  } catch {
    console.error("Could not reach the quota agent. Is it running? Try `quota start`.");
    process.exitCode = 1;
  }
}

function buildTasksCommand(): Command {
  const tasks = new Command("tasks").description("manage the local task queue");

  tasks
    .command("list")
    .option("--status <status>", "filter by status (pending|done)")
    .action(async (opts) => {
      const db = openDb();
      for (const t of listTasks(db, opts.status)) {
        console.log(`#${t.id} [${t.status}] (p${t.priority}) ${t.title}`);
      }
      db.close();
    });

  tasks
    .command("add <title>")
    .option("-p, --priority <n>", "priority (higher = more urgent)", "0")
    .action((title, opts) => {
      const db = openDb();
      const task = createTask(db, title, Number(opts.priority));
      console.log(`Added #${task.id}: ${task.title}`);
      db.close();
    });

  tasks
    .command("complete <id>")
    .action((id) => {
      const db = openDb();
      const task = completeTask(db, Number(id));
      console.log(task ? `Completed #${task.id}` : `No task #${id}`);
      db.close();
    });

  tasks
    .command("delete <id>")
    .action((id) => {
      const db = openDb();
      const ok = deleteTask(db, Number(id));
      console.log(ok ? `Deleted #${id}` : `No task #${id}`);
      db.close();
    });

  return tasks;
}

const AGENT_UNREACHABLE = "Could not reach the quota agent. Is it running? Try `quota start`.";

async function cmdSessionCurrent(): Promise<SessionDto | null> {
  const { session } = await apiGet("/api/work-sessions/current");
  return session;
}

function buildSessionCommand(): Command {
  const session = new Command("session").description("manage your current work session");

  session
    .command("start <project>")
    .description("start a new work session, checkpointing the previous one")
    .argument("[status]", "what you're doing right now")
    .action(async (project, status) => {
      try {
        let res = await apiCall("POST", "/api/work-sessions", { project, statusText: status });
        if (res.status === 409) {
          const conflict = await res.json();
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const answer = await rl.question(`${conflict.message} Continue? [y/N]: `);
          rl.close();
          if (!/^y/i.test(answer)) {
            console.log("Cancelled.");
            return;
          }
          res = await apiCall("POST", "/api/work-sessions", { project, statusText: status, force: true });
        }
        const created = await res.json();
        console.log(`Started session #${created.id}: ${created.project}`);
      } catch {
        console.error(AGENT_UNREACHABLE);
        process.exitCode = 1;
      }
    });

  session
    .command("set <text>")
    .description("update the current session's status line")
    .action(async (text) => {
      try {
        const current = await cmdSessionCurrent();
        if (!current) {
          console.error("No active session. Run `quota session start <project>` first.");
          process.exitCode = 1;
          return;
        }
        await apiCall("PATCH", `/api/work-sessions/${current.id}`, { statusText: text });
        console.log("Status updated.");
      } catch {
        console.error(AGENT_UNREACHABLE);
        process.exitCode = 1;
      }
    });

  session
    .command("note <text>")
    .description("append a note to the current session")
    .action(async (text) => {
      try {
        const current = await cmdSessionCurrent();
        if (!current) {
          console.error("No active session. Run `quota session start <project>` first.");
          process.exitCode = 1;
          return;
        }
        await apiCall("POST", `/api/work-sessions/${current.id}/note`, { text });
        console.log("Noted.");
      } catch {
        console.error(AGENT_UNREACHABLE);
        process.exitCode = 1;
      }
    });

  session
    .command("next <text>")
    .description("queue a next task on the current session")
    .action(async (text) => {
      try {
        const current = await cmdSessionCurrent();
        if (!current) {
          console.error("No active session. Run `quota session start <project>` first.");
          process.exitCode = 1;
          return;
        }
        await apiCall("POST", `/api/work-sessions/${current.id}/next`, { text });
        console.log("Added.");
      } catch {
        console.error(AGENT_UNREACHABLE);
        process.exitCode = 1;
      }
    });

  session
    .command("status")
    .description("show the current session (a Resume Brief, once Claude has reset)")
    .action(async () => {
      try {
        const current = await cmdSessionCurrent();
        if (!current) {
          console.log("No active session. Run `quota session start <project>` to begin one.");
          return;
        }
        printSessionBrief(current);
      } catch {
        console.error(AGENT_UNREACHABLE);
        process.exitCode = 1;
      }
    });

  session
    .command("resume")
    .description("resume a session that's ready (post Claude-reset)")
    .action(async () => {
      try {
        const current = await cmdSessionCurrent();
        if (!current || current.lifecycle !== "ready_to_resume") {
          console.log("No session is waiting to be resumed.");
          return;
        }
        await apiCall("POST", `/api/work-sessions/${current.id}/resume`);
        console.log(`Resumed: ${current.project}`);
      } catch {
        console.error(AGENT_UNREACHABLE);
        process.exitCode = 1;
      }
    });

  session
    .command("done")
    .description("mark the current session complete")
    .action(async () => {
      try {
        const current = await cmdSessionCurrent();
        if (!current) {
          console.log("No active session.");
          return;
        }
        let res = await apiCall("POST", `/api/work-sessions/${current.id}/complete`);
        if (res.status === 409) {
          const conflict = await res.json();
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const answer = await rl.question(`${conflict.message} Continue? [y/N]: `);
          rl.close();
          if (!/^y/i.test(answer)) {
            console.log("Cancelled.");
            return;
          }
          res = await apiCall("POST", `/api/work-sessions/${current.id}/complete`, { force: true });
        }
        console.log(`Completed: ${current.project}`);
      } catch {
        console.error(AGENT_UNREACHABLE);
        process.exitCode = 1;
      }
    });

  session
    .command("history")
    .option("-n, --limit <n>", "how many sessions to show", "10")
    .action(async (opts) => {
      try {
        const { sessions } = await apiGet(`/api/work-sessions?limit=${opts.limit}`);
        for (const s of sessions as SessionDto[]) {
          console.log(`#${s.id} [${s.lifecycle}] ${s.project}${s.status_text ? ` — ${s.status_text}` : ""}`);
        }
      } catch {
        console.error(AGENT_UNREACHABLE);
        process.exitCode = 1;
      }
    });

  return session;
}

export function buildCli(): Command {
  const program = new Command("quota").description(
    "Never lose your place when your Claude session ends -- local-first work session tracker and reset notifier",
  );

  program.command("status").description("show your current work session and usage/reset countdown").action(cmdStatus);
  program.command("setup").description("interactive setup wizard").action(cmdSetup);
  program.command("start").description("start the background agent").action(cmdStart);
  program.command("stop").description("stop the background agent").action(cmdStop);
  program.addCommand(buildSessionCommand());
  program.addCommand(buildTasksCommand());

  const notify = new Command("notify").description("notification utilities");
  notify.command("test").description("send a test notification on every configured channel").action(cmdNotifyTest);
  program.addCommand(notify);

  return program;
}
