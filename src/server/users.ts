/**
 * User / workspace / session / API-key CRUD on top of better-sqlite3.
 *
 * v0.4 keeps it deliberately small — one workspace per user by default,
 * invites for adding teammates land in v0.5 alongside Stripe billing.
 */
import type { Database } from "better-sqlite3";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { hashPassword, verifyPassword, newSessionToken, tokenHash, newApiKey, parseApiKey, SESSION_TTL_MS } from "./auth.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export interface UserRow { id: string; email: string; name: string | null; created_at: string; default_workspace_id: string | null; email_verified_at?: string | null }
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

// ── Email verification + password reset (auth_tokens table) ──────────

const EMAIL_TOKEN_TTL_MS = 24 * 3600 * 1000;       // 24 h
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;         // 1 h

export type AuthTokenKind = "verify_email" | "password_reset";

/** Generate + persist an auth token. Returns the raw token (for the email link). */
export function issueAuthToken(db: Database, userId: string, kind: AuthTokenKind): string {
  const raw = randomBytes(32).toString("hex");
  const ttl = kind === "verify_email" ? EMAIL_TOKEN_TTL_MS : RESET_TOKEN_TTL_MS;
  const now = new Date();
  db.prepare(`INSERT INTO auth_tokens (token_hash, user_id, kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`)
    .run(sha256(raw), userId, kind, now.toISOString(), new Date(now.getTime() + ttl).toISOString());
  return raw;
}

/** Look up + consume an auth token. Returns the user_id on success, null if expired/used/invalid. */
export function consumeAuthToken(db: Database, raw: string, kind: AuthTokenKind): string | null {
  const hash = sha256(raw);
  const row = db.prepare(`SELECT user_id, kind, expires_at, used_at FROM auth_tokens WHERE token_hash = ?`).get(hash) as { user_id: string; kind: string; expires_at: string; used_at: string | null } | undefined;
  if (!row) return null;
  if (row.kind !== kind) return null;
  if (row.used_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  db.prepare("UPDATE auth_tokens SET used_at = ? WHERE token_hash = ?").run(new Date().toISOString(), hash);
  return row.user_id;
}

export function markEmailVerified(db: Database, userId: string): void {
  db.prepare("UPDATE users SET email_verified_at = ? WHERE id = ?").run(new Date().toISOString(), userId);
}

export function isEmailVerified(db: Database, userId: string): boolean {
  const r = db.prepare("SELECT email_verified_at FROM users WHERE id = ?").get(userId) as { email_verified_at: string | null } | undefined;
  return !!r?.email_verified_at;
}

export function userByEmail(db: Database, email: string): UserRow | null {
  return (db.prepare("SELECT id, email, name, created_at, default_workspace_id, email_verified_at FROM users WHERE email = ?").get(email.trim().toLowerCase()) as UserRow | undefined) ?? null;
}

/** Replace a user's password hash. Caller is responsible for verifying the old password / valid reset token. */
export async function setPassword(db: Database, userId: string, newPlaintext: string): Promise<void> {
  if (newPlaintext.length < 8) throw new Error("password must be at least 8 characters");
  const hash = await hashPassword(newPlaintext);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, userId);
}

// ── CSRF tokens (session-scoped, short-lived) ────────────────────────

const CSRF_TTL_MS = 4 * 60 * 60 * 1000;            // 4 h

/** Issue a CSRF token bound to the given session. Embed in form HTML. */
export function issueCsrfToken(db: Database, rawSessionToken: string): string {
  const raw = randomBytes(24).toString("hex");
  const now = new Date();
  db.prepare(`INSERT INTO csrf_tokens (token_hash, session_hash, created_at, expires_at) VALUES (?, ?, ?, ?)`)
    .run(sha256(raw), tokenHash(rawSessionToken), now.toISOString(), new Date(now.getTime() + CSRF_TTL_MS).toISOString());
  return raw;
}

/** Verify-and-consume a CSRF token submitted with a form. Returns true if valid. */
export function consumeCsrfToken(db: Database, rawSessionToken: string, rawCsrfToken: string): boolean {
  if (!rawCsrfToken) return false;
  const row = db.prepare("SELECT session_hash, expires_at FROM csrf_tokens WHERE token_hash = ?").get(sha256(rawCsrfToken)) as { session_hash: string; expires_at: string } | undefined;
  if (!row) return false;
  if (row.session_hash !== tokenHash(rawSessionToken)) return false;
  if (new Date(row.expires_at).getTime() < Date.now()) return false;
  // One-shot — consume on use.
  db.prepare("DELETE FROM csrf_tokens WHERE token_hash = ?").run(sha256(rawCsrfToken));
  return true;
}

// ── Signup rate limiting (simple per-IP window) ──────────────────────

const SIGNUP_WINDOW_MS = 60 * 60 * 1000;            // 1 h
const SIGNUP_MAX_PER_WINDOW = 5;

/** Returns `true` if the IP is allowed; records the attempt either way. */
export function tryRecordSignupAttempt(db: Database, ip: string): boolean {
  const now = Date.now();
  // Garbage-collect old rows opportunistically.
  db.prepare("DELETE FROM signup_attempts WHERE attempted_at < ?").run(new Date(now - SIGNUP_WINDOW_MS).toISOString());
  const cnt = db.prepare("SELECT COUNT(*) as n FROM signup_attempts WHERE ip = ? AND attempted_at >= ?")
    .get(ip, new Date(now - SIGNUP_WINDOW_MS).toISOString()) as { n: number };
  db.prepare("INSERT INTO signup_attempts (ip, attempted_at) VALUES (?, ?)").run(ip, new Date(now).toISOString());
  return cnt.n < SIGNUP_MAX_PER_WINDOW;
}

void randomUUID; // silence unused-import warning when no other helper uses it
