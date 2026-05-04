import { describe, it, expect } from "vitest";
import { parsePlan } from "../src/plan.js";

describe("parsePlan v0.3 frontmatter extensions", () => {
  const base = ["---", "name: x", "target: https://x.com"];

  it("parses cron, auth, retry, a11y, browsers, visual_baseline", () => {
    const md = [
      ...base,
      "cron: every 15m",
      "auth: fixtures/admin.json",
      "retry: 2",
      "a11y: true",
      "browsers: chromium, firefox",
      "visual_baseline: baselines/checkout.png",
      "---",
      "## Steps",
      "1. do thing",
    ].join("\n");
    const p = parsePlan(md);
    expect(p.cron).toBe("every 15m");
    expect(p.auth).toBe("fixtures/admin.json");
    expect(p.retry).toBe(2);
    expect(p.a11y).toBe(true);
    expect(p.browsers).toEqual(["chromium", "firefox"]);
    expect(p.visualBaseline).toBe("baselines/checkout.png");
  });

  it("clamps retry to [0, 5]", () => {
    const md = [...base, "retry: 999", "---", "## Steps", "1. x"].join("\n");
    expect(parsePlan(md).retry).toBe(5);
  });

  it("defaults retry to 0 and a11y to false", () => {
    const md = [...base, "---", "## Steps", "1. x"].join("\n");
    const p = parsePlan(md);
    expect(p.retry).toBe(0);
    expect(p.a11y).toBe(false);
  });

  it("parses params JSON", () => {
    const md = [
      ...base,
      'params: {"name":["alice","bob"],"size":["s","m","l"]}',
      "---",
      "## Steps",
      "1. x",
    ].join("\n");
    expect(parsePlan(md).params).toEqual({ name: ["alice", "bob"], size: ["s", "m", "l"] });
  });

  it("rejects malformed params JSON", () => {
    const md = [...base, "params: not-json", "---", "## Steps", "1. x"].join("\n");
    expect(() => parsePlan(md)).toThrow(/params/i);
  });
});
