import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb } from "../src/server/db.js";
import {
  createUser, authenticate, getUser, createSession, userFromSession, deleteSession,
  getWorkspace, userInWorkspace, listApiKeys, createApiKey, revokeApiKey, workspaceFromApiKey,
} from "../src/server/users.js";

let dataDir: string;
let db: ReturnType<typeof openDb>;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "luna-test-"));
  db = openDb(dataDir);
});

afterEach(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("users · createUser + authenticate", () => {
  it("creates a user, a workspace, and a membership in one go", async () => {
    const { user, workspace } = await createUser(db, "alice@example.com", "hunter2hunter2", "Alice");
    expect(user.email).toBe("alice@example.com");
    expect(user.name).toBe("Alice");
    expect(user.default_workspace_id).toBe(workspace.id);
    expect(workspace.plan).toBe("free");
    expect(workspace.owner_user_id).toBe(user.id);
    expect(userInWorkspace(db, user.id, workspace.id)).toBe(true);
  });

  it("normalises email to lowercase + trim", async () => {
    const { user } = await createUser(db, "  Bob@EXAMPLE.com  ", "hunter2hunter2");
    expect(user.email).toBe("bob@example.com");
  });

  it("rejects duplicate email", async () => {
    await createUser(db, "x@y.com", "hunter2hunter2");
    await expect(createUser(db, "x@y.com", "anotherpass")).rejects.toThrow(/already in use/);
  });

  it("rejects short passwords", async () => {
    await expect(createUser(db, "y@z.com", "short")).rejects.toThrow(/at least 8/);
  });

  it("rejects malformed email", async () => {
    await expect(createUser(db, "not-an-email", "hunter2hunter2")).rejects.toThrow(/invalid email/);
  });

  it("authenticate succeeds with correct password and rejects wrong", async () => {
    await createUser(db, "auth@x.com", "hunter2hunter2");
    expect(await authenticate(db, "auth@x.com", "hunter2hunter2")).not.toBeNull();
    expect(await authenticate(db, "AUTH@x.com", "hunter2hunter2")).not.toBeNull(); // case-insensitive
    expect(await authenticate(db, "auth@x.com", "wrong")).toBeNull();
    expect(await authenticate(db, "ghost@x.com", "any")).toBeNull();
  });
});

describe("users · sessions", () => {
  it("createSession + userFromSession round-trips", async () => {
    const { user } = await createUser(db, "sess@x.com", "hunter2hunter2");
    const token = createSession(db, user.id, "test-agent");
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const looked = userFromSession(db, token);
    expect(looked).not.toBeNull();
    expect(looked!.id).toBe(user.id);
  });

  it("deleteSession invalidates the token", async () => {
    const { user } = await createUser(db, "logout@x.com", "hunter2hunter2");
    const token = createSession(db, user.id);
    expect(userFromSession(db, token)).not.toBeNull();
    deleteSession(db, token);
    expect(userFromSession(db, token)).toBeNull();
  });

  it("rejects an unknown token", () => {
    expect(userFromSession(db, "f".repeat(64))).toBeNull();
  });
});

describe("users · API keys", () => {
  it("createApiKey returns the full key once + persists only the hash", async () => {
    const { user, workspace } = await createUser(db, "key@x.com", "hunter2hunter2");
    const { full, row } = createApiKey(db, workspace.id, user.id, "CI");
    expect(full).toMatch(/^lo_pk_[a-f0-9]{8}_[a-f0-9]{40}$/);
    expect(row.name).toBe("CI");

    const keys = listApiKeys(db, workspace.id);
    expect(keys).toHaveLength(1);
    expect(keys[0]!.name).toBe("CI");
    // The DB row must NOT contain the secret half — we shouldn't be able to reconstruct `full`.
    expect(JSON.stringify(keys[0])).not.toContain(full.split("_").pop()!);
  });

  it("workspaceFromApiKey resolves a valid key to its workspace", async () => {
    const { user, workspace } = await createUser(db, "apikey@x.com", "hunter2hunter2");
    const { full } = createApiKey(db, workspace.id, user.id, "test");
    const m = workspaceFromApiKey(db, full);
    expect(m).not.toBeNull();
    expect(m!.workspaceId).toBe(workspace.id);
    expect(m!.userId).toBe(user.id);
  });

  it("workspaceFromApiKey returns null for a tampered secret", async () => {
    const { user, workspace } = await createUser(db, "tamper@x.com", "hunter2hunter2");
    const { full } = createApiKey(db, workspace.id, user.id, "test");
    const tampered = full.slice(0, -3) + "000";
    expect(workspaceFromApiKey(db, tampered)).toBeNull();
  });

  it("revokeApiKey removes the key", async () => {
    const { user, workspace } = await createUser(db, "revoke@x.com", "hunter2hunter2");
    const { row } = createApiKey(db, workspace.id, user.id, "doomed");
    expect(revokeApiKey(db, workspace.id, row.id)).toBe(true);
    expect(listApiKeys(db, workspace.id)).toHaveLength(0);
    expect(revokeApiKey(db, workspace.id, row.id)).toBe(false); // already gone
  });
});

describe("users · workspace scoping", () => {
  it("getUser / getWorkspace return null for unknown ids", () => {
    expect(getUser(db, "u_nope")).toBeNull();
    expect(getWorkspace(db, "ws_nope")).toBeNull();
  });

  it("userInWorkspace is false for unaffiliated users", async () => {
    const a = await createUser(db, "a@x.com", "hunter2hunter2");
    const b = await createUser(db, "b@x.com", "hunter2hunter2");
    expect(userInWorkspace(db, a.user.id, b.workspace.id)).toBe(false);
    expect(userInWorkspace(db, b.user.id, a.workspace.id)).toBe(false);
  });
});
