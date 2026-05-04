/**
 * Luna Orbit HTTP API.
 *
 *   POST /v1/runs                  — start a run; body: { plan_md | plan_path, options? }
 *   GET  /v1/runs                  — list recent runs
 *   GET  /v1/runs/:id              — status + summary
 *   GET  /v1/runs/:id/report.json  — full report JSON
 *   GET  /v1/runs/:id/report.html  — rendered HTML report
 *   GET  /v1/runs/:id/screenshots/:name — serve a screenshot
 *   GET  /healthz                  — liveness
 *   GET  /                         — minimal HTML index of recent runs
 *
 * Auth: Bearer token via Authorization header. Set LUNA_ORBIT_API_KEYS
 * (comma-separated) to require it. If unset, the server is open — fine
 * for local dev, NOT for production.
 *
 * Storage: filesystem at <data-dir> (default ./orbit-data). No DB.
 *
 * Concurrency: Queue caps simultaneous runs. Default 2 — each run spawns
 * a real Chromium / Appium session. Tune via maxConcurrent.
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { runPlanFromString, type RunReport } from "../index.js";
import { authorPlan } from "../author.js";
import { RunRegistry, type RunRecord } from "./runs.js";
import { Queue } from "./queue.js";
import { fireWebhooks } from "./webhooks.js";

export interface ServerOptions {
  port: number;
  dataDir: string;
  maxConcurrent: number;
  /** Comma-separated bearer tokens. If empty, auth is OFF (dev only). */
  apiKeys: string[];
  /** URLs that receive a JSON POST when any run finishes (Slack/Discord/generic). */
  webhookUrls: string[];
  /** Optional shared secret — sent as `x-luna-orbit-signature: sha256=...`. */
  webhookSecret?: string;
}

