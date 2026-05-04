/**
 * Flake mitigation — auto-retry with LLM diagnosis.
 *
 * If a plan has `retry: N` in its frontmatter, runPlan() runs it up to N+1
 * times. If a later attempt PASSES where an earlier one FAILED, the LLM is
 * asked to diagnose what changed (timing? race condition? element appeared
 * late?) — that diagnosis goes into the report so the user knows the test
 * is flaky and roughly why.
 *
 * If all attempts fail the same way, no LLM call (saves tokens) — it's a
 * real bug, not flake.
 */
import type { RunReport } from "./report.js";
import { chat, type ChatMsg } from "./llm.js";

export interface FlakeNote {
  /** Number of attempts that ran (1 = no retry). */
  attempts: number;
  /** True iff the final attempt passed but at least one earlier attempt failed. */
  flaked: boolean;
  /** Per-attempt verdict for context. */
  attempt_results: Array<{ passed: boolean; intents_satisfied: number; intents_total: number; assertions_pass: number; assertions_total: number; duration_ms: number }>;
  /** LLM-written one-paragraph diagnosis of what likely changed between attempts. Only set when `flaked`. */
  diagnosis?: string;
}

export function summariseAttempt(r: RunReport): FlakeNote["attempt_results"][number] {
  return {
    passed: r.passed,
    intents_satisfied: r.intents.filter((it) => it.outcome === "satisfied").length,
    intents_total: r.intents.length,
    assertions_pass: r.assertions.filter((a) => a.pass).length,
    assertions_total: r.assertions.length,
    duration_ms: r.durationMs,
  };
}

export async function diagnoseFlake(attempts: RunReport[]): Promise<string | undefined> {
  if (attempts.length < 2) return undefined;
  const lastPassed = attempts[attempts.length - 1]?.passed;
  const earlierFailed = attempts.slice(0, -1).some((a) => !a.passed);
  if (!lastPassed || !earlierFailed) return undefined;

  const messages: ChatMsg[] = [
    { role: "system", content:
      "You diagnose flaky tests. Given a sequence of run results for the same test plan, identify the most likely cause of the inconsistency in 1-2 sentences. Common causes: race conditions, animation timing, network latency, eventual-consistency reads, time-of-day data, popups appearing late. Be specific about which intent or assertion was inconsistent. Output plain text, no JSON.",
    },
    { role: "user", content: attempts.map((a, i) => {
      const failedIts = a.intents.filter((it) => it.outcome !== "satisfied").map((it, j) => `    ${j + 1}. ${it.intent.slice(0, 80)} → ${it.outcome}${it.finalReason ? ": " + it.finalReason.slice(0, 100) : ""}`).join("\n");
      const failedAs = a.assertions.filter((as) => !as.pass).map((as, j) => `    ${j + 1}. ${as.assertion.slice(0, 80)} → ${as.reason.slice(0, 100)}`).join("\n");
      return `Attempt ${i + 1}: ${a.passed ? "PASS" : "FAIL"} (${(a.durationMs / 1000).toFixed(1)}s)` +
        (failedIts ? `\n  Failed intents:\n${failedIts}` : "") +
        (failedAs ? `\n  Failed assertions:\n${failedAs}` : "");
    }).join("\n\n") },
  ];
  try {
    return (await chat(messages, { maxTokens: 200, timeoutMs: 30_000 })).trim();
  } catch {
    return undefined;
  }
}
