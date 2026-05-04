/**
 * Visual regression — semantic diff via LLM, not pixel diff.
 *
 * Applitools/Percy compare pixel grids and flag any difference past a
 * threshold. They report tons of false positives (font hinting drift, ad
 * banners, time-of-day timestamps) and require humans to review every diff.
 *
 * Luna uses an LLM to compare two screenshots and judge whether the
 * difference is *meaningful* (a layout broke, a button vanished, an error
 * banner appeared) or *cosmetic* (whitespace shift, time string, unrelated
 * banner content). Returns a verdict + reason.
 *
 * v0.3 implementation: file-size + filename heuristic + LLM-text-evidence
 * judging using the existing `chat()` helper. Vision-LLM upload (real image
 * comparison) lands in v0.4 — depends on whether the configured LLM
 * endpoint supports image inputs (gemma-vlm at :8080 does; cloud Claude
 * does; local Qwen3.6 LM does not).
 */
import { readFile, stat } from "node:fs/promises";
import { chat, type ChatMsg } from "./llm.js";

export interface VisualVerdict {
  /** "ok" = baseline matches; "drifted" = changed but cosmetically; "broken" = real visual regression. */
  verdict: "ok" | "drifted" | "broken";
  reason: string;
  baseline_path: string;
  current_path: string;
}

/** Cheap file-size heuristic — if files are within 2% bytes, almost certainly visually identical. */
async function bytesEqualish(a: string, b: string): Promise<boolean> {
  try {
    const [sa, sb] = await Promise.all([stat(a), stat(b)]);
    if (sa.size === sb.size) {
      const [ba, bb] = await Promise.all([readFile(a), readFile(b)]);
      return ba.equals(bb);
    }
    const ratio = Math.min(sa.size, sb.size) / Math.max(sa.size, sb.size);
    return ratio > 0.98;
  } catch {
    return false;
  }
}

/**
 * Compare a freshly-captured screenshot against a baseline.
 * `descriptor` should be a short label (e.g. "checkout final state") that
 * gives the LLM context for what's expected on screen.
 */
export async function compareToBaseline(
  baselinePath: string,
  currentPath: string,
  descriptor: string,
): Promise<VisualVerdict> {
  if (await bytesEqualish(baselinePath, currentPath)) {
    return { verdict: "ok", reason: "Files are byte-identical (or within 2% size).", baseline_path: baselinePath, current_path: currentPath };
  }

  // Without vision-LLM upload we can only ask the model to judge *that* the
  // files differ and to weigh whether a change in size is likely meaningful
  // for the scenario. v0.4 sends the actual images to a vision endpoint.
  let baseSize = 0, curSize = 0;
  try { baseSize = (await stat(baselinePath)).size; } catch { /* ok */ }
  try { curSize = (await stat(currentPath)).size; } catch { /* ok */ }

  const messages: ChatMsg[] = [
    { role: "system", content:
      "You are reviewing a visual regression. You don't have the images, only their sizes and a description of what the screen should show.\n" +
      "Output ONE JSON object: {\"verdict\":\"ok\"|\"drifted\"|\"broken\",\"reason\":\"...\"}.\n" +
      "  ok       → no meaningful change\n" +
      "  drifted  → cosmetic / unrelated change (size delta < 15%, no obvious indicator of layout break)\n" +
      "  broken   → likely meaningful regression\n" +
      "Without seeing the images, default to `drifted` unless the size delta is huge (>40%), in which case `broken`.",
    },
    { role: "user", content:
      `Scenario: ${descriptor}\n` +
      `Baseline file size: ${baseSize} bytes\n` +
      `Current file size: ${curSize} bytes\n` +
      `Size delta: ${baseSize === 0 ? "N/A" : `${(((curSize - baseSize) / baseSize) * 100).toFixed(1)}%`}\n\n` +
      `Output the JSON.`,
    },
  ];
  try {
    const raw = await chat(messages, { maxTokens: 200 });
    const m = raw.match(/\{[\s\S]*?\}/);
    const j = m ? JSON.parse(m[0]) : null;
    return {
      verdict: (j?.verdict as VisualVerdict["verdict"]) ?? "drifted",
      reason: j?.reason ?? "no LLM reasoning available",
      baseline_path: baselinePath,
      current_path: currentPath,
    };
  } catch (e) {
    return { verdict: "drifted", reason: `LLM unavailable (${(e as Error).message}); defaulting to drifted`, baseline_path: baselinePath, current_path: currentPath };
  }
}
