#!/usr/bin/env node
import { extractSessionContext, type SessionHookInput } from "../src/provider/session-context.ts";
import { openDb } from "../src/storage/db.ts";
import { getCurrentSession, startSession, updateSession, appendNote, appendNextTask } from "../src/storage/sessions.ts";
import { AGENT_PORT } from "../src/config.ts";
import path from "node:path";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function pushToRunningAgent(body: unknown): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${AGENT_PORT}/api/internal/session-activity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      // SessionEnd hooks share a 1.5s total budget across every hook that fires --
      // fail fast and fall through to the direct-DB write rather than risk it.
      signal: AbortSignal.timeout(800),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function writeDirectly(update: { statusText?: string; note?: string; nextTasks?: string[] }, cwd?: string): void {
  const db = openDb();
  let session = getCurrentSession(db);
  if (!session) {
    const project = cwd ? path.basename(cwd) : "Untitled session";
    session = startSession(db, project);
  }
  if (update.statusText) session = updateSession(db, session.id, { statusText: update.statusText }) ?? session;
  if (update.note) session = appendNote(db, session.id, update.note) ?? session;
  for (const t of update.nextTasks ?? []) {
    if (!session.nextTasks.includes(t)) session = appendNextTask(db, session.id, t) ?? session;
  }
  db.close();
}

async function main() {
  const raw = await readStdin();
  let payload: SessionHookInput = {};
  try {
    payload = JSON.parse(raw);
  } catch {
    // Claude Code always sends valid JSON; tolerate malformed input defensively.
  }

  const update = extractSessionContext(payload);
  if (!update.statusText && !update.note && !(update.nextTasks && update.nextTasks.length)) {
    return; // nothing worth recording -- most Stop turns don't need a write
  }

  const cwd = typeof (payload as Record<string, unknown>).cwd === "string" ? (payload as Record<string, unknown>).cwd as string : undefined;
  const pushed = await pushToRunningAgent({ ...update, cwd });
  if (!pushed) writeDirectly(update, cwd);
}

main();
