import type { UsageSnapshot, UsageWindow } from "./types.ts";

/**
 * Claude Code (>=2.1.x) invokes the configured `statusLine` command with a JSON
 * payload on stdin. For Pro/Max subscribers it includes rate_limits.five_hour /
 * .seven_day, each carrying a resets_at (unix seconds) and a utilization percent.
 * This is the only zero-network, server-truth source of real reset timestamps.
 * Older Claude Code versions omit rate_limits entirely -- callers must treat a
 * missing field as "no data", not an error.
 */
export interface StatusLinePayload {
  rate_limits?: {
    five_hour?: RateLimitWindow;
    seven_day?: RateLimitWindow;
  };
  [key: string]: unknown;
}

interface RateLimitWindow {
  utilization?: number;
  resets_at?: number | string;
}

function toResetsAtMs(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === "string" ? Date.parse(value) : value * 1000;
  return Number.isFinite(n) ? n : undefined;
}

export function parseStatusLinePayload(
  payload: StatusLinePayload,
  capturedAt = Date.now(),
): UsageSnapshot | undefined {
  const windows: UsageWindow[] = [];
  const fiveHour = payload.rate_limits?.five_hour;
  if (fiveHour && typeof fiveHour.utilization === "number") {
    windows.push({
      kind: "five_hour",
      utilization: fiveHour.utilization,
      resetsAt: toResetsAtMs(fiveHour.resets_at),
    });
  }
  const sevenDay = payload.rate_limits?.seven_day;
  if (sevenDay && typeof sevenDay.utilization === "number") {
    windows.push({
      kind: "seven_day",
      utilization: sevenDay.utilization,
      resetsAt: toResetsAtMs(sevenDay.resets_at),
    });
  }
  if (windows.length === 0) return undefined;
  return { capturedAt, source: "statusline", windows, raw: payload };
}
