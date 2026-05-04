import { describe, it, expect } from "vitest";
import { parsePlan } from "../src/plan.js";

describe("parsePlan", () => {
  it("parses a minimal web plan", () => {
    const md = [
      "---",
      "name: Smoke test",
      "target: https://example.com",
      "platform: web",
      "---",
      "",
      "## Steps",
      "1. Open the page",
      "2. Click the button",
      "",
      "## Assertions",
      "- The page shows a heading",
      "",
    ].join("\n");
    const p = parsePlan(md);
    expect(p.name).toBe("Smoke test");
    expect(p.target).toBe("https://example.com");
    expect(p.platform).toBe("web");
    expect(p.intents).toEqual(["Open the page", "Click the button"]);
    expect(p.assertions).toEqual(["The page shows a heading"]);
    expect(p.maxStepsPerIntent).toBe(8); // default
  });

  it("defaults platform to web and reads max_steps_per_intent override", () => {
    const md = [
      "---",
      "name: x",
      "target: https://x.com",
      "max_steps_per_intent: 12",
      "---",
      "## Steps",
      "1. do something",
    ].join("\n");
    const p = parsePlan(md);
    expect(p.platform).toBe("web");
    expect(p.maxStepsPerIntent).toBe(12);
  });

  it("parses a mobile plan with capabilities JSON", () => {
    const md = [
      "---",
      "name: Mobile test",
      "platform: mobile",
      'capabilities: {"platformName":"Android","appium:appPackage":"com.x.y"}',
      "---",
      "## Steps",
      "1. Tap a button",
    ].join("\n");
    const p = parsePlan(md);
    expect(p.platform).toBe("mobile");
    expect(p.mobileMode).toBe("appium"); // default for mobile
    expect(p.capabilities).toEqual({ platformName: "Android", "appium:appPackage": "com.x.y" });
  });

  it("rejects malformed capabilities JSON", () => {
    const md = [
      "---",
      "name: x",
      "platform: mobile",
      "capabilities: this-is-not-json",
      "---",
      "## Steps",
      "1. do thing",
    ].join("\n");
    expect(() => parsePlan(md)).toThrow(/capabilities/i);
  });

  it("requires a name in frontmatter", () => {
    const md = [
      "---",
      "target: https://x.com",
      "---",
      "## Steps",
      "1. x",
    ].join("\n");
    expect(() => parsePlan(md)).toThrow(/name/i);
  });

  it("requires a target for web plans", () => {
    const md = [
      "---",
      "name: x",
      "platform: web",
      "---",
      "## Steps",
      "1. x",
    ].join("\n");
    expect(() => parsePlan(md)).toThrow(/target/i);
  });

  it("rejects empty Steps section", () => {
    const md = [
      "---",
      "name: x",
      "target: https://x.com",
      "---",
      "## Steps",
      "",
      "## Assertions",
      "- y",
    ].join("\n");
    expect(() => parsePlan(md)).toThrow(/Steps/);
  });

  it("supports both numbered and dashed lists in Assertions", () => {
    const md = [
      "---",
      "name: x",
      "target: https://x.com",
      "---",
      "## Steps",
      "1. step a",
      "## Assertions",
      "- assertion one",
      "* assertion two",
      "1. assertion three",
    ].join("\n");
    const p = parsePlan(md);
    expect(p.assertions).toEqual(["assertion one", "assertion two", "assertion three"]);
  });
});
