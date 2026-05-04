/**
 * User / workspace / session / API-key CRUD on top of better-sqlite3.
 *
 * v0.4 keeps it deliberately small — one workspace per user by default,
 * invites for adding teammates land in v0.5 alongside Stripe billing.
 */
import type { Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { hashPassword, verifyPassword, newSessionToken, tokenHash, newApiKey, parseApiKey, SESSION_TTL_MS } from "./auth.js";

export interface UserRow { id: string; email: string; name: string | null; created_at: string; default_workspace_id: string | null }
export interface WorkspaceRow {
  id: string; name: string; plan: "free" | "pro" | "team" | "enterprise";
  owner_user_id: string; created_at: string;
  runs_used_this_month: number; usage_period_start: string;
}
export interface ApiKeyRow {
  id: string; workspace_id: string; user_id: string; name: string;
  created_at: string; last_used_at: string | null;
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

// ── Users ────────────────────────────────────────────────────────────

export async function createUser(db: Database, email: string, password: string, name?: string): Promise<{ user: UserRow; workspace: WorkspaceRow }> {
  const normalised = email.trim().toLowerCase();
  if (!/^[^@]+@[^@]+\.[^@]+$/.test(normalised)) throw new Error("invalid email");
  if (password.length < 8) throw new Error("password must be at least 8 characters");

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(normalised);
  if (existing) throw new Error("email already in use");

  const userId = newId("u");
  const wsId = newId("ws");
  const now = new Date().toISOString();
  const passwordHash = await hashPassword(password);

  db.transaction(() => {
    db.prepare(`INSERT INTO users (id, email, password_hash, name, created_at, default_workspace_id)
                VALUES (?, ?, ?, ?, ?, ?)`).run(userId, normalised, passwordHash, name ?? null, now, wsId);
    db.prepare(`INSERT INTO workspaces (id, name, plan, owner_user_id, created_at, runs_used_this_month, usage_period_start)
                VALUES (?, ?, 'free', ?, ?, 0, ?)`).run(wsId, name ? `${name}'s workspace` : "My workspace", userId, now, now);
    db.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role, joined_at)
                VALUES (?, ?, 'owner', ?)`).run(wsId, userId, now);
  })();

  return {
    user: { id: userId, email: normalised, name: name ?? null, created_at: now, default_workspace_id: wsId },
    workspace: { id: wsId, name: name ? `${name}'s workspace` : "My workspace", plan: "free", owner_user_id: userId, created_at: now, runs_used_this_month: 0, usage_period_start: now },
  };
}

export async function authenticate(db: Database, email: string, password: string): Promise<UserRow | null> {
  const row = db.prepare("SELECT id, email, password_hash, name, created_at, default_workspace_id FROM users WHERE email = ?")
    .get(email.trim().toLowerCase()) as (UserRow & { password_hash: string }) | undefined;
  if (!row) return null;
  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) return null;
  return { id: row.id, email: row.email, name: row.name, created_at: row.created_at, default_workspace_id: row.default_workspace_id };
}

export function getUser(db: Database, id: string): UserRow | null {
  const row = db.prepare("SELECT id, email, name, created_at, default_workspace_id FROM users WHERE id = ?").get(id) as UserRow | undefined;
  return row ?? null;
}

// ── Sessions ─────────────────────────────────────────────────────────

export function createSession(db: Database, userId: string, userAgent?: string): string {
  const { raw, hash } = newSessionToken();
  const now = new Date();
  db.prepare(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent)
              VALUES (?, ?, ?, ?, ?)`).run(hash, userId, now.toISOString(), new Date(now.getTime() + SESSION_TTL_MS).toISOString(), userAgent ?? null);
  return raw;
}

export function userFromSession(db: Database, rawToken: string): UserRow | null {
  const hash = tokenHash(rawToken);
  const row = db.prepare(`SELECT u.id, u.email, u.name, u.created_at, u.default_workspace_id, s.expires_at
                          FROM sessions s JOIN users u ON s.user_id = u.id
                          WHERE s.token_hash = ?`).get(hash) as (UserRow & { expires_at: string }) | undefined;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash);
    return null;
  }
  return { id: row.id, email: row.email, name: row.name, created_at: row.created_at, default_workspace_id: row.default_workspace_id };
}

export function deleteSession(db: Database, rawToken: string): void {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(rawToken));
}

// ── Workspaces ───────────────────────────────────────────────────────

export function getWorkspace(db: Database, id: string): WorkspaceRow | null {
  return (db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as WorkspaceRow | undefined) ?? null;
}

/** True if the user is a member of the workspace (any role). */
export function userInWorkspace(db: Database, userId: string, workspaceId: string): boolean {
  const r = db.prepare("SELECT 1 FROM workspace_members WHERE user_id = ? AND workspace_id = ?").get(userId, workspaceId);
  return !!r;
}

// ── API keys ─────────────────────────────────────────────────────────

export function listApiKeys(db: Database, workspaceId: string): ApiKeyRow[] {
  return db.prepare("SELECT id, workspace_id, user_id, name, created_at, last_used_at FROM api_keys WHERE workspace_id = ? ORDER BY created_at DESC").all(workspaceId) as ApiKeyRow[];
}

/** Returns the FULL key to show the user exactly once. The DB only ever stores its hash. */
export function createApiKey(db: Database, workspaceId: string, userId: string, name: string): { full: string; row: ApiKeyRow } {
  const { full, id, secretHash } = newApiKey();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO api_keys (id, secret_hash, workspace_id, user_id, name, created_at, last_used_at)
              VALUES (?, ?, ?, ?, ?, ?, NULL)`).run(id, secretHash, workspaceId, userId, name, now);
  return { full, row: { id, workspace_id: workspaceId, user_id: userId, name, created_at: now, last_used_at: null } };
}

export function revokeApiKey(db: Database, workspaceId: string, keyId: string): boolean {
  const r = db.prepare("DELETE FROM api_keys WHERE id = ? AND workspace_id = ?").run(keyId, workspaceId);
  return r.changes > 0;
}

/** Look up a key from a raw `lo_pk_xxxx_yyyy` string. Returns the workspace it belongs to + the user. */
export function workspaceFromApiKey(db: Database, raw: string): { workspaceId: string; userId: string } | null {
  const parsed = parseApiKey(raw);
  if (!parsed) return null;
  const row = db.prepare("SELECT workspace_id, user_id, secret_hash FROM api_keys WHERE id = ?").get(parsed.id) as { workspace_id: string; user_id: string; secret_hash: string } | undefined;
  if (!row) return null;
  if (row.secret_hash !== parsed.secretHash) return null;
  // Touch last_used_at — fire and forget.
  try { db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(new Date().toISOString(), parsed.id); } catch { /* ok */ }
  return { workspaceId: row.workspace_id, userId: row.user_id };
}
