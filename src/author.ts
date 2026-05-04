/**
 * Plan authoring — the AI-native flagship.
 *
 *   user gives:   { target: URL, requirement: "test the checkout happy-path" }
 *   Luna does:    open target → snapshot → light exploration → compose plan
 *   user gets:    a runnable Luna Orbit plan.md (or runs it immediately via `auto`)
 *
 * The author loop deliberately does NOT execute destructive actions while
 * exploring — no submit, no pay, no delete. Exploration is read-only by
 * default; it just snapshots, navigates within the app, and clicks safe
 * disclosure-only elements (expanders, tabs) when needed to understand the
 * app's structure.
 *
 * No competitor in the OSS category does this with a local LLM default.
 * Octomind / QA.tech / Reflect have it, but they're closed SaaS that ship
 * your DOM to OpenAI/Anthropic. That's the wedge.
 */
import { chatJson, type ChatMsg } from "./llm.js";
import { WebDriver } from "./drivers/web.js";
import { MobileDriver } from "./drivers/mobile.js";
import type { Driver, Snapshot } from "./drivers/types.js";

export interface AuthorOptions {
  /** URL (web) or "appium" / app identifier (mobile). */
  target: string;
  /** What the user wants tested, in their own words. */
  requirement: string;
  /** "web" (default) or "mobile". */
  platform?: "web" | "mobile";
  viewport?: string;
  /** Mobile-only. */
  capabilities?: Record<string, unknown>;
  /** How many exploration ticks before forcing a plan. Default 5. */
  maxExploreSteps?: number;
  /** Cap LLM iterations the *generated* plan should allow per intent. Default 8. */
  maxStepsPerIntentInPlan?: number;
  /** Optional headed mode (web). */
  headed?: boolean;
}

export interface AuthorResult {
  /** The generated plan markdown — ready to pass to runPlan. */
  planMd: string;
  /** Per-step record of what the author agent did while exploring. */
  exploration: Array<{ action: string; detail?: string; urlAfter?: string }>;
  /** Final URL the explorer ended on. */
  endedAt?: string;
}

const SYSTEM_PROMPT = `You are an autonomous QA architect.

Given:
  - a TARGET app (a URL or mobile app)
  - a high-level REQUIREMENT in the user's own words
  - a SNAPSHOT of the current page (URL, title, list of interactive elements with refs like @e1, @e2, plus a tail of the page text)
  - the EXPLORATION LOG of what you have already done

You decide whether you have enough information to author a runnable test plan, OR whether you need one more exploration step.

Output exactly ONE JSON object — no preamble, no commentary, no code fences.

Two possible outputs:

(A) Need more exploration — pick ONE safe action:
   {"action":"click","ref":"@e3","why":"reveal the signup form so I can name the fields"}
   {"action":"navigate","url":"https://...","why":"check whether the pricing page exists"}
   {"action":"snapshot","why":"see what loaded after the redirect"}

   SAFETY RULES while exploring:
   - Never submit forms (no Login, Sign Up, Send, Pay, Delete, Confirm, Subscribe).
   - Never fill payment, password, or PII fields.
   - Prefer disclosure-only clicks: tabs, accordions, "More", menu open/close.
   - If a click would clearly trigger a destructive or irreversible action, do NOT click it.

(B) Enough info — author the plan. Output a complete Luna Orbit plan markdown:
   {"action":"compose","plan_md":"---\\nname: …\\ntarget: …\\nplatform: web\\nviewport: …\\nmax_steps_per_intent: 8\\n---\\n\\n## Steps\\n1. …\\n2. …\\n\\n## Assertions\\n- …\\n- …"}

   PLAN-WRITING RULES:
   - Frontmatter MUST include: name, target, platform, max_steps_per_intent. Include viewport if web.
   - 3–8 numbered steps in ## Steps. Each step = one natural-language intent (NOT a CSS selector, NOT a click coordinate). Reference visible UI by quoted text where possible.
   - 2–4 assertions in ## Assertions. Each assertion = a natural-language fact the LLM can verify against the live snapshot.
   - Cover the user's requirement. Do not invent flows the requirement didn't ask for.
   - Steps should be runnable from the TARGET URL (not assume prior auth unless the requirement says so).
   - Plan name should be specific: "Checkout · happy path" not "Test 1".

Decide now.`;

