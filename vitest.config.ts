import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Pure-function unit tests only — no browser, no network, no LLM.
    // End-to-end coverage lives in plans/ and is exercised manually
    // (and in CI against a public staging URL once we wire it).
  },
});
