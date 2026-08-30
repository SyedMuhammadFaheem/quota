export type UsageKind = "five_hour" | "seven_day";

export type UsageSource = "statusline" | "oauth_api";

export interface UsageWindow {
  kind: UsageKind;
  /** 0-100 */
  utilization: number;
  /** unix ms epoch, when this window resets. undefined if unknown. */
  resetsAt: number | undefined;
}

export interface UsageSnapshot {
  capturedAt: number;
  source: UsageSource;
  windows: UsageWindow[];
  raw: unknown;
}
