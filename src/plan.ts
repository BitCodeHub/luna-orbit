/**
 * Plan format — minimal markdown with a YAML-ish frontmatter block.
 *
 * Example:
 *
 *   ---
 *   name: Checkout · happy path
 *   target: https://shop.example.com
 *   platform: web
 *   viewport: 1280x800
 *   max_steps_per_intent: 8
 *   ---
 *
 *   ## Steps
 *   1. Click "Add to cart" on the first product
 *   2. Open the cart
 *   3. Click "Checkout"
 *   4. Fill the email field with "qa@example.com"
 *   5. Click "Continue to payment"
 *
 *   ## Assertions
 *   - The order summary shows exactly one item
 *   - The "Continue to payment" page is visible
 */
import { readFile } from "node:fs/promises";

export interface Plan {
  name: string;
  target: string;
  platform: "web" | "mobile";
  viewport?: string;
  /** Cap LLM iterations spent on a single intent step before giving up. */
  maxStepsPerIntent: number;
  /** "appium" (generic, default) or "hma" (Lumen-specific Hyundai POM). Mobile-only. */
  mobileMode?: "appium" | "hma";
  /** Appium capabilities — required when mobileMode = "appium". JSON-encoded in frontmatter. */
  capabilities?: Record<string, unknown>;
  /** Hyundai-specific (mobileMode = "hma"). */
  hmaEntry?: string;
  hmaArgs?: string[];
  /** Numbered intents — each is one line of natural-language guidance for the agent. */
  intents: string[];
  /** Final assertions checked after all intents complete. */
  assertions: string[];
  /** Original source path (for the report). */
  sourcePath?: string;

  // ── v0.3 additions (each maps 1:1 to a feature in the gap matrix) ──

  /** Schedule expression — `every 15m`, `every 6h`, or 5-field cron. Used by `luna-orbit monitor` / scheduler in `serve`. */
  cron?: string;
  /** Path to an auth fixture JSON (cookies + localStorage captured via `luna-orbit login`). Loaded into the browser before the run starts. */
  auth?: string;
  /** Auto-retry the whole run on failure. Default 0 (no retry). Set 1-3 to fight transient flake. The flake module attaches an LLM-written diagnosis when retries differ. */
  retry?: number;
  /** Run axe-core after the final intent and fail the run on serious violations. v0.3 = LLM evaluates from the snapshot; v0.4 = real axe-core injection. */
  a11y?: boolean;
  /** Browsers to run against in parallel. v0.3 honours only the first; v0.4 = full matrix via Playwright BrowserType. */
  browsers?: string[];
  /** Visual regression — path (or directory) of baseline screenshots to compare against using LLM vision. */
  visualBaseline?: string;
  /** Parameter matrix — same plan run once per combination. v0.3 stub: parsed but not yet expanded. v0.4 = LLM generates variations + each runs as a separate report. */
  params?: Record<string, string[]>;
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]+?)\n---\s*\n/;

function parseFrontmatter(src: string): { meta: Record<string, string>; body: string } {
  const m = src.match(FRONTMATTER_RE);
  if (!m) return { meta: {}, body: src };
  const meta: Record<string, string> = {};
  const block = m[1] ?? "";
  for (const line of block.split("\n")) {
    const kv = line.match(/^\s*([a-z][a-z0-9_]*)\s*:\s*(.+?)\s*$/i);
    if (kv && kv[1] && kv[2]) meta[kv[1]] = kv[2];
  }
  return { meta, body: src.slice(m[0].length) };
}

function extractListUnder(body: string, heading: string): string[] {
  const re = new RegExp(`##\\s+${heading}[^\\n]*\\n([\\s\\S]*?)(?:\\n##\\s+|$)`, "i");
  const m = body.match(re);
  if (!m || !m[1]) return [];
  const items: string[] = [];
  for (const line of m[1].split("\n")) {
    const num = line.match(/^\s*\d+\.\s+(.*\S)\s*$/);
    const dash = line.match(/^\s*[-*]\s+(.*\S)\s*$/);
    const text = num?.[1] ?? dash?.[1];
    if (text) items.push(text);
  }
  return items;
}

export function parsePlan(src: string, sourcePath?: string): Plan {
  const { meta, body } = parseFrontmatter(src);
  const intents = extractListUnder(body, "Steps");
  const assertions = extractListUnder(body, "Assertions");
  const platform = (meta.platform as "web" | "mobile") || "web";
  if (!meta.name) throw new Error("plan: missing `name` in frontmatter");
  if (!meta.target && platform === "web") throw new Error("plan: missing `target` URL in frontmatter");
  if (intents.length === 0) throw new Error("plan: ## Steps section is empty or missing");
  let capabilities: Record<string, unknown> | undefined;
  if (meta.capabilities) {
    try {
      capabilities = JSON.parse(meta.capabilities) as Record<string, unknown>;
    } catch {
      throw new Error(`plan: \`capabilities:\` must be a valid JSON object on a single line. Got: ${meta.capabilities.slice(0, 80)}`);
    }
  }
  let params: Record<string, string[]> | undefined;
  if (meta.params) {
    try {
      const parsed = JSON.parse(meta.params);
      if (parsed && typeof parsed === "object") params = parsed as Record<string, string[]>;
    } catch {
      throw new Error(`plan: \`params:\` must be valid JSON like {"name":["alice","bob"]}. Got: ${meta.params.slice(0, 80)}`);
    }
  }
  const browsers = meta.browsers ? meta.browsers.split(/\s*,\s*/).filter(Boolean) : undefined;
  return {
    name: meta.name,
    target: meta.target ?? "",
    platform,
    viewport: meta.viewport,
    maxStepsPerIntent: meta.max_steps_per_intent ? Number(meta.max_steps_per_intent) : 8,
    mobileMode: (meta.mobile_mode as "appium" | "hma") || (platform === "mobile" ? "appium" : undefined),
    capabilities,
    hmaEntry: meta.hma_entry,
    hmaArgs: meta.hma_args ? meta.hma_args.split(/\s+/) : undefined,
    intents,
    assertions,
    sourcePath,
    cron: meta.cron,
    auth: meta.auth,
    retry: meta.retry ? Math.max(0, Math.min(5, Number(meta.retry))) : 0,
    a11y: meta.a11y === "true",
    browsers,
    visualBaseline: meta.visual_baseline,
    params,
  };
}

export async function loadPlan(path: string): Promise<Plan> {
  const src = await readFile(path, "utf8");
  return parsePlan(src, path);
}
