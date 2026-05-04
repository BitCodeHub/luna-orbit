/**
 * Luna Orbit — programmatic API.
 *
 *   import { runPlan } from "luna-orbit";
 *   const report = await runPlan("plans/sample.md", { outDir: "./orbit-out" });
 *   if (!report.passed) process.exit(1);
 */
import { join, isAbsolute, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { loadPlan, parsePlan, type Plan } from "./plan.js";
import { WebDriver } from "./drivers/web.js";
import { MobileDriver } from "./drivers/mobile.js";
import type { Driver } from "./drivers/types.js";
import { runIntent, checkAssertion } from "./agent.js";
import { writeReport, type RunReport } from "./report.js";
import { applyFixture } from "./auth-fixture.js";
import { compareToBaseline, type VisualVerdict } from "./visual.js";
import { diagnoseFlake, summariseAttempt, type FlakeNote } from "./flake.js";
import { generateBugReport, type BugReport } from "./bugreport.js";

export { loadPlan, parsePlan } from "./plan.js";
export type { Plan } from "./plan.js";
export type { Driver, Snapshot, Action } from "./drivers/types.js";
export { WebDriver } from "./drivers/web.js";
export { MobileDriver } from "./drivers/mobile.js";
export type { RunReport } from "./report.js";
export { authorPlan, authorAndRun } from "./author.js";
export type { AuthorOptions, AuthorResult } from "./author.js";
export { captureFixture } from "./auth-fixture.js";
export type { AuthFixture } from "./auth-fixture.js";
export { compareToBaseline } from "./visual.js";
export type { VisualVerdict } from "./visual.js";
export { generateBugReport, renderBugReportMarkdown } from "./bugreport.js";
export type { BugReport } from "./bugreport.js";
export { parseSchedule, createScheduler } from "./scheduling.js";
export type { Schedule, Scheduler } from "./scheduling.js";

export interface RunOptions {
  /** Where screenshots + report.html + report.json go. Default: ./orbit-out/<timestamp>. */
  outDir?: string;
  /** Headed browser (web only). Default: false (headless). */
  headed?: boolean;
}

/**
 * Augmented report — superset of RunReport with the v0.3 attachments
 * (visual verdicts, flake diagnosis, AI bug report). All optional.
 */
export type EnrichedReport = RunReport & {
  flake?: FlakeNote;
  visual?: VisualVerdict;
  bug_report?: BugReport;
};

export async function runPlanFromString(source: string, opts: RunOptions = {}): Promise<EnrichedReport> {
  return runPlanWithExtras(parsePlan(source), opts);
}

export async function runPlan(planPath: string, opts: RunOptions = {}): Promise<EnrichedReport> {
  const plan = await loadPlan(planPath);
  return runPlanWithExtras(plan, opts);
}

/**
 * Wrapper around the core run loop that adds:
 *  - auth fixture pre-load (plan.auth)
 *  - retry/flake handling (plan.retry → re-runs on fail; LLM diagnoses flake)
 *  - visual diff vs baseline (plan.visualBaseline)
 *  - AI-generated bug report on final failure
 */
async function runPlanWithExtras(plan: Plan, opts: RunOptions): Promise<EnrichedReport> {
  const maxAttempts = (plan.retry ?? 0) + 1;
  const attempts: RunReport[] = [];
  let final: RunReport | null = null;

  for (let i = 0; i < maxAttempts; i++) {
    const attemptOpts = i === 0
      ? opts
      : { ...opts, outDir: opts.outDir ? `${opts.outDir}-retry${i}` : undefined };
    const report = await runOnce(plan, attemptOpts);
    attempts.push(report);
    final = report;
    if (report.passed) break; // success on this attempt — stop retrying
  }

  if (!final) throw new Error("luna-orbit: no attempts ran");

  const enriched: EnrichedReport = { ...final };

  // ── Flake diagnosis (only when later attempts disagreed with earlier) ──
  if (attempts.length > 1) {
    const flake: FlakeNote = {
      attempts: attempts.length,
      flaked: final.passed && attempts.slice(0, -1).some((a) => !a.passed),
      attempt_results: attempts.map(summariseAttempt),
    };
    if (flake.flaked) {
      flake.diagnosis = await diagnoseFlake(attempts);
    }
    enriched.flake = flake;
  }

  // ── Visual diff vs baseline ──────────────────────────────────────
  if (plan.visualBaseline && final.finalScreenshot) {
    const baselinePath = isAbsolute(plan.visualBaseline)
      ? plan.visualBaseline
      : (plan.sourcePath ? resolve(plan.sourcePath, "..", plan.visualBaseline) : resolve(plan.visualBaseline));
    try {
      enriched.visual = await compareToBaseline(baselinePath, final.finalScreenshot, plan.name);
      if (enriched.visual.verdict === "broken" && enriched.passed) {
        enriched.passed = false; // hard fail on visual regression
      }
    } catch (e) {
      enriched.visual = { verdict: "drifted", reason: `Could not compare: ${(e as Error).message}`, baseline_path: baselinePath, current_path: final.finalScreenshot };
    }
  }

  // ── AI bug report on failure ─────────────────────────────────────
  if (!enriched.passed) {
    try {
      const br = await generateBugReport(plan, final);
      if (br) enriched.bug_report = br;
    } catch { /* never let bug-report-gen errors fail the run */ }
  }

  return enriched;
}

async function runOnce(plan: Plan, opts: RunOptions): Promise<RunReport> {
  const startedAt = new Date();
  const outDir = opts.outDir ?? join(process.cwd(), "orbit-out", startedAt.toISOString().replace(/[:.]/g, "-"));
  await mkdir(join(outDir, "screenshots"), { recursive: true });

  const driver: Driver = plan.platform === "mobile"
    ? new MobileDriver({
        mode: plan.mobileMode ?? "appium",
        capabilities: plan.capabilities,
        hmaEntry: plan.hmaEntry,
        hmaArgs: plan.hmaArgs,
      })
    : new WebDriver({ viewport: plan.viewport, headed: opts.headed });

  await driver.start();
  if (plan.target) await driver.open(plan.target);

  // Apply auth fixture (web only — mobile auth is a v0.4 thing).
  if (plan.auth && plan.platform === "web") {
    const fixturePath = isAbsolute(plan.auth)
      ? plan.auth
      : (plan.sourcePath ? resolve(plan.sourcePath, "..", plan.auth) : resolve(plan.auth));
    try {
      await applyFixture(fixturePath);
      // Re-open target so the auth applies on a fresh page load.
      if (plan.target) await driver.open(plan.target);
    } catch (e) {
      console.error(`[auth] failed to apply fixture ${plan.auth}:`, (e as Error).message);
    }
  }

  const intents: RunReport["intents"] = [];
  for (let i = 0; i < plan.intents.length; i++) {
    const intent = plan.intents[i]!;
    const run = await runIntent(driver, intent, plan.maxStepsPerIntent);
    let screenshotPath: string | undefined;
    try {
      screenshotPath = join(outDir, "screenshots", `intent-${String(i + 1).padStart(2, "0")}.png`);
      await driver.screenshot(screenshotPath);
    } catch { /* screenshot is best-effort */ }
    intents.push({ ...run, screenshotPath });
    if (run.outcome === "errored" || run.outcome === "gave_up") break;
  }

  const assertions: RunReport["assertions"] = [];
  for (const a of plan.assertions) {
    assertions.push({ assertion: a, ...(await checkAssertion(driver, a)) });
  }

  let finalScreenshot: string | undefined;
  try {
    finalScreenshot = join(outDir, "screenshots", "final.png");
    await driver.screenshot(finalScreenshot, true);
  } catch { /* ok */ }

  await driver.close();

  const finishedAt = new Date();
  const intentsAllSatisfied = intents.length === plan.intents.length && intents.every((it) => it.outcome === "satisfied");
  const assertionsAllPass = assertions.every((a) => a.pass);
  const passed = intentsAllSatisfied && (plan.assertions.length === 0 || assertionsAllPass);

  const report: RunReport = {
    plan,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    intents,
    assertions,
    finalScreenshot,
    passed,
  };
  await writeReport(report, outDir);
  return report;
}
