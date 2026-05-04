/**
 * Luna Orbit — programmatic API.
 *
 *   import { runPlan } from "luna-orbit";
 *   const report = await runPlan("plans/sample.md", { outDir: "./orbit-out" });
 *   if (!report.passed) process.exit(1);
 */
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { loadPlan, parsePlan, type Plan } from "./plan.js";
import { WebDriver } from "./drivers/web.js";
import { MobileDriver } from "./drivers/mobile.js";
import type { Driver } from "./drivers/types.js";
import { runIntent, checkAssertion } from "./agent.js";
import { writeReport, type RunReport } from "./report.js";

export { loadPlan, parsePlan } from "./plan.js";
export type { Plan } from "./plan.js";
export type { Driver, Snapshot, Action } from "./drivers/types.js";
export { WebDriver } from "./drivers/web.js";
export { MobileDriver } from "./drivers/mobile.js";
export type { RunReport } from "./report.js";
export { authorPlan, authorAndRun } from "./author.js";
export type { AuthorOptions, AuthorResult } from "./author.js";

export interface RunOptions {
  /** Where screenshots + report.html + report.json go. Default: ./qa-pilot-out/<timestamp>. */
  outDir?: string;
  /** Headed browser (web only). Default: false (headless). */
  headed?: boolean;
}

export async function runPlanFromString(source: string, opts: RunOptions = {}): Promise<RunReport> {
  return runPlanInternal(parsePlan(source), opts);
}

export async function runPlan(planPath: string, opts: RunOptions = {}): Promise<RunReport> {
  const plan = await loadPlan(planPath);
  return runPlanInternal(plan, opts);
}

async function runPlanInternal(plan: Plan, opts: RunOptions): Promise<RunReport> {
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
