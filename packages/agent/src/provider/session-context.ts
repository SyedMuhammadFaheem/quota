/**
 * Turns a Claude Code hook payload (Stop or SessionEnd) into a session-context
 * update -- no LLM call, no transcript parsing. Two reasons:
 *
 * 1. `SessionEnd` hooks of every kind share a 1.5s total budget across all of
 *    them, and `transcript_path` is written asynchronously and may lag the
 *    live conversation -- there's no time or reliable data for a real
 *    summarization pass there.
 * 2. `Stop` gives us `last_assistant_message` directly, which Claude Code's
 *    own docs recommend over reading the transcript file for exactly this
 *    reason (its format is undocumented and changes across versions).
 *
 * ponytail: heuristic extraction, not real summarization -- a ceiling worth
 * naming. Upgrade path: a `Stop` hook has a generous default timeout (unlike
 * SessionEnd), so it could afford a single small LLM call to produce a
 * proper digest of last_assistant_message. Not done here to keep this
 * dependency-free and offline.
 */

export interface StopHookInput {
  hook_event_name: "Stop";
  last_assistant_message?: string;
  [key: string]: unknown;
}

export interface SessionEndHookInput {
  hook_event_name: "SessionEnd";
  reason?: "clear" | "resume" | "logout" | "prompt_input_exit" | "other";
  [key: string]: unknown;
}

export type SessionHookInput = StopHookInput | SessionEndHookInput | { hook_event_name?: unknown };

export interface SessionContextUpdate {
  statusText?: string;
  nextTasks?: string[];
  note?: string;
}

const STATUS_MAX_LEN = 240;
const NEXT_TASK_MAX_LEN = 140;
const MAX_NEXT_TASKS = 5;
const NEXT_SECTION_HEADING = /^#{0,6}\s*(next steps?|next|todo|remaining)\s*:?\s*$/i;
const LIST_ITEM = /^\s*(?:[-*]|\d+[.)])\s*(?:\[[ xX]\]\s*)?(.+)$/;

function stripMarkdown(text: string): string {
  return text
    .replace(/`{1,3}[^`]*`{1,3}/g, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** First non-empty paragraph, as a short status line. */
function extractStatusText(message: string): string | undefined {
  const cleaned = stripMarkdown(message);
  const paragraph = cleaned.split(/\n\s*\n/).find((p) => p.trim().length > 0);
  if (!paragraph) return undefined;
  const oneLine = paragraph.replace(/\s+/g, " ").trim();
  return oneLine ? truncate(oneLine, STATUS_MAX_LEN) : undefined;
}

/** A "Next steps" / "TODO" list near the end of the message, if Claude wrote one. */
function extractNextTasks(message: string): string[] {
  const lines = message.split("\n");
  const items: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (NEXT_SECTION_HEADING.test(line.trim())) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    const match = line.match(LIST_ITEM);
    if (match) {
      const item = truncate(stripMarkdown(match[1]).replace(/\s+/g, " ").trim(), NEXT_TASK_MAX_LEN);
      if (item) items.push(item);
      if (items.length >= MAX_NEXT_TASKS) break;
    } else if (line.trim() === "") {
      continue;
    } else {
      break; // section ended (prose resumed)
    }
  }
  return items;
}

export function extractSessionContext(input: SessionHookInput): SessionContextUpdate {
  if (input.hook_event_name === "Stop") {
    const message = (input as StopHookInput).last_assistant_message;
    if (typeof message !== "string" || message.trim() === "") return {};
    const statusText = extractStatusText(message);
    const nextTasks = extractNextTasks(message);
    return {
      ...(statusText ? { statusText } : {}),
      ...(nextTasks.length ? { nextTasks } : {}),
    };
  }
  if (input.hook_event_name === "SessionEnd") {
    const reason = (input as SessionEndHookInput).reason ?? "other";
    return { note: `[auto] Session ended (${reason})` };
  }
  return {};
}
