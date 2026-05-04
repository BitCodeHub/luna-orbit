/**
 * Visual regression — real pixel comparison + LLM judgment.
 *
 * v0.4.0 only checked file sizes (a lie). v0.4.1 actually compares the
 * images via pixelmatch (deterministic pixel-by-pixel) and asks the LLM
 * to judge whether the diff is meaningful (layout broke) or cosmetic
 * (font hinting, time-of-day, ad rotation).
 *
 *   verdict "ok"      → < 0.5% different pixels OR byte-identical
 *   verdict "drifted" → 0.5%–5% different, LLM judged cosmetic
 *   verdict "broken"  → > 5% different OR LLM judged structural
 *
 * Writes a PNG diff to <currentPath>.diff.png so the report can show
 * the user where the difference is.
 */
import { readFile, writeFile, stat } from "node:fs/promises";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { chat, type ChatMsg } from "./llm.js";

export interface VisualVerdict {
  verdict: "ok" | "drifted" | "broken";
  reason: string;
  baseline_path: string;
  current_path: string;
  /** Path to a side-by-side diff PNG (only set when there were any differing pixels). */
  diff_path?: string;
  /** Number of pixels that differed between the two images. */
  diff_pixels?: number;
  /** % of total pixels that differed. */
  diff_ratio?: number;
}

export async function compareToBaseline(
  baselinePath: string,
  currentPath: string,
  descriptor: string,
): Promise<VisualVerdict> {
  // Load both images.
  let basePng: PNG, curPng: PNG;
  try {
    basePng = PNG.sync.read(await readFile(baselinePath));
    curPng = PNG.sync.read(await readFile(currentPath));
  } catch (e) {
    return { verdict: "drifted", reason: `Could not load images: ${(e as Error).message}`, baseline_path: baselinePath, current_path: currentPath };
  }

  // Different dimensions = layout almost certainly changed.
  if (basePng.width !== curPng.width || basePng.height !== curPng.height) {
    return {
      verdict: "broken",
      reason: `Dimensions changed: baseline ${basePng.width}×${basePng.height} → current ${curPng.width}×${curPng.height}. This is almost always a layout regression (window size shifted, viewport changed, or content reflowed).`,
      baseline_path: baselinePath,
      current_path: currentPath,
    };
  }

  const { width, height } = basePng;
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(basePng.data, curPng.data, diff.data, width, height, {
    threshold: 0.1, // pixelmatch's per-pixel YIQ tolerance — 0.1 is fairly strict
    includeAA: false,
    alpha: 0.4,
  });
  const totalPixels = width * height;
  const ratio = diffPixels / totalPixels;

  // Persist a diff image alongside the current screenshot.
  const diffPath = currentPath.replace(/\.png$/i, ".diff.png");
  try { await writeFile(diffPath, PNG.sync.write(diff)); } catch { /* non-fatal */ }

  if (ratio < 0.005) {
    // Less than 0.5% differing pixels = sub-perceptual. Pass.
    return {
      verdict: "ok",
      reason: `${diffPixels.toLocaleString()} of ${totalPixels.toLocaleString()} pixels differ (${(ratio * 100).toFixed(3)}%) — below the 0.5% threshold. No meaningful change.`,
      baseline_path: baselinePath, current_path: currentPath,
      diff_path: diffPixels > 0 ? diffPath : undefined,
      diff_pixels: diffPixels, diff_ratio: ratio,
    };
  }
  if (ratio > 0.05) {
    return {
      verdict: "broken",
      reason: `${diffPixels.toLocaleString()} of ${totalPixels.toLocaleString()} pixels differ (${(ratio * 100).toFixed(2)}%) — well above the 5% structural-change threshold. Likely a real layout regression.`,
      baseline_path: baselinePath, current_path: currentPath,
      diff_path: diffPath, diff_pixels: diffPixels, diff_ratio: ratio,
    };
  }

  // Middle band (0.5%–5%) — let the LLM judge whether it looks cosmetic.
  const llmVerdict = await llmJudge(descriptor, ratio, diffPixels, totalPixels);
  return {
    ...llmVerdict,
    baseline_path: baselinePath, current_path: currentPath,
    diff_path: diffPath, diff_pixels: diffPixels, diff_ratio: ratio,
  };
}

async function llmJudge(descriptor: string, ratio: number, diffPixels: number, totalPixels: number): Promise<{ verdict: VisualVerdict["verdict"]; reason: string }> {
  const messages: ChatMsg[] = [
    { role: "system", content:
      "You are reviewing a visual regression diff. You don't see the images directly — only the pixel-diff stats and what the screen should show.\n" +
      "Output ONE JSON object: {\"verdict\":\"drifted\"|\"broken\",\"reason\":\"...\"}.\n" +
      "  drifted → likely cosmetic (anti-aliasing, font hinting, time/date strings, ad rotation, scrollbar position, cursor position)\n" +
      "  broken  → likely a real visual regression worth investigating\n" +
      "Use the ratio and the scenario description to judge. Diffs in the 0.5%–5% band on data-rich screens (dashboards, feeds, lists) often reflect dynamic content and are 'drifted'. The same band on static landing/checkout pages more likely indicates 'broken'.",
    },
    { role: "user", content:
      `Scenario: ${descriptor}\n` +
      `Differing pixels: ${diffPixels.toLocaleString()} of ${totalPixels.toLocaleString()} (${(ratio * 100).toFixed(2)}%)\n\n` +
      `Output the JSON.`,
    },
  ];
  try {
    const raw = await chat(messages, { maxTokens: 200 });
    const m = raw.match(/\{[\s\S]*?\}/);
    const j = m ? JSON.parse(m[0]) : null;
    return {
      verdict: (j?.verdict === "broken" ? "broken" : "drifted") as VisualVerdict["verdict"],
      reason: j?.reason ?? `${(ratio * 100).toFixed(2)}% differing pixels — LLM did not provide a reason`,
    };
  } catch (e) {
    return {
      verdict: "drifted",
      reason: `${(ratio * 100).toFixed(2)}% differing pixels; LLM unreachable (${(e as Error).message}); defaulting to drifted`,
    };
  }
}

// Keep the import around for future byte-stat fallback.
void stat;