export function createServer(opts: ServerOptions) {
  const registry = new RunRegistry(opts.dataDir);
  const queue = new Queue(opts.maxConcurrent);
  const app = new Hono();

  // ── Auth middleware ────────────────────────────────────────────────
  app.use("/v1/*", async (c, next) => {
    if (opts.apiKeys.length === 0) return next(); // open mode
    const auth = c.req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!opts.apiKeys.includes(token)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  });

  // ── Health ─────────────────────────────────────────────────────────
  app.get("/healthz", (c) => c.json({
    ok: true,
    in_flight: queue.inFlight,
    queued: queue.queued,
    auth_required: opts.apiKeys.length > 0,
  }));

  // ── Start a run ────────────────────────────────────────────────────
  app.post("/v1/runs", async (c) => {
    let body: { plan_md?: string; plan_path?: string; options?: { headed?: boolean } };
    try { body = await c.req.json(); }
    catch { return c.json({ error: "invalid_json" }, 400); }

    let planMd = body.plan_md;
    if (!planMd && body.plan_path) {
      try { planMd = await readFile(body.plan_path, "utf8"); }
      catch (e) { return c.json({ error: "plan_path_unreadable", detail: (e as Error).message }, 400); }
    }
    if (!planMd) return c.json({ error: "missing_plan", detail: "Provide `plan_md` (markdown content) or `plan_path` (path on the server)" }, 400);

    // Parse just enough to populate the queued record. Full parse happens inside runPlanFromString.
    const nameMatch = planMd.match(/(?:^|\n)name:\s*(.+?)\s*\n/);
    const targetMatch = planMd.match(/(?:^|\n)target:\s*(.+?)\s*\n/);
    const platformMatch = planMd.match(/(?:^|\n)platform:\s*(web|mobile)\s*\n/);

    const id = registry.newRunId();
    const rec: RunRecord = {
      id,
      plan_name: nameMatch?.[1] ?? "(unnamed plan)",
      plan_target: targetMatch?.[1] ?? "",
      plan_platform: (platformMatch?.[1] as "web" | "mobile") ?? "web",
      status: "queued",
      queued_at: new Date().toISOString(),
    };
    await registry.create(rec);
    await writeFile(join(registry.runDir(id), "plan.md"), planMd);

    // Fire-and-forget through the queue. Status updates persist as they happen.
    void queue.run(async () => {
      await registry.update(id, { status: "running", started_at: new Date().toISOString() });
      let final: RunRecord | null = null;
      try {
        const report: RunReport = await runPlanFromString(planMd!, {
          outDir: registry.runDir(id),
          headed: body.options?.headed,
        });
        final = await registry.update(id, {
          status: report.passed ? "passed" : "failed",
          passed: report.passed,
          intents_satisfied: report.intents.filter((it) => it.outcome === "satisfied").length,
          intents_total: report.intents.length,
          assertions_pass: report.assertions.filter((a) => a.pass).length,
          assertions_total: report.assertions.length,
          duration_ms: report.durationMs,
          finished_at: report.finishedAt,
        });
      } catch (e) {
        final = await registry.update(id, {
          status: "errored",
          error: (e as Error).message,
          finished_at: new Date().toISOString(),
        });
      }
      if (final) await fireWebhooks(final, opts.webhookUrls, opts.webhookSecret);
    });

    return c.json({ id, status: "queued" }, 202);
  });

  // ── AI-native: author a plan from a natural-language requirement ───
  // POST /v1/author { target, requirement, platform?, viewport? }
  // Returns the plan markdown synchronously — does NOT execute it.
  app.post("/v1/author", async (c) => {
    let body: { target?: string; requirement?: string; platform?: "web" | "mobile"; viewport?: string; capabilities?: Record<string, unknown>; max_explore_steps?: number };
    try { body = await c.req.json(); }
    catch { return c.json({ error: "invalid_json" }, 400); }
    if (!body.target || !body.requirement) {
      return c.json({ error: "missing_fields", detail: "target and requirement are required" }, 400);
    }
    try {
      const result = await authorPlan({
        target: body.target,
        requirement: body.requirement,
        platform: body.platform,
        viewport: body.viewport,
        capabilities: body.capabilities,
        maxExploreSteps: body.max_explore_steps,
      });
      return c.json({ plan_md: result.planMd, exploration: result.exploration, ended_at: result.endedAt });
    } catch (e) {
      return c.json({ error: "author_failed", detail: (e as Error).message }, 500);
    }
  });

  // ── AI-native one-shot: author + run + report ──────────────────────
  // POST /v1/auto { target, requirement, ... } — same shape as /v1/author
  // Same lifecycle as /v1/runs (queued → running → passed/failed/errored).
  app.post("/v1/auto", async (c) => {
    let body: { target?: string; requirement?: string; platform?: "web" | "mobile"; viewport?: string; capabilities?: Record<string, unknown>; max_explore_steps?: number; options?: { headed?: boolean } };
    try { body = await c.req.json(); }
    catch { return c.json({ error: "invalid_json" }, 400); }
    if (!body.target || !body.requirement) {
      return c.json({ error: "missing_fields", detail: "target and requirement are required" }, 400);
    }

    const id = registry.newRunId();
    const rec: RunRecord = {
      id,
      plan_name: `(authoring) ${body.requirement.slice(0, 80)}`,
      plan_target: body.target,
      plan_platform: body.platform ?? "web",
      status: "queued",
      queued_at: new Date().toISOString(),
    };
    await registry.create(rec);

    void queue.run(async () => {
      await registry.update(id, { status: "running", started_at: new Date().toISOString() });
      let final: RunRecord | null = null;
      try {
        const author = await authorPlan({
          target: body.target!,
          requirement: body.requirement!,
          platform: body.platform,
          viewport: body.viewport,
          capabilities: body.capabilities,
          maxExploreSteps: body.max_explore_steps,
        });
        await writeFile(join(registry.runDir(id), "plan.md"), author.planMd);
        const nameMatch = author.planMd.match(/(?:^|\n)name:\s*(.+?)\s*\n/);
        await registry.update(id, { plan_name: nameMatch?.[1] ?? rec.plan_name });

        const report: RunReport = await runPlanFromString(author.planMd, {
          outDir: registry.runDir(id),
          headed: body.options?.headed,
        });
        final = await registry.update(id, {
          status: report.passed ? "passed" : "failed",
          passed: report.passed,
          intents_satisfied: report.intents.filter((it) => it.outcome === "satisfied").length,
          intents_total: report.intents.length,
          assertions_pass: report.assertions.filter((a) => a.pass).length,
          assertions_total: report.assertions.length,
          duration_ms: report.durationMs,
          finished_at: report.finishedAt,
        });
      } catch (e) {
        final = await registry.update(id, {
          status: "errored",
          error: (e as Error).message,
          finished_at: new Date().toISOString(),
        });
      }
      if (final) await fireWebhooks(final, opts.webhookUrls, opts.webhookSecret);
    });

    return c.json({ id, status: "queued" }, 202);
  });

  // ── List ───────────────────────────────────────────────────────────
  app.get("/v1/runs", (c) => {
    const limit = Number(c.req.query("limit") ?? "50");
    const status = c.req.query("status") as RunRecord["status"] | undefined;
    return c.json({ data: registry.list({ limit, status }) });
  });

  // ── Status ─────────────────────────────────────────────────────────
  app.get("/v1/runs/:id", (c) => {
    const r = registry.get(c.req.param("id"));
    if (!r) return c.json({ error: "not_found" }, 404);
    return c.json(r);
  });

  // ── Report JSON ────────────────────────────────────────────────────
  app.get("/v1/runs/:id/report.json", async (c) => {
    const id = c.req.param("id");
    if (!registry.get(id)) return c.json({ error: "not_found" }, 404);
    try {
      const json = await readFile(join(registry.runDir(id), "report.json"), "utf8");
      return c.body(json, 200, { "content-type": "application/json" });
    } catch {
      return c.json({ error: "not_ready", detail: "report.json not yet written — run still in progress?" }, 409);
    }
  });

  // ── Report HTML ────────────────────────────────────────────────────
  app.get("/v1/runs/:id/report.html", async (c) => {
    const id = c.req.param("id");
    if (!registry.get(id)) return c.text("not found", 404);
    try {
      const html = await readFile(join(registry.runDir(id), "report.html"), "utf8");
      return c.body(html, 200, { "content-type": "text/html; charset=utf-8" });
    } catch {
      return c.text("Report not ready yet.", 409);
    }
  });

  // ── Screenshots ────────────────────────────────────────────────────
  app.get("/v1/runs/:id/screenshots/:name", async (c) => {
    const id = c.req.param("id");
    const name = c.req.param("name").replace(/[^A-Za-z0-9._-]/g, "");
    if (!name || !registry.get(id)) return c.text("not found", 404);
    const path = join(registry.runDir(id), "screenshots", name);
    try {
      const buf = await readFile(path);
      return c.body(buf as unknown as ArrayBuffer, 200, { "content-type": "image/png" });
    } catch { return c.text("not found", 404); }
  });

  // ── Tiny built-in dashboard at "/" — last 50 runs, links to reports ─
  app.get("/", () => {
    const recent = registry.list({ limit: 50 });
    const rows = recent.map((r) => `
      <tr>
        <td><a href="/v1/runs/${r.id}/report.html">${r.id.slice(0, 12)}…</a></td>
        <td>${escape(r.plan_name)}</td>
        <td><span class="s s-${r.status}">${r.status}</span></td>
        <td>${r.intents_satisfied ?? "—"}/${r.intents_total ?? "—"}</td>
        <td>${r.assertions_pass ?? "—"}/${r.assertions_total ?? "—"}</td>
        <td>${r.duration_ms ? (r.duration_ms / 1000).toFixed(1) + "s" : "—"}</td>
        <td><time>${r.queued_at}</time></td>
      </tr>`).join("") || `<tr><td colspan="7" style="color:#9ca3af;text-align:center;padding:24px">No runs yet — POST /v1/runs to kick one off.</td></tr>`;
    return new Response(`<!doctype html><html><head><meta charset="utf-8">
<title>Luna Orbit · runs</title>
<style>
body{font-family:-apple-system,system-ui,sans-serif;max-width:1100px;margin:32px auto;padding:0 16px;color:#111827}
h1{margin:0 0 4px;font-size:22px}.meta{color:#6b7280;font-size:12px;margin-bottom:24px}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{padding:8px 10px;border-bottom:1px solid #e5e7eb;text-align:left}
th{background:#f9fafb;color:#6b7280;font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
.s{padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600}
.s-passed{background:#dcfce7;color:#166534}.s-failed{background:#fee2e2;color:#991b1b}
.s-errored{background:#fef3c7;color:#92400e}.s-running{background:#dbeafe;color:#1e40af}
.s-queued{background:#f3f4f6;color:#6b7280}
a{color:#1e40af;text-decoration:none}a:hover{text-decoration:underline}
</style></head><body>
<h1>Luna Orbit</h1>
<div class="meta">${recent.length} runs · in-flight ${queue.inFlight} · queued ${queue.queued}</div>
<table><thead><tr><th>ID</th><th>Plan</th><th>Status</th><th>Intents</th><th>Asserts</th><th>Time</th><th>Queued at</th></tr></thead>
<tbody>${rows}</tbody></table>
</body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
  });

  return {
    app,
    async start(): Promise<void> {
      await registry.init();
      const _server = serve({ fetch: app.fetch, port: opts.port });
      console.log(`luna-orbit · API listening on http://127.0.0.1:${opts.port}`);
      console.log(`  data dir: ${opts.dataDir}`);
      console.log(`  auth: ${opts.apiKeys.length > 0 ? `${opts.apiKeys.length} key(s) required` : "OPEN (dev mode — set LUNA_ORBIT_API_KEYS for production)"}`);
      console.log(`  max parallel runs: ${opts.maxConcurrent}`);
      void serveStatic; // imported for future static-asset routes; quiets ts-unused
      void _server;
    },
  };
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]!));
}
