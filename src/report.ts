/**
 * Reporter — writes a JSON manifest + a self-contained HTML report with
 * per-step screenshots. The HTML is intentionally one file (no external
 * assets) so it works as a CI artifact you can email or attach to a PR.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, basename, relative } from "node:path";
import type { IntentRun } from "./agent.js";
import type { Plan } from "./plan.js";

export interface RunReport {
  plan: Plan;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  intents: Array<IntentRun & { screenshotPath?: string }>;
  assertions: Array<{ assertion: string; pass: boolean; reason: string }>;
  finalScreenshot?: string;
  passed: boolean;
}

export async function writeReport(report: RunReport, outDir: string): Promise<{ jsonPath: string; htmlPath: string }> {
  await mkdir(outDir, { recursive: true });
  const jsonPath = join(outDir, "report.json");
  const htmlPath = join(outDir, "report.html");
  await writeFile(jsonPath, JSON.stringify(report, null, 2));
  await writeFile(htmlPath, renderHtml(report, outDir));
  return { jsonPath, htmlPath };
}

function renderHtml(r: RunReport, outDir: string): string {
  const ok = (b: boolean) => b ? "✓" : "✗";
  const okColor = (b: boolean) => b ? "#16a34a" : "#dc2626";
  const intents = r.intents.map((it, idx) => {
    const stepRows = it.steps.map((s, si) => `
      <tr>
        <td style="color:${okColor(s.ok)}">${ok(s.ok)}</td>
        <td><code>${escapeHtml(JSON.stringify(s.action))}</code></td>
        <td>${escapeHtml(s.detail ?? "")}</td>
      </tr>`).join("");
    const shot = it.screenshotPath ? relative(outDir, it.screenshotPath) : "";
    return `
      <section style="margin-top:24px;border-top:1px solid #e5e7eb;padding-top:16px">
        <h3>Intent ${idx + 1}: ${escapeHtml(it.intent)}</h3>
        <p><strong style="color:${okColor(it.outcome === 'satisfied')}">${it.outcome}</strong>${it.finalReason ? ` — ${escapeHtml(it.finalReason)}` : ""}</p>
        <table style="border-collapse:collapse;width:100%;font-size:12px">
          <thead><tr style="text-align:left;color:#6b7280"><th style="width:24px"></th><th>Action</th><th>Detail</th></tr></thead>
          <tbody>${stepRows || `<tr><td colspan="3" style="color:#9ca3af">no steps</td></tr>`}</tbody>
        </table>
        ${shot ? `<img src="${shot}" alt="screenshot after intent ${idx+1}" style="margin-top:12px;max-width:100%;border:1px solid #e5e7eb;border-radius:8px"/>` : ""}
      </section>`;
  }).join("");

  const assertions = r.assertions.map((a) => `
    <li style="margin:6px 0">
      <span style="color:${okColor(a.pass)};font-weight:600">${ok(a.pass)} ${escapeHtml(a.assertion)}</span>
      <div style="color:#6b7280;font-size:12px;margin-top:2px">${escapeHtml(a.reason)}</div>
    </li>`).join("");

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Luna Orbit · ${escapeHtml(r.plan.name)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; max-width: 1080px; margin: 32px auto; padding: 0 16px; color: #111827 }
  h1 { font-size: 22px; margin: 0 0 4px } h2 { font-size: 16px; margin: 24px 0 8px } h3 { font-size: 15px; margin: 0 0 4px }
  table th, table td { padding: 6px 8px; border-bottom: 1px dashed #e5e7eb; vertical-align: top }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; background: #f3f4f6; padding: 1px 4px; border-radius: 3px }
  .meta { color: #6b7280; font-size: 12px; margin-bottom: 16px }
  .verdict { font-size: 18px; font-weight: 700; padding: 12px 16px; border-radius: 8px; margin-bottom: 24px }
  .pass { background: #dcfce7; color: #166534 } .fail { background: #fee2e2; color: #991b1b }
  ul { padding-left: 18px }
</style></head>
<body>
  <h1>${escapeHtml(r.plan.name)}</h1>
  <div class="meta">
    Target: <code>${escapeHtml(r.plan.target)}</code> ·
    Platform: ${escapeHtml(r.plan.platform)} ·
    ${escapeHtml(r.startedAt)} → ${escapeHtml(r.finishedAt)} (${(r.durationMs / 1000).toFixed(1)}s) ·
    Source: <code>${escapeHtml(basename(r.plan.sourcePath ?? "(inline)"))}</code>
  </div>
  <div class="verdict ${r.passed ? 'pass' : 'fail'}">${r.passed ? '✓ PASS' : '✗ FAIL'}</div>

  <h2>Assertions</h2>
  <ul>${assertions || "<li style=\"color:#9ca3af\">no assertions defined</li>"}</ul>

  <h2>Intent run</h2>
  ${intents}

  ${r.finalScreenshot ? `<h2>Final state</h2><img src="${relative(outDir, r.finalScreenshot)}" style="max-width:100%;border:1px solid #e5e7eb;border-radius:8px"/>` : ""}
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]!));
}
