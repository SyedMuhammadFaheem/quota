import type Database from "better-sqlite3";
import { openDb } from "./storage/db.ts";
import { createApp } from "./api/server.ts";
import { Notifier, type NotifierConfig } from "./notifications/notifier.ts";
import { Scheduler, type SchedulerDeps } from "./scheduler/scheduler.ts";
import { fetchUsageSnapshot } from "./provider/oauth-fallback.ts";
import { loadConfig, AGENT_PORT } from "./config.ts";
import { getCurrentSession, markInterrupted, markReadyToResume } from "./storage/sessions.ts";

export function buildNotifierConfig(config: ReturnType<typeof loadConfig>): NotifierConfig {
  return {
    telegram:
      config.telegramBotToken && config.telegramChatId
        ? { botToken: config.telegramBotToken, chatId: config.telegramChatId }
        : undefined,
    ntfy: config.ntfyTopic ? { topic: config.ntfyTopic, server: config.ntfyServer } : undefined,
    macNotifications: config.macNotifications,
    thresholds: config.thresholds,
  };
}

/** Wires session interruption/resume into the scheduler's reset/snapshot events, for any usage kind. */
export function buildSchedulerCallbacks(
  db: Database.Database,
  notifier: Notifier,
): Pick<SchedulerDeps, "onReset" | "onSnapshot"> {
  return {
    onReset: (kind) => {
      const session = getCurrentSession(db);
      const updated = session ? markReadyToResume(db, session.id, kind) : undefined;
      notifier.notifyReset(kind, Date.now(), updated).catch((err) => console.error("quota: notifyReset failed", err));
    },
    onSnapshot: (snapshot) => {
      notifier.notifyThresholds(snapshot).catch((err) => console.error("quota: notifyThresholds failed", err));
      for (const w of snapshot.windows) {
        if (w.utilization >= 100) {
          const session = getCurrentSession(db);
          if (session) markInterrupted(db, session.id, w.kind, `Claude ${w.kind.replace("_", "-")} limit reached`);
        }
      }
    },
  };
}

export function startAgent() {
  const config = loadConfig();
  const db = openDb();
  const notifier = new Notifier(db, buildNotifierConfig(config));

  const scheduler = new Scheduler({
    db,
    poll: fetchUsageSnapshot,
    pollIntervalMs: config.pollIntervalMs,
    ...buildSchedulerCallbacks(db, notifier),
  });
  scheduler.start();

  const app = createApp({ db, notifier, scheduler });
  const server = app.listen(AGENT_PORT, "127.0.0.1", () => {
    console.log(`quota agent listening on http://127.0.0.1:${AGENT_PORT}`);
  });

  const shutdown = () => {
    scheduler.stop();
    server.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { db, scheduler, server };
}
