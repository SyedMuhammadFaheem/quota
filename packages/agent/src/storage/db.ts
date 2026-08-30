import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";

export const QUOTA_DIR = process.env.QUOTA_HOME ?? path.join(os.homedir(), ".quota");

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS usage_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('five_hour', 'seven_day')),
    utilization REAL NOT NULL,
    resets_at INTEGER,
    source TEXT NOT NULL,
    raw_json TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS reset_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('five_hour', 'seven_day')),
    occurred_at INTEGER NOT NULL,
    notified INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS notifications_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sent_at INTEGER NOT NULL,
    channel TEXT NOT NULL,
    message TEXT NOT NULL,
    trigger_key TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
    created_at INTEGER NOT NULL,
    completed_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS work_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    status_text TEXT,
    notes TEXT,
    next_tasks TEXT NOT NULL DEFAULT '[]',
    lifecycle TEXT NOT NULL DEFAULT 'active'
      CHECK (lifecycle IN ('active', 'interrupted', 'ready_to_resume', 'completed')),
    interruption_kind TEXT,
    interruption_reason TEXT,
    started_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL,
    interrupted_at INTEGER,
    reset_at INTEGER,
    resumed_at INTEGER,
    completed_at INTEGER
  )`,
];

export function openDb(dbPath?: string): Database.Database {
  const file = dbPath ?? path.join(QUOTA_DIR, "quota.db");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  for (const stmt of MIGRATIONS) db.exec(stmt);
  return db;
}
