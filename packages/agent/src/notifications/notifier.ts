import type Database from "better-sqlite3";
import type { UsageKind, UsageSnapshot } from "../provider/types.ts";
import type { WorkSession } from "../storage/sessions.ts";
import { logNotification, claimTrigger } from "../storage/notifications-log.ts";
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

  /** The configured channels, each already bound to its own send credentials. */
  private get channels(): { name: string; send: (message: string) => Promise<boolean> }[] {
    const channels: { name: string; send: (message: string) => Promise<boolean> }[] = [];
    if (this.config.telegram) {
      const telegram = this.config.telegram;
      channels.push({ name: "telegram", send: (message) => sendTelegram(telegram, message) });
    }
    if (this.config.ntfy) {
      const ntfy = this.config.ntfy;
      channels.push({ name: "ntfy", send: (message) => sendNtfy(ntfy, message) });
    }
    if (this.config.macNotifications !== false) {
      channels.push({ name: "macos", send: sendMacNotification });
    }
    return channels;
  }

  async send(message: string, triggerKey: string): Promise<void> {
    if (!claimTrigger(this.db, triggerKey)) return;
    await Promise.all(
      this.channels.map((channel) =>
        channel.send(message).then((ok) => ok && this.log(channel.name, message, triggerKey)),
      ),
    );
  }

  /** Always sends on every configured channel, ignoring dedup -- used by `quota notify test`. */
  async sendTest(): Promise<{ channel: string; ok: boolean }[]> {
    const message = "🔥 Claude Quota test notification. If you can read this, it works.";
    return Promise.all(
      this.channels.map(async (channel) => ({ channel: channel.name, ok: await channel.send(message) })),
    );
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
      // Falls back to a UTC-day bucket, not a fixed "unknown" sentinel: a resets_at
      // that's never known (some sources omit it) would otherwise dedup this
      // threshold forever instead of just for the rest of the day.
      const cycleKey = w.resetsAt ?? new Date(snapshot.capturedAt).toISOString().slice(0, 10);
      const message = `⚠️ Claude ${KIND_LABEL[w.kind]} usage at ${Math.round(w.utilization)}% (≥${highest}% threshold).`;
      await this.send(message, `${w.kind}:${highest}:${cycleKey}`);
    }
  }

  private log(channel: string, message: string, triggerKey: string): void {
    logNotification(this.db, channel, message, triggerKey);
  }
}
