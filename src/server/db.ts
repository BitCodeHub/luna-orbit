/**
 * SQLite-backed multi-tenant store.
 *
 * Schema fits the v0.4 SaaS shape: users, workspaces, workspace_members,
 * api_keys, sessions, plus a workspace_id column added to runs.
 *
 * SQLite (better-sqlite3) is intentional for v0.4 — single-process embedded
 * DB, zero ops, fits 100k+ runs comfortably. Postgres is a 1-day swap when
 * we hit the wall: the abstraction below is intentionally narrow.
 *
 * File layout under <data-dir>:
 *   <data-dir>/luna.db                  ← all rows
 *   <data-dir>/runs/<id>/...            ← per-run screenshots + reports (unchanged)
 */
import Database, { type Database as DB } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT,
  created_at    TEXT NOT NULL,
  default_workspace_id TEXT
);

CREATE TABLE IF NOT EXISTS workspaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  plan        TEXT NOT NULL DEFAULT 'free',     -- free | pro | team | enterprise
  owner_user_id TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  runs_used_this_month INTEGER NOT NULL DEFAULT 0,
  usage_period_start   TEXT NOT NULL,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'member',  -- owner | admin | member
  joined_at    TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,            -- sha256 of the raw cookie token
  user_id      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  user_agent   TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,            -- public id like "lo_pk_abc..."
  secret_hash  TEXT NOT NULL,               -- sha256 of the secret part
  workspace_id TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  data         TEXT NOT NULL,               -- JSON RunRecord
  status       TEXT NOT NULL,
  queued_at    TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_runs_workspace_queued ON runs(workspace_id, queued_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_keys_workspace ON api_keys(workspace_id);
`;

let _db: DB | null = null;

export function openDb(dataDir: string): DB {
  if (_db) return _db;
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, "luna.db");
  _db = new Database(path);
  _db.exec(SCHEMA);
  return _db;
}

/** Tests + the runtime can both swap in a fresh DB by closing the cached one. */
export function closeDb(): void {
  _db?.close();
  _db = null;
}
