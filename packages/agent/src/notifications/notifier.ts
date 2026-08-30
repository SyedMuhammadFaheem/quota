import type Database from "better-sqlite3";
import type { UsageKind, UsageSnapshot } from "../provider/types.ts";
import type { WorkSession } from "../storage/sessions.ts";
import { logNotification, wasTriggerSent } from "../storage/notifications-log.ts";
import { sendTelegram, type TelegramConfig } from "./telegram.ts";
import { sendNtfy, type NtfyConfig } from "./ntfy.ts";
import { sendMacNotification } from "./macos.ts";

export interface NotifierConfig {
  telegram?: TelegramConfig;
  ntfy?: NtfyConfig;
  macNotifications?: boolean;
  thresholds?: number[];
}

const DEFAULT_THRESHOLDS = [80, 90, 95, 100];

const KIND_LABEL: Record<UsageKind, string> = {
  five_hour: "5-hour session",
  seven_day: "weekly",
};

export class Notifier {
  private db: Database.Database;
  private config: NotifierConfig;

  constructor(db: Database.Database, config: NotifierConfig) {
    this.db = db;
    this.config = config;
  }

  private get thresholds(): number[] {
    return this.config.thresholds ?? DEFAULT_THRESHOLDS;
  }

  async send(message: string, triggerKey: string): Promise<void> {
    if (wasTriggerSent(this.db, triggerKey)) return;
    const results = await Promise.all([
      this.config.telegram
        ? sendTelegram(this.config.telegram, message).then((ok) => ok && this.log("telegram", message, triggerKey))
        : Promise.resolve(),
      this.config.ntfy
        ? sendNtfy(this.config.ntfy, message).then((ok) => ok && this.log("ntfy", message, triggerKey))
        : Promise.resolve(),
      this.config.macNotifications !== false
        ? sendMacNotification(message).then((ok) => ok && this.log("macos", message, triggerKey))
        : Promise.resolve(),
    ]);
    void results;
  }

  /** Always sends on every configured channel, ignoring dedup -- used by `quota notify test`. */
  async sendTest(): Promise<{ channel: string; ok: boolean }[]> {
    const message = "🔥 Claude Quota test notification. If you can read this, it works.";
    const attempts: { channel: string; ok: boolean }[] = [];
    if (this.config.telegram) {
      attempts.push({ channel: "telegram", ok: await sendTelegram(this.config.telegram, message) });
    }
    if (this.config.ntfy) {
      attempts.push({ channel: "ntfy", ok: await sendNtfy(this.config.ntfy, message) });
    }
    if (this.config.macNotifications !== false) {
      attempts.push({ channel: "macos", ok: await sendMacNotification(message) });
    }
    return attempts;
  }

  /** `session` is the resumable work session this reset unblocked, if any -- turns the
   *  notification into a Resume Brief instead of a bare "reset" ping. */
  async notifyReset(kind: UsageKind, occurredAt: number, session?: WorkSession): Promise<void> {
    const message =
      session && session.lifecycle === "ready_to_resume"
        ? `🔥 Claude is ready again. You were working on: ${session.project}.${
            session.nextTasks[0] ? ` Next: ${session.nextTasks[0]}.` : ""
          } Resume: quota session resume`
        : `🔥 Claude is available again. Your ${KIND_LABEL[kind]} has reset.`;
    await this.send(message, `${kind}:reset:${occurredAt}`);
  }

  /** Call for every ingested snapshot window; dedups per (kind, threshold, reset window). */
  async notifyThresholds(snapshot: UsageSnapshot): Promise<void> {
    for (const w of snapshot.windows) {
      const crossed = this.thresholds.filter((t) => w.utilization >= t).sort((a, b) => b - a);
      const highest = crossed[0];
      if (highest === undefined) continue;
      const cycleKey = w.resetsAt ?? "unknown";
      const message = `⚠️ Claude ${KIND_LABEL[w.kind]} usage at ${Math.round(w.utilization)}% (≥${highest}% threshold).`;
      await this.send(message, `${w.kind}:${highest}:${cycleKey}`);
    }
  }

  private log(channel: string, message: string, triggerKey: string): void {
    logNotification(this.db, channel, message, triggerKey);
  }
}
