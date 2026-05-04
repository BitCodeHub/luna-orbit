import { describe, it, expect } from "vitest";
import { buildSummary } from "../src/server/webhooks.js";
import type { RunRecord } from "../src/server/runs.js";

const base: RunRecord = {
  id: "run_abc",
  plan_name: "Checkout · happy path",
  plan_target: "https://shop.example.com",
  plan_platform: "web",
  status: "passed",
  passed: true,
  intents_satisfied: 5,
  intents_total: 5,
  assertions_pass: 3,
  assertions_total: 3,
  duration_ms: 28341,
  queued_at: "2026-05-04T04:20:00.000Z",
};

describe("buildSummary", () => {
  it("formats a passing run", () => {
    const s = buildSummary(base);
    expect(s).toContain("✓ PASS");
    expect(s).toContain("Checkout · happy path");
    expect(s).toContain("intents 5/5");
    expect(s).toContain("assertions 3/3");
    expect(s).toContain("28.3s");
  });

  it("formats a failing run", () => {
    const s = buildSummary({ ...base, status: "failed", passed: false, intents_satisfied: 3, assertions_pass: 1 });
    expect(s).toContain("✗ FAIL");
    expect(s).toContain("intents 3/5");
    expect(s).toContain("assertions 1/3");
  });

  it("formats an errored run with no stats", () => {
    const s = buildSummary({
      ...base,
      status: "errored",
      passed: undefined,
      intents_satisfied: undefined,
      intents_total: undefined,
      assertions_pass: undefined,
      assertions_total: undefined,
      duration_ms: undefined,
    });
    expect(s).toContain("✗ ERROR");
    expect(s).toContain("Checkout · happy path");
  });
});
