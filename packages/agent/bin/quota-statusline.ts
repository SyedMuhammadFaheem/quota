#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { parseStatusLinePayload } from "../src/provider/statusline-hook.ts";
import { insertSnapshot } from "../src/storage/snapshots.ts";
import { openDb } from "../src/storage/db.ts";
import { getSetting } from "../src/storage/settings.ts";
import { AGENT_PORT } from "../src/config.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function pushToRunningAgent(raw: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${AGENT_PORT}/api/internal/statusline`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
      signal: AbortSignal.timeout(300),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function forwardToChainedCommand(chainCommand: string, stdin: string): string {
  try {
    return execFileSync(chainCommand, { input: stdin, shell: true, encoding: "utf8" });
  } catch {
    return "";
  }
}

function fallbackLine(payload: ReturnType<typeof parseStatusLinePayload>): string {
  if (!payload) return "";
  const fiveHour = payload.windows.find((w) => w.kind === "five_hour");
  const sevenDay = payload.windows.find((w) => w.kind === "seven_day");
  const parts: string[] = [];
  if (fiveHour) parts.push(`${Math.round(fiveHour.utilization)}% (5h)`);
  if (sevenDay) parts.push(`${Math.round(sevenDay.utilization)}% (7d)`);
  return parts.length ? `Claude ${parts.join(" · ")}` : "";
}

async function main() {
  const raw = await readStdin();
  let payload: unknown = {};
  try {
    payload = JSON.parse(raw);
  } catch {
    // Claude Code always sends valid JSON; tolerate malformed input defensively.
  }

  const snapshot = parseStatusLinePayload(payload as Record<string, unknown>);
  if (snapshot) {
    const pushed = await pushToRunningAgent(raw);
    if (!pushed) {
      const db = openDb();
      insertSnapshot(db, snapshot);
      db.close();
    }
  }

  const db = openDb();
  const chainCommand = getSetting(db, "chain_statusline_command");
  db.close();

  if (chainCommand) {
    process.stdout.write(forwardToChainedCommand(chainCommand, raw));
  } else {
    process.stdout.write(fallbackLine(snapshot));
  }
}

main();
