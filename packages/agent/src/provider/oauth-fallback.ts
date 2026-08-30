import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { UsageSnapshot, UsageWindow } from "./types.ts";

/**
 * Fallback provider: hits the undocumented `/api/oauth/usage` endpoint using the
 * OAuth token Claude Code already keeps at ~/.claude/.credentials.json. This
 * endpoint is known to 429 aggressively under repeated polling, so callers must
 * throttle (see scheduler) and this module never persists the token -- it's read
 * fresh from disk on each call and only kept in memory for the request.
 */
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CREDENTIALS_PATH = path.join(os.homedir(), ".claude", ".credentials.json");

interface OauthUsageResponse {
  five_hour?: { utilization?: number; resets_at?: number | string };
  seven_day?: { utilization?: number; resets_at?: number | string };
  [key: string]: unknown;
}

export function readOauthToken(credentialsPath = CREDENTIALS_PATH): string | undefined {
  try {
    const raw = fs.readFileSync(credentialsPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed?.claudeAiOauth?.accessToken ?? parsed?.accessToken;
  } catch {
    return undefined;
  }
}

function toResetsAtMs(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === "string" ? Date.parse(value) : value * 1000;
  return Number.isFinite(n) ? n : undefined;
}

export function parseOauthUsageResponse(
  payload: OauthUsageResponse,
  capturedAt = Date.now(),
): UsageSnapshot | undefined {
  const windows: UsageWindow[] = [];
  if (typeof payload.five_hour?.utilization === "number") {
    windows.push({
      kind: "five_hour",
      utilization: payload.five_hour.utilization,
      resetsAt: toResetsAtMs(payload.five_hour.resets_at),
    });
  }
  if (typeof payload.seven_day?.utilization === "number") {
    windows.push({
      kind: "seven_day",
      utilization: payload.seven_day.utilization,
      resetsAt: toResetsAtMs(payload.seven_day.resets_at),
    });
  }
  if (windows.length === 0) return undefined;
  return { capturedAt, source: "oauth_api", windows, raw: payload };
}

export async function fetchUsageSnapshot(): Promise<UsageSnapshot | undefined> {
  const token = readOauthToken();
  if (!token) return undefined;
  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
  });
  if (!res.ok) return undefined;
  const json = (await res.json()) as OauthUsageResponse;
  return parseOauthUsageResponse(json);
}
