# Design

## Problem

Anthropic has no public API for a consumer Claude subscription's 5-hour/weekly
usage or reset time. Any local tool that wants to notify a user "Claude is
back" has to source that data from somewhere Claude Code itself already has
it, without inventing an undocumented integration or breaking on version
changes.

## Data source (the core decision)

Two Claude-specific sources, isolated behind `packages/agent/src/provider/`:

1. **statusLine hook (primary).** Claude Code >=2.1.x invokes the command
   configured as `statusLine` in `~/.claude/settings.json`, passing a JSON
   payload on stdin. For Pro/Max subscribers this includes
   `rate_limits.five_hour` / `.seven_day`, each with a utilization percent and
   a `resets_at` timestamp — straight from Anthropic's servers, zero network
   calls on our end. `quota setup` installs `quota-statusline` as this
   command, chaining to any statusLine command the user already had so their
   existing statusline keeps working.

2. **`/api/oauth/usage` (fallback).** An undocumented endpoint, called with the
   OAuth token Claude Code already stores at `~/.claude/.credentials.json`.
   It's known to 429 aggressively under repeated polling, so it's used only:
   (a) for cold-start discovery when no statusline data exists yet, and (b) on
   a throttled timer (default every 5 minutes) to track utilization for the
   threshold warnings. The token is read fresh from disk per request and never
   persisted or transmitted anywhere else.

Both parse into the same `UsageSnapshot` shape (`provider/types.ts`), so this
seam is where a future provider (a different Claude surface, or a real public
API if one ships) would plug in.

## Work sessions (the core loop, V1.1)

`work_sessions` is a new table (`storage/sessions.ts`) sitting alongside the
usage-tracking tables added in V1. It answers the actual user problem this
product exists for: when Claude's limit interrupts you, don't make the user
reconstruct "what was I doing?" from memory.

A session's `lifecycle` collapses the seven-state model from the product
brief (STARTED → ACTIVE → CLAUDE_LIMIT_REACHED → INTERRUPTED → CLAUDE_RESET →
READY_TO_RESUME → RESUMED) into four DB states plus timestamps that
reconstruct the full trace without redundant columns:

- `active` — covers STARTED, ACTIVE, and RESUMED (all "currently working")
- `interrupted` — CLAUDE_LIMIT_REACHED + INTERRUPTED (set the instant
  five_hour utilization hits 100%, from the same `onSnapshot` hook that
  already drives threshold notifications)
- `ready_to_resume` — CLAUDE_RESET + READY_TO_RESUME (set from the same
  `onReset` alarm that already exists in the scheduler)
- `completed` — session ended (manually, or superseded by a new one)

`started_at` / `interrupted_at` / `reset_at` / `resumed_at` / `completed_at`
are all preserved independently of the collapsed `lifecycle` value, so
session history shows the real timeline.

Only one session is "in play" at a time (`getCurrentSession` — most recent
non-completed row). Starting a new one auto-completes whatever was open,
so the task queue never accumulates orphaned open sessions.

Content capture (`project`, `status_text`, `notes`, `next_tasks` as a JSON
string array) is deliberately manual-only for V1.1 (`quota session
note/next/set`) — see "Automatic context extraction" below for what a future
version would plug into the same table without a schema change.

## Reset detection needs no polling

Once a `resets_at` is known, a single `setTimeout` fires the reset
notification at that instant — polling only serves cold start and utilization
tracking, not reset detection. `Scheduler.start()` reconstructs these alarms
from the last persisted snapshot per kind on every boot, so a restart or a Mac
sleep/wake cycle just re-derives the same alarm (a timer that was already past
due fires immediately on wake, which is the correct behavior here).

## Components

```
agent (Node/TS daemon, binds 127.0.0.1 only)
├── provider/        Claude-specific usage sources (isolated, swappable)
├── scheduler/        reset alarms + throttled fallback polling
├── notifications/    telegram / ntfy / native desktop, threshold+reset dispatch with dedup
├── storage/           SQLite (better-sqlite3, WAL), no ORM
├── api/               local Express API consumed by the CLI and the dashboard
├── cli/               commander: status/setup/start/stop/tasks/notify test
├── launchd/           generates the macOS login-item plist
└── platform/           OS dispatch: native notifications + autostart (macos/linux/windows)

web (Next.js + Tailwind, hand-rolled shadcn-style components)
└── app/page.tsx       reads-only client of the local agent API, polls every 15s
```

The dashboard never touches SQLite directly — everything goes through the
agent's local HTTP API, so the agent is the single source of truth and the
only process that needs write access to `~/.quota/quota.db`.

## Security

- Claude's own OAuth token is read transiently for the fallback poll and never
  written to disk or sent anywhere but `api.anthropic.com`.
- Telegram/ntfy secrets live in `~/.quota/.env`, written with `chmod 600`. This
  is file-permission protection, not OS-keychain-grade encryption — noted as a
  known gap; add keychain storage if you need stronger guarantees.
- The local API binds `127.0.0.1` only and sends permissive CORS headers
  purely so the dashboard (a different localhost port) can read it — it never
  listens on a non-loopback interface.
- No telemetry, no accounts, no hosted backend of any kind.

## Automatic context extraction

`bin/quota-session-hook.ts`, installed by `quota setup` as a Claude Code
`Stop` + `SessionEnd` hook, keeps a session's `status_text` and `next_tasks`
current without the user typing `quota session set/next` by hand. The
extraction logic (`provider/session-context.ts`) is deliberately heuristic,
not an LLM call:

- **`Stop`** (fires every turn, generous default timeout) hands hooks
  `last_assistant_message` directly — Claude Code's own docs recommend this
  over reading `transcript_path`, since the transcript file is written
  asynchronously (may lag the live conversation) and its per-line format is
  undocumented and changes across versions. We take the first paragraph as
  the new `status_text`, and if the message contains a "Next steps"/"TODO"
  list, its items become `next_tasks` (deduped against what's already
  there).
- **`SessionEnd`** hooks of every kind share a 1.5-second *total* budget
  across everything registered for that event — not enough time or reliable
  data for a real summarization pass. It just appends a short
  `[auto] Session ended (<reason>)` note.

Both paths reuse `appendNote` / `appendNextTask` / `updateSession` — the
exact seam this file called out before this was built. If no session is
open yet, the hook auto-starts one named from `cwd`'s basename, so capture
works even without an explicit `quota session start`.

Delivery mirrors the existing `quota-statusline` hook: the script first
tries `POST /api/internal/session-activity` on the running agent (800ms
timeout — SessionEnd's shared budget leaves no room to hang), falling back
to a direct SQLite write via the same `storage/sessions.ts` functions if the
agent isn't running.

ponytail: this is extractive, not generative — a real digest of what changed
this turn (files touched, decisions made) is a strictly better `status_text`
than "first paragraph of the reply". Upgrade path: `Stop`'s generous
timeout could afford one small LLM call per turn to produce that; not done
here to keep this dependency-free, offline, and fast.

## Notable simplifications (V1 scope)

- No separate `sessions` table — "recent sessions" are derived from
  `usage_snapshots` + `reset_events`, which covers the same data without an
  extra model.
- Runs directly as TypeScript via Node's native type-stripping (Node >=22.18)
  — no build step, no ts-node/tsx dependency.
- Tests use Node's built-in `node:test` — no Jest/Vitest.
- shadcn/ui components are hand-written in `packages/web/components/ui/` in
  shadcn's own style/API (that's how shadcn actually works — components are
  copied into your repo, not installed as a package).
