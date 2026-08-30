import type Database from "better-sqlite3";
import type { UsageKind, UsageSnapshot } from "../provider/types.ts";
import { insertSnapshot, latestSnapshot, recordResetEvent } from "../storage/snapshots.ts";

const KINDS: UsageKind[] = ["five_hour", "seven_day"];
const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;
const MAX_TIMEOUT_MS = 2 ** 31 - 1; // setTimeout's max delay

export interface SchedulerDeps {
  db: Database.Database;
  /** rate-limited fallback poll, e.g. oauth-fallback.fetchUsageSnapshot */
  poll: () => Promise<UsageSnapshot | undefined>;
  onReset: (kind: UsageKind) => void;
  onSnapshot?: (snapshot: UsageSnapshot) => void;
  pollIntervalMs?: number;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

/**
 * Schedules a single reset alarm per kind from the last known resets_at, and a
 * periodic fallback poll for cold-start discovery + utilization tracking. No
 * polling is needed to detect a reset once resets_at is known -- see plan.
 */
export class Scheduler {
  private db: Database.Database;
  private poll: () => Promise<UsageSnapshot | undefined>;
  private onReset: (kind: UsageKind) => void;
  private onSnapshot?: (snapshot: UsageSnapshot) => void;
  private pollIntervalMs: number;
  private now: () => number;
  private setTimeoutFn: typeof setTimeout;
  private clearTimeoutFn: typeof clearTimeout;
  private resetTimers = new Map<UsageKind, NodeJS.Timeout>();
  private pollTimer: NodeJS.Timeout | undefined;

  constructor(deps: SchedulerDeps) {
    this.db = deps.db;
    this.poll = deps.poll;
    this.onReset = deps.onReset;
    this.onSnapshot = deps.onSnapshot;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.now = deps.now ?? Date.now;
    this.setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
  }

  /** Call on startup: reconstructs alarms from persisted snapshots (survives restart). */
  start(): void {
    for (const kind of KINDS) {
      const snapshot = latestSnapshot(this.db, kind);
      if (snapshot?.resets_at) this.scheduleReset(kind, snapshot.resets_at);
    }
    this.schedulePoll(0);
  }

  stop(): void {
    for (const timer of this.resetTimers.values()) this.clearTimeoutFn(timer);
    this.resetTimers.clear();
    if (this.pollTimer) this.clearTimeoutFn(this.pollTimer);
  }

  /** Feed a freshly observed snapshot (e.g. from the statusline hook writer). */
  ingest(snapshot: UsageSnapshot): void {
    insertSnapshot(this.db, snapshot);
    this.onSnapshot?.(snapshot);
    for (const w of snapshot.windows) {
      if (w.resetsAt) this.scheduleReset(w.kind, w.resetsAt);
    }
  }

  private scheduleReset(kind: UsageKind, resetsAt: number): void {
    const existing = this.resetTimers.get(kind);
    if (existing) this.clearTimeoutFn(existing);
    const delay = Math.min(Math.max(resetsAt - this.now(), 0), MAX_TIMEOUT_MS);
    const timer = this.setTimeoutFn(() => {
      recordResetEvent(this.db, kind, this.now());
      this.onReset(kind);
    }, delay);
    this.resetTimers.set(kind, timer);
  }

  private schedulePoll(delay: number): void {
    this.pollTimer = this.setTimeoutFn(async () => {
      try {
        const snapshot = await this.poll();
        if (snapshot) this.ingest(snapshot);
      } catch (err) {
        console.error("quota: poll failed", err);
      } finally {
        this.schedulePoll(this.pollIntervalMs);
      }
    }, delay);
  }
}
