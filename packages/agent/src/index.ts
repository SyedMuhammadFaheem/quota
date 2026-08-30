import { openDb } from "./storage/db.ts";
import { createApp } from "./api/server.ts";
import { Notifier, type NotifierConfig } from "./notifications/notifier.ts";
import { Scheduler } from "./scheduler/scheduler.ts";
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

export function startAgent() {
  const config = loadConfig();
  const db = openDb();
  const notifier = new Notifier(db, buildNotifierConfig(config));

  const scheduler = new Scheduler({
    db,
    poll: fetchUsageSnapshot,
    pollIntervalMs: config.pollIntervalMs,
    onReset: (kind) => {
      const session = getCurrentSession(db);
      const updated =
        session && kind === "five_hour" ? markReadyToResume(db, session.id, kind) : undefined;
      void notifier.notifyReset(kind, Date.now(), updated);
    },
    onSnapshot: (snapshot) => {
      void notifier.notifyThresholds(snapshot);
      const fiveHour = snapshot.windows.find((w) => w.kind === "five_hour");
      if (fiveHour && fiveHour.utilization >= 100) {
        const session = getCurrentSession(db);
        if (session) markInterrupted(db, session.id, "five_hour", "Claude 5-hour limit reached");
      }
    },
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
