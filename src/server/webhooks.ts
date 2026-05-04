/**
 * Outbound webhooks — fire-and-forget POST to one or more URLs when a run
 * finishes. Per the competitive scan, OSS testing tools that ship outbound
 * webhooks (Slack / Discord / GitHub Checks / Jira / generic JSON) get
 * adopted; inbound trigger APIs are SaaS table-stakes only.
 *
 * Configure via env:
 *   LUNA_ORBIT_WEBHOOKS=https://hooks.slack.com/...,https://example.com/ci/luna
 *   LUNA_ORBIT_WEBHOOK_SECRET=optional-shared-secret
 *
 * The payload is the same for every URL — adapters live on the receiving
 * side. For Slack incoming webhooks we detect the URL and reshape into
 * the `{text: ...}` envelope Slack expects.
 *
 * Failures are logged and swallowed — a flaky webhook receiver shouldn't
 * fail the test run.
 */
import { createHmac } from "node:crypto";
import type { RunRecord } from "./runs.js";

export interface WebhookPayload {
  event: "run.completed";
  run: RunRecord;
  /** Convenience: pre-rendered one-liner suitable for Slack/Discord. */
  summary: string;
  /** ISO timestamp this webhook was emitted (not when the run finished). */
  emitted_at: string;
}

export function buildSummary(r: RunRecord): string {
  const verdict = r.passed ? "PASS" : r.status === "errored" ? "ERROR" : "FAIL";
  const marker = r.passed ? "✓" : "✗";
  const intents = (r.intents_total ?? 0) > 0 ? `intents ${r.intents_satisfied ?? 0}/${r.intents_total}` : "";
  const asserts = (r.assertions_total ?? 0) > 0 ? `assertions ${r.assertions_pass ?? 0}/${r.assertions_total}` : "";
  const dur = r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : "";
  const bits = [intents, asserts, dur].filter(Boolean).join(" · ");
  return `${marker} ${verdict} — ${r.plan_name}${bits ? " · " + bits : ""}`;
}

function isSlackUrl(u: string): boolean {
  return /hooks\.slack\.com\/services\//i.test(u);
}
function isDiscordUrl(u: string): boolean {
  return /discord(?:app)?\.com\/api\/webhooks\//i.test(u);
}

function shapeFor(url: string, payload: WebhookPayload): unknown {
  if (isSlackUrl(url)) {
    return { text: payload.summary, blocks: [{ type: "section", text: { type: "mrkdwn", text: `*Luna Orbit*  ${payload.summary}` } }] };
  }
  if (isDiscordUrl(url)) {
    return { content: `**Luna Orbit** ${payload.summary}` };
  }
  return payload;
}

export async function fireWebhooks(rec: RunRecord, urls: string[], secret?: string): Promise<void> {
  if (urls.length === 0) return;
  const payload: WebhookPayload = {
    event: "run.completed",
    run: rec,
    summary: buildSummary(rec),
    emitted_at: new Date().toISOString(),
  };
  await Promise.allSettled(urls.map(async (url) => {
    try {
      const body = JSON.stringify(shapeFor(url, payload));
      const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "luna-orbit/0.1" };
      if (secret) {
        headers["x-luna-orbit-signature"] = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
      }
      const r = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(8_000) });
      if (!r.ok) console.error(`[webhook] ${url} → HTTP ${r.status}`);
    } catch (e) {
      console.error(`[webhook] ${url} failed: ${(e as Error).message}`);
    }
  }));
}