export async function authorPlan(opts: AuthorOptions): Promise<AuthorResult> {
  const platform = opts.platform ?? "web";
  const driver: Driver = platform === "mobile"
    ? new MobileDriver({ mode: "appium", capabilities: opts.capabilities })
    : new WebDriver({ viewport: opts.viewport, headed: opts.headed });

  const exploration: AuthorResult["exploration"] = [];
  let endedAt: string | undefined;
  let planMd: string | null = null;

  await driver.start();
  try {
    if (opts.target) await driver.open(opts.target);

    const maxSteps = opts.maxExploreSteps ?? 5;
    for (let i = 0; i < maxSteps; i++) {
      const snap = await driver.snapshot();
      endedAt = snap.url;

      const messages: ChatMsg[] = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content:
          `TARGET: ${opts.target}\n` +
          `PLATFORM: ${platform}\n` +
          `REQUIREMENT: ${opts.requirement}\n\n` +
          `EXPLORATION LOG (${exploration.length} step(s)):\n` +
          (exploration.length === 0
            ? "(none yet — this is the first snapshot)"
            : exploration.map((e, idx) => `  ${idx + 1}. ${e.action}${e.detail ? ` — ${e.detail.slice(0, 120)}` : ""}`).join("\n")
          ) + "\n\n" +
          `SNAPSHOT:\n${snapshotForLLM(snap)}\n\n` +
          `What is your next decision? Output a single JSON object.`,
        },
      ];

      let decision: { action: string; ref?: string; url?: string; why?: string; plan_md?: string };
      try {
        decision = await chatJson(messages, { maxTokens: 1500 });
      } catch (e) {
        exploration.push({ action: "llm_error", detail: (e as Error).message });
        break;
      }

      if (decision.action === "compose" && decision.plan_md) {
        planMd = ensurePlanShape(decision.plan_md, opts);
        exploration.push({ action: "compose", detail: decision.why });
        break;
      }

      if (decision.action === "click" && decision.ref) {
        const r = await driver.act({ type: "click", ref: decision.ref });
        exploration.push({ action: `click ${decision.ref}`, detail: decision.why ?? r.detail, urlAfter: (await driver.snapshot()).url });
        continue;
      }

      if (decision.action === "navigate" && decision.url) {
        await driver.act({ type: "open", url: decision.url });
        exploration.push({ action: `navigate ${decision.url}`, detail: decision.why });
        continue;
      }

      if (decision.action === "snapshot") {
        // Just loop — next iteration will re-snapshot anyway.
        exploration.push({ action: "snapshot", detail: decision.why });
        continue;
      }

      // Unknown decision shape — log and try one more iteration.
      exploration.push({ action: "unknown", detail: JSON.stringify(decision).slice(0, 200) });
    }

    // Force composition if exploration ran out without a plan.
    if (!planMd) {
      const snap = await driver.snapshot();
      planMd = await forceCompose(opts, snap);
    }
  } finally {
    await driver.close();
  }

  return { planMd, exploration, endedAt };
}

/**
 * Runs the author + immediately runs the resulting plan. The "auto" mode —
 * a single command turns a requirement into a pass/fail report.
 */
export async function authorAndRun(opts: AuthorOptions, runOpts: { outDir?: string; headed?: boolean } = {}) {
  const { runPlanFromString } = await import("./index.js");
  const author = await authorPlan(opts);
  const report = await runPlanFromString(author.planMd, runOpts);
  return { plan: author.planMd, exploration: author.exploration, report };
}

