import fs from "node:fs";
import path from "node:path";
import { QUOTA_DIR } from "./storage/db.ts";

export const ENV_PATH = path.join(QUOTA_DIR, ".env");
export const AGENT_PORT = Number(process.env.QUOTA_PORT ?? 4317);

/** Minimal KEY=VALUE parser -- our .env is only ever written by `quota setup`. */
export function loadEnvFile(file = ENV_PATH): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

export function writeEnvFile(values: Record<string, string>, file = ENV_PATH): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = Object.entries(values)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  fs.writeFileSync(file, body + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export interface AppConfig {
  telegramBotToken?: string;
  telegramChatId?: string;
  ntfyTopic?: string;
  ntfyServer?: string;
  macNotifications: boolean;
  thresholds: number[];
  pollIntervalMs: number;
}

export function loadConfig(): AppConfig {
  const env = { ...loadEnvFile(), ...process.env } as Record<string, string | undefined>;
  return {
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    telegramChatId: env.TELEGRAM_CHAT_ID,
    ntfyTopic: env.NTFY_TOPIC,
    ntfyServer: env.NTFY_SERVER,
    macNotifications: env.MAC_NOTIFICATIONS !== "false",
    thresholds: env.THRESHOLDS ? env.THRESHOLDS.split(",").map(Number) : [80, 90, 95, 100],
    pollIntervalMs: env.POLL_INTERVAL_MS ? Number(env.POLL_INTERVAL_MS) : 5 * 60 * 1000,
  };
}
