import { describe, it, expect } from "vitest";
import { Queue } from "../src/server/queue.js";

describe("Queue", () => {
  it("runs all tasks when limit allows", async () => {
    const q = new Queue(5);
    const results = await Promise.all([1, 2, 3].map((n) => q.run(async () => n * 2)));
    expect(results).toEqual([2, 4, 6]);
  });

  it("never exceeds the configured concurrency cap", async () => {
    const q = new Queue(2);
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 8 }, () => q.run(async () => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      return active;
    }));
    await Promise.all(tasks);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("releases the slot even when the task throws", async () => {
    const q = new Queue(1);
    await expect(q.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    // If the slot wasn't released, the next task would hang forever.
    const result = await Promise.race([
      q.run(async () => "ok"),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("timeout — slot leak")), 1000)),
    ]);
    expect(result).toBe("ok");
  });
});
