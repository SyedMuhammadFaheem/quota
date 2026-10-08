# Claude Quota

**Never lose your place when your Claude session ends.**

A local-first, open-source work session manager for people using Claude.
When Claude's usage limit cuts you off mid-task, Quota checkpoints what you
were doing — current project, status, next tasks, notes — and hands it back
to you the moment Claude resets, as a Resume Brief instead of a bare "reset"
ping. Usage/reset tracking is still there; it's the mechanism, not the
point. Runs entirely on your machine — no accounts, no hosted backend, no
telemetry.

See [DESIGN.md](./DESIGN.md) for the architecture and the reasoning behind how
usage/reset data is obtained (there's no public API for this — read that file
before assuming any of it is a documented Anthropic API).

## Requirements

- macOS, Linux, or Windows — see [Platform notes](#platform-notes) below for
  what autostart and desktop notifications look like on each. **Only macOS
  has been fully tested end to end so far**; Linux and Windows are
  implemented and unit-tested but haven't been run on a real machine yet
  ([help wanted](#help-wanted-testing-on-linux-and-windows)).
- Node.js >= 22.18 (runs TypeScript directly via Node's native type stripping
  — no build step). Tested on Node 22 LTS. Node 26 can't currently build the
  `better-sqlite3` dependency, so `npm install` / the agent will fail there.
- Claude Code installed and used at least once, for the statusLine hook to
  capture real usage data

## Install

```bash
git clone <this repo>
cd quota
npm install
```

(A Homebrew formula isn't published yet — that needs a hosted release. For
now, clone + `npm install` + `npm link --workspace packages/agent` to get the
`quota` command on your PATH.)

## Setup

```bash
npm link --workspace packages/agent   # puts `quota` and `quota-statusline` on PATH
quota setup
```

The wizard will:

- ask for a Telegram bot token/chat id and/or an ntfy topic (either or both,
  skip what you don't want) and write them to `~/.quota/.env` (`chmod 600`)
- install `quota-statusline` as your Claude Code `statusLine` command in
  `~/.claude/settings.json`, chaining to any statusline command you already
  had so it keeps working
- install `quota-session-hook` as a Claude Code `Stop` + `SessionEnd` hook,
  alongside any hooks you already have registered for those events — this is
  what keeps your session's status and next-tasks fresh automatically as you
  work, on top of the manual `quota session note/next`
- offer to install a native autostart entry (launchd on macOS, a systemd
  `--user` unit on Linux, a Startup-folder script on Windows) so `quota`
  starts automatically at login

## Usage

```bash
quota start                                        # start the background agent
quota status                                        # Resume Brief (if one's waiting) + usage countdown

# work sessions -- the core loop
quota session start "Redis Pattern Profiler" "Implementing pattern detection"
quota session next "Fix authentication"             # queue what's next
quota session note "Investigate Redis timeout handling"
quota session status                                 # current session / Resume Brief
quota session resume                                  # pick back up once Claude's ready
quota session history                                 # past sessions
quota session done                                     # mark the current one complete

quota notify test          # send a test notification on every configured channel
quota tasks add "Fix the thing" -p 5   # flat priority queue, independent of sessions
quota tasks list
quota tasks complete <id>
quota stop
```

### The core loop

1. Work with Claude. `quota session status`/`next` capture context manually
   if you want to, but a `Stop`/`SessionEnd` hook (installed by `quota
   setup`) also keeps `status_text` and `next_tasks` updated automatically
   from what Claude just said — no LLM call, just extractive heuristics; see
   [DESIGN.md](./DESIGN.md#automatic-context-extraction) for exactly what it
   does and doesn't do.
2. Claude's usage limit hits — Quota automatically checkpoints your session as
   interrupted and sends the existing notification.
3. You leave. Hours later, Claude resets.
4. Quota notifies you with a Resume Brief: what you were working on, the
   last status, and what's next — not just "Claude reset."
5. `quota session resume` (or the dashboard's Resume Work button) and you're
   back where you left off, no context reconstruction required.

Dashboard:

```bash
npm run dev:web
# open http://localhost:3000
```

The dashboard is a client of the agent's local API
(`http://127.0.0.1:4317` by default, override with `QUOTA_PORT` /
`NEXT_PUBLIC_AGENT_URL`). Open it via `localhost` or `127.0.0.1` — the agent
rejects requests from any other origin (see [Security notes](#security-notes)).

## How usage data is captured

Claude Code passes real rate-limit/reset data to your configured `statusLine`
command while a session is running — that's the primary source, and it's the
only source with zero network calls and a real server-truth reset timestamp.
When you're away from the terminal, a throttled background poll (every 5
minutes by default, `POLL_INTERVAL_MS` in `.env`) fills the gap using the same
undocumented usage endpoint Claude Code's own OAuth session already has
access to. Full reasoning in [DESIGN.md](./DESIGN.md).

## Platform notes

Quota's storage, HTTP API, CLI, and web dashboard are pure Node and behave
identically everywhere. Two things are OS-specific: autostart and desktop
notifications. Telegram and ntfy are fully cross-platform and work the same
on every OS — if you want reliable notifications when you're away from your
desktop, prefer those over the native desktop ping.

> **Testing status:** macOS is fully tested end to end (setup wizard,
> agent, CLI, Claude Code hooks, limit → reset → Resume Brief, ntfy and
> native notifications, dashboard). Linux and Windows are covered by unit
> tests only — see below.

**macOS**
- Autostart: a launchd agent (`~/Library/LaunchAgents/com.quota.agent.plist`),
  loaded/unloaded via `launchctl`.
- Notifications: native Notification Center, via `osascript`.

**Linux**
- Autostart: a systemd `--user` unit
  (`~/.config/systemd/user/quota-agent.service`). `quota setup` runs
  `systemctl --user enable --now` for you. By default a user unit only runs
  while you're logged in; run `loginctl enable-linger $USER` once if you want
  it running before login too.
- Notifications: `notify-send`, provided by most desktop environments
  (part of `libnotify`). Headless/no notification daemon → the desktop ping
  silently no-ops; Telegram/ntfy still work.

**Windows**
- Autostart: `quota setup` drops a `.cmd` script into your per-user Startup
  folder (`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`), which
  Windows runs at your next login — no admin rights needed. `quota start`
  launches the agent immediately in the background and tracks its PID for
  `quota stop`.
- Notifications: a best-effort balloon tip via a built-in PowerShell/.NET
  call — no extra dependency. If PowerShell notifications aren't available
  in your environment, the desktop ping just no-ops; Telegram/ntfy still
  work.

**Unsupported platforms** (anything other than the three above): the desktop
notification and autostart calls no-op with a clear message instead of
crashing — `quota start`/`quota stop` still work by running the agent in the
foreground.

### Help wanted: testing on Linux and Windows

Quota has only been run end to end on macOS. If you're on Linux or Windows,
please volunteer to try it out — it's the single most useful contribution
right now. Run through:

1. `npm install`, `npm test` (all tests should pass)
2. `quota setup` — answer yes to autostart; log out and back in, and check
   `quota status` reaches the agent
3. `quota notify test` — did the desktop notification appear?
4. `quota session start "Test"`, `quota session status`, `quota session done`
5. `npm run dev:web` and open the dashboard
6. `quota stop`

Then [open an issue](https://github.com/SyedMuhammadFaheem/quota/issues/new) with your OS/distro and version,
Node version, and what worked or didn't (error output is very welcome).

## Troubleshooting

- **`quota status` says "Could not reach the quota agent"** — run `quota
  start`. If you installed the autostart agent, check
  `~/.quota/logs/agent.err.log` (macOS/Linux) or run `quota start` again
  (Windows tracks the process via `~/.quota/agent.pid`).
- **Usage shows "no data yet"** — open Claude Code once so the statusLine hook
  fires, or wait up to `POLL_INTERVAL_MS` for the fallback poll.
- **Statusline looks different / broken after setup** — `quota setup` chains
  to whatever command was previously configured; check
  `~/.claude/settings.json` if it looks wrong, and the stored chain command
  via the `settings` table in `~/.quota/quota.db`.
- **No notifications arrive** — run `quota notify test` and check the output
  per channel; for ntfy, confirm you're subscribed to the same topic in the
  app; for Telegram, confirm you've messaged your bot at least once (bots
  can't message a chat they haven't seen a message from).

## Security notes

- Claude's OAuth token (`~/.claude/.credentials.json`) is read transiently for
  the fallback poll only, never written or transmitted anywhere but
  `api.anthropic.com`.
- Notification secrets (Telegram/ntfy) live in `~/.quota/.env` with `chmod
  600` — file-permission protection, not OS-keychain-grade encryption.
- The local API binds `127.0.0.1` only, and rejects any request whose
  `Origin` or `Host` isn't localhost — so a website open in your browser
  can't read or change your sessions (including via DNS rebinding). The API
  has no authentication beyond that: other programs running as your user
  can still call it.
- No telemetry is collected, ever.

## License

MIT
