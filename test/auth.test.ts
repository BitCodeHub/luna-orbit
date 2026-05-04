import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, newSessionToken, tokenHash, newApiKey, parseApiKey, safeEqual } from "../src/server/auth.js";

describe("auth · password hashing", () => {
  it("hashes and verifies a password", async () => {
    const h = await hashPassword("hunter2hunter2");
    expect(await verifyPassword("hunter2hunter2", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
  });

  it("produces different hashes for the same password (salting)", async () => {
    const a = await hashPassword("samepass1234");
    const b = await hashPassword("samepass1234");
    expect(a).not.toBe(b);
    expect(await verifyPassword("samepass1234", a)).toBe(true);
    expect(await verifyPassword("samepass1234", b)).toBe(true);
  });
});

describe("auth · session tokens", () => {
  it("generates a 64-hex-char raw token and matching sha256 hash", () => {
    const { raw, hash } = newSessionToken();
    expect(raw).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    // Hash is reproducible from raw
    expect(tokenHash(raw)).toBe(hash);
  });

  it("two tokens are distinct (entropy check)", () => {
    const a = newSessionToken();
    const b = newSessionToken();
    expect(a.raw).not.toBe(b.raw);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("auth · API keys", () => {
  it("generates a key in the documented format", () => {
    const { full, id, secretHash } = newApiKey();
    expect(full).toMatch(/^lo_pk_[a-f0-9]{8}_[a-f0-9]{40}$/);
    expect(id).toMatch(/^lo_pk_[a-f0-9]{8}$/);
    expect(secretHash).toMatch(/^[a-f0-9]{64}$/);
    expect(full.startsWith(id + "_")).toBe(true);
  });

  it("parses a generated key back to {id, secretHash}", () => {
    const { full, id, secretHash } = newApiKey();
    const parsed = parseApiKey(full);
    expect(parsed).not.toBeNull();
    expect(parsed!.id).toBe(id);
    expect(parsed!.secretHash).toBe(secretHash);
  });

  it("rejects malformed keys", () => {
    expect(parseApiKey("")).toBeNull();
    expect(parseApiKey("garbage")).toBeNull();
    expect(parseApiKey("lo_pk_short_x")).toBeNull();
    expect(parseApiKey("LO_PK_uppercase_yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy")).toBeNull();
    // Wrong prefix
    expect(parseApiKey("xx_pk_12345678_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBeNull();
  });
});

describe("auth · safeEqual", () => {
  it("compares equal-length strings", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
  });
  it("returns false for different-length strings without leaking via early-return", () => {
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "x")).toBe(false);
  });
});
