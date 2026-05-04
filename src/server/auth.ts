/**
 * Auth primitives — password hashing (bcrypt), session tokens, API keys.
 *
 * Sessions: random 32-byte token, returned to the browser as an
 * httpOnly+secure cookie. Stored in the DB by sha256-hash so a DB leak
 * doesn't yield live sessions. Default lifetime: 30 days.
 *
 * API keys: shape `lo_pk_<8>_<40>` — first chunk is the public ID (also
 * the prefix shown in the dashboard), second chunk is the secret. Only
 * the secret's sha256 is stored. Users see the full key once at creation
 * and never again. Lookup: split on `_`, look up by id, compare hash.
 */
import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";

export const SESSION_COOKIE = "lo_session";
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/** Generate a new session token. Returns the raw token (for the cookie) and its hash (for the DB). */
export function newSessionToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("hex");
  return { raw, hash: sha256(raw) };
}

/** Hash a raw cookie token to look it up in the DB. */
export function tokenHash(raw: string): string {
  return sha256(raw);
}

/** Generate a new API key. Returns the full key to show the user once + the parts to store. */
export function newApiKey(): { full: string; id: string; secretHash: string } {
  const idPart = randomBytes(4).toString("hex");      // 8 hex chars
  const secret = randomBytes(20).toString("hex");      // 40 hex chars
  const id = `lo_pk_${idPart}`;
  const full = `${id}_${secret}`;
  return { full, id, secretHash: sha256(secret) };
}

/** Parse a key the user supplied (header or query) into { id, secretHash }. */
export function parseApiKey(raw: string): { id: string; secretHash: string } | null {
  // Format: lo_pk_<8>_<40>
  const m = raw.match(/^(lo_pk_[a-f0-9]{8})_([a-f0-9]{40})$/);
  if (!m || !m[1] || !m[2]) return null;
  return { id: m[1], secretHash: sha256(m[2]) };
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Constant-time string compare (defence-in-depth; sha256 lookups already constrain timing). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
