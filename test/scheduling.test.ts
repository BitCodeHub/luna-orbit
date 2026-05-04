import { describe, it, expect } from "vitest";
import { parseSchedule } from "../src/scheduling.js";

describe("parseSchedule", () => {
  it("parses 'every Nm/h/s/d' shorthand", () => {
    expect(parseSchedule("every 30s")?.nextFireMs(new Date())).toBe(30_000);
    expect(parseSchedule("every 5m")?.nextFireMs(new Date())).toBe(300_000);
    expect(parseSchedule("every 2h")?.nextFireMs(new Date())).toBe(7_200_000);
    expect(parseSchedule("every 1d")?.nextFireMs(new Date())).toBe(86_400_000);
  });

  it("preserves the original expression", () => {
    expect(parseSchedule("every 15m")?.expression).toBe("every 15m");
  });

  it("returns null for unrecognised expressions", () => {
    expect(parseSchedule("nonsense")).toBeNull();
    expect(parseSchedule("every banana")).toBeNull();
  });

  it("parses 5-field cron — every minute", () => {
    const s = parseSchedule("* * * * *");
    expect(s).not.toBeNull();
    // From a moment 30s into the current minute, next fire should be ≤ 60s away
    const at = new Date("2026-01-01T12:00:30Z");
    const wait = s!.nextFireMs(at);
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(60_000);
  });

  it("parses 5-field cron — top of every hour", () => {
    const s = parseSchedule("0 * * * *");
    const at = new Date("2026-01-01T12:00:30Z"); // 30s past noon
    // Next fire is 13:00 → 59 min 30 sec away
    expect(Math.round(s!.nextFireMs(at) / 1000)).toBe(59 * 60 + 30);
  });
});