// ─────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────

function snapshotForLLM(s: Snapshot): string {
  const lines: string[] = [];
  if (s.url) lines.push(`URL: ${s.url}`);
  if (s.title) lines.push(`Title: ${s.title}`);
  lines.push("Interactive elements:");
  if (s.elements.length === 0) lines.push("  (none in accessibility tree)");
  else for (const el of s.elements.slice(0, 60)) {
    const bits = [el.ref, `[${el.role}]`];
    if (el.name) bits.push(`"${el.name}"`);
    lines.push(`  ${bits.join(" ")}`);
  }
  if (s.raw) {
    lines.push("");
    lines.push("Page text tail:");
    lines.push(s.raw.slice(-2000));
  }
  return lines.join("\n");
}

/** Make sure the LLM-emitted plan has the required frontmatter fields. */
function ensurePlanShape(md: string, opts: AuthorOptions): string {
  // If the LLM forgot frontmatter or fields, patch them in.
  const hasFrontmatter = /^---\s*\n[\s\S]+?\n---/.test(md);
  if (!hasFrontmatter) {
    const front =
      `---\n` +
      `name: ${escapeYaml(opts.requirement.slice(0, 80))}\n` +
      `target: ${opts.target}\n` +
      `platform: ${opts.platform ?? "web"}\n` +
      (opts.viewport ? `viewport: ${opts.viewport}\n` : "") +
      `max_steps_per_intent: ${opts.maxStepsPerIntentInPlan ?? 8}\n` +
      `---\n\n`;
    return front + md.replace(/^---[\s\S]+?---\s*\n/, "");
  }
  // Patch missing fields without disturbing the existing block.
  return md
    .replace(/(^---\s*\n)([\s\S]+?)(\n---)/, (_m, open: string, body: string, close: string) => {
      let b = body;
      if (!/\bplatform:/i.test(b)) b += `\nplatform: ${opts.platform ?? "web"}`;
      if (!/\btarget:/i.test(b)) b += `\ntarget: ${opts.target}`;
      if (!/\bmax_steps_per_intent:/i.test(b)) b += `\nmax_steps_per_intent: ${opts.maxStepsPerIntentInPlan ?? 8}`;
      if (opts.viewport && !/\bviewport:/i.test(b)) b += `\nviewport: ${opts.viewport}`;
      return `${open}${b}${close}`;
    });
}

function escapeYaml(s: string): string {
  return s.replace(/[:#]/g, " ").replace(/\s+/g, " ").trim();
}

/** When the explore loop runs out without composing, force a plan from current state. */
async function forceCompose(opts: AuthorOptions, snap: Snapshot): Promise<string> {
  const messages: ChatMsg[] = [
    { role: "system", content: SYSTEM_PROMPT + "\n\nYou MUST output {action:\"compose\", plan_md:\"…\"} now. No more exploration." },
    { role: "user", content:
      `TARGET: ${opts.target}\nPLATFORM: ${opts.platform ?? "web"}\nREQUIREMENT: ${opts.requirement}\n\nFinal SNAPSHOT:\n${snapshotForLLM(snap)}` },
  ];
  const decision = await chatJson<{ plan_md?: string }>(messages, { maxTokens: 1500 });
  if (!decision.plan_md) {
    // Last resort — minimum viable plan around the requirement
    return `---\nname: ${escapeYaml(opts.requirement.slice(0, 80))}\ntarget: ${opts.target}\nplatform: ${opts.platform ?? "web"}\n${opts.viewport ? `viewport: ${opts.viewport}\n` : ""}max_steps_per_intent: ${opts.maxStepsPerIntentInPlan ?? 8}\n---\n\n## Steps\n1. ${opts.requirement}\n\n## Assertions\n- The page loaded without error\n`;
  }
  return ensurePlanShape(decision.plan_md, opts);
}
