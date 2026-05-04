#!/usr/bin/env node
/**
 * Luna Orbit CLI — autonomous regression testing for any web or mobile app.
 *
 *   luna-orbit run <plan.md> [--out <dir>] [--headed]
 *   luna-orbit serve [--port 8780] [--data-dir ./orbit-data] [--max-parallel 2]
 *   orbit run plans/sample.md
 */
import { runPlan, authorPlan, authorAndRun, captureFixture } from "./index.js";
import { createServer } from "./server/index.js";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, delimiter } from "node:path";

// Auto-add our own node_modules/.bin to PATH so the spawned `agent-browser`
// (and other CLI deps) resolve correctly even when the user runs us via an
// absolute path or as a daemon. Idempotent — won't double-prepend.
(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const localBin = join(here, "..", "node_modules", ".bin");
  const cur = process.env.PATH ?? "";
  if (!cur.split(delimiter).includes(localBin)) {
    process.env.PATH = `${localBin}${delimiter}${cur}`;
  }
})();

function usage(): never {
  console.error(`Luna Orbit — AI-powered autonomous regression testing

Usage:
  luna-orbit auto    --target <URL> --requirement "<plain English>" [--out <dir>] [--headed]
                                                 # AI-NATIVE: write the plan, run it, report
  luna-orbit author  --target <URL> --requirement "<plain English>" [--save <plan.md>]
                                                 # write a plan from a requirement, do not run
  luna-orbit run     <plan.md> [--out <dir>] [--headed]
                                                 # run an existing plan
  luna-orbit login   --target <URL> --save <fixture.json>
                                                 # capture cookies after manual login → reuse via plan.auth
  luna-orbit serve   [--port N] [--data-dir DIR] [--max-parallel N]
                                                 # HTTP API + dashboard (+ scheduler if any plan has cron:)
  luna-orbit monitor <plans-dir> [--port N]      # alias for serve that auto-loads plans for cron scheduling
  luna-orbit record  --target <URL> --save <plan.md>           [v0.4 — coming soon]
  luna-orbit run-changed --base main [--plans <dir>]           [v0.4 — coming soon]
  orbit run <plan.md>                            # short alias

Env vars:
  LUNA_ORBIT_LLM_BASE_URL    default http://100.90.199.128:8084/v1
                             (Lysa/Luna's MLX deep tier — gemma-4-31b-it)
  LUNA_ORBIT_LLM_MODEL       default mlx-community/gemma-4-31b-it-bf16
  LUNA_ORBIT_LLM_API_KEY     optional bearer token (Anthropic, OpenAI, Azure, etc.)
  LUNA_ORBIT_AGENT_BROWSER_BIN  default "agent-browser" — web driver binary
  LUNA_ORBIT_HMA_DIR         default ~/Code/hma_automation — Hyundai mobile pages
  LUNA_ORBIT_APPIUM_URL      default http://127.0.0.1:4723 — generic Appium server
  LUNA_ORBIT_API_KEYS        comma-separated bearer tokens for \`serve\` mode
                             (if unset, server is OPEN — dev only)
  LUNA_ORBIT_DATA_DIR        default ./orbit-data — where \`serve\` stores runs
  LUNA_ORBIT_PORT            default 8780
  LUNA_ORBIT_MAX_PARALLEL    default 2 — concurrent runs (each spawns a browser)

Drivers (set "platform:" in your plan frontmatter):
  platform: web       Playwright via agent-browser  (any website / SPA / webapp)
  platform: mobile    Appium                        (any iOS or Android app)
`);
  process.exit(1);
}

function flagValue(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx < 0) return undefined;
  return argv[idx + 1];
}

async function cmdRun(argv: string[]) {
  const planPath = argv[0];
  if (!planPath) usage();
  const outDir = flagValue(argv, "--out");
  const headed = argv.includes("--headed");

  console.log(`luna-orbit · running ${planPath}`);
  const report = await runPlan(planPath, { outDir, headed });

  const intentLine = `intents ${report.intents.filter((it) => it.outcome === "satisfied").length}/${report.intents.length} satisfied`;
  const assertLine = `assertions ${report.assertions.filter((a) => a.pass).length}/${report.assertions.length} pass`;
  console.log(`\n${report.passed ? "✓ PASS" : "✗ FAIL"} — ${intentLine}; ${assertLine}; ${(report.durationMs / 1000).toFixed(1)}s`);
  process.exit(report.passed ? 0 : 1);
}

async function cmdServe(argv: string[]) {
  const port = Number(flagValue(argv, "--port") ?? process.env.LUNA_ORBIT_PORT ?? "8780");
  const dataDir = flagValue(argv, "--data-dir") ?? process.env.LUNA_ORBIT_DATA_DIR ?? "./orbit-data";
  const maxConcurrent = Number(flagValue(argv, "--max-parallel") ?? process.env.LUNA_ORBIT_MAX_PARALLEL ?? "2");
  const webhookUrls = (process.env.LUNA_ORBIT_WEBHOOKS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const webhookSecret = process.env.LUNA_ORBIT_WEBHOOK_SECRET || undefined;
  const publicBaseUrl = process.env.LUNA_ORBIT_PUBLIC_URL || undefined;

  const server = createServer({ port, dataDir, maxConcurrent, webhookUrls, webhookSecret, publicBaseUrl });
  await server.start();
}

async function cmdAuthor(argv: string[]) {
  const target = flagValue(argv, "--target");
  const requirement = flagValue(argv, "--requirement");
  const platform = (flagValue(argv, "--platform") as "web" | "mobile") ?? "web";
  const viewport = flagValue(argv, "--viewport");
  const save = flagValue(argv, "--save");
  if (!target || !requirement) {
    console.error("luna-orbit author: --target and --requirement are required");
    process.exit(1);
  }
  console.log(`luna-orbit · authoring plan for ${target}`);
  console.log(`  requirement: ${requirement}`);
  const result = await authorPlan({ target, requirement, platform, viewport });
  if (save) {
    await writeFile(save, result.planMd);
    console.log(`\nplan saved → ${save}  (${result.exploration.length} exploration step(s))`);
  } else {
    console.log("\n" + "─".repeat(60));
    console.log(result.planMd);
    console.log("─".repeat(60));
    console.log(`(${result.exploration.length} exploration step(s) — pass --save <path> to write to disk)`);
  }
}

async function cmdAuto(argv: string[]) {
  const target = flagValue(argv, "--target");
  const requirement = flagValue(argv, "--requirement");
  const platform = (flagValue(argv, "--platform") as "web" | "mobile") ?? "web";
  const viewport = flagValue(argv, "--viewport");
  const outDir = flagValue(argv, "--out");
  const headed = argv.includes("--headed");
  if (!target || !requirement) {
    console.error("luna-orbit auto: --target and --requirement are required");
    process.exit(1);
  }
  console.log(`luna-orbit · auto-testing ${target}`);
  console.log(`  requirement: ${requirement}`);
  const { plan, exploration, report } = await authorAndRun(
    { target, requirement, platform, viewport, headed },
    { outDir, headed },
  );
  const intentLine = `intents ${report.intents.filter((it) => it.outcome === "satisfied").length}/${report.intents.length} satisfied`;
  const assertLine = `assertions ${report.assertions.filter((a) => a.pass).length}/${report.assertions.length} pass`;
  console.log(`\n  authored plan (${exploration.length} exploration step(s)):\n`);
  console.log(plan.split("\n").map((l) => "    " + l).join("\n"));
  console.log(`\n${report.passed ? "✓ PASS" : "✗ FAIL"} — ${intentLine}; ${assertLine}; ${(report.durationMs / 1000).toFixed(1)}s`);
  process.exit(report.passed ? 0 : 1);
}

async function cmdLogin(argv: string[]) {
  const target = flagValue(argv, "--target");
  const save = flagValue(argv, "--save");
  if (!target || !save) {
    console.error("luna-orbit login: --target <URL> and --save <fixture.json> are required");
    process.exit(1);
  }
  console.log(`luna-orbit · capturing auth fixture from ${target}`);
  const fix = await captureFixture(target, save);
  console.log(`\n  saved → ${save}  (${fix.cookies?.length ?? 0} cookies, final URL: ${fix.meta?.final_url ?? "?"})`);
  console.log(`  use it in a plan:\n    ---\n    auth: ${save}\n    target: ${fix.meta?.final_url ?? target}\n    ---`);
  process.exit(0);
}

async function cmdMonitor(argv: string[]) {
  // monitor = serve with --plans-dir, which the server auto-scans for cron-equipped plans.
  const port = Number(flagValue(argv, "--port") ?? process.env.LUNA_ORBIT_PORT ?? "8780");
  const dataDir = flagValue(argv, "--data-dir") ?? process.env.LUNA_ORBIT_DATA_DIR ?? "./orbit-data";
  const plansDir = argv.find((a) => !a.startsWith("--")) ?? process.env.LUNA_ORBIT_PLANS_DIR;
  if (!plansDir) {
    console.error("luna-orbit monitor: provide a plans directory: `luna-orbit monitor ./plans`");
    process.exit(1);
  }
  const webhookUrls = (process.env.LUNA_ORBIT_WEBHOOKS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const webhookSecret = process.env.LUNA_ORBIT_WEBHOOK_SECRET || undefined;
  const publicBaseUrl = process.env.LUNA_ORBIT_PUBLIC_URL || undefined;
  const server = createServer({ port, dataDir, maxConcurrent: 1, webhookUrls, webhookSecret, plansDir, publicBaseUrl });
  await server.start();
}

function v04Stub(name: string): never {
  console.error(`luna-orbit ${name}: stubbed in v0.3 — coming in v0.4.

The CLI surface is reserved so your scripts won't break when the real
implementation lands. Track progress: https://github.com/BitCodeHub/luna-orbit/issues
`);
  process.exit(2);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);
  if (cmd === "run") return cmdRun(rest);
  if (cmd === "serve") return cmdServe(rest);
  if (cmd === "author") return cmdAuthor(rest);
  if (cmd === "auto") return cmdAuto(rest);
  if (cmd === "login") return cmdLogin(rest);
  if (cmd === "monitor") return cmdMonitor(rest);
  if (cmd === "record") return v04Stub("record");
  if (cmd === "run-changed") return v04Stub("run-changed");
  usage();
}

main().catch((e) => {
  console.error(`luna-orbit: ${e.message}`);
  process.exit(2);
});
