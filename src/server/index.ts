/**
 * Luna Orbit HTTP API + non-engineer dashboard.
 *
 *   Browser-friendly (no auth required for these routes by default — put
 *   the dashboard behind a VPN, Tailscale, or Cloudflare Access if exposing
 *   to the public internet):
 *     GET  /                  — recent runs index, "+ New Run" button
 *     GET  /new               — form: type a target + a plain-English requirement
 *     POST /new               — form handler; redirects to /runs/:id
 *     GET  /runs/:id          — single-run detail page with live screenshot strip
 *
 *   Machine-friendly (auth via Bearer token when LUNA_ORBIT_API_KEYS is set):
 *     POST /v1/runs           — start a run from plan markdown / plan path
 *     POST /v1/auto           — AI-native: target + requirement → write plan + run
 *     POST /v1/author         — write a plan only (no execution); synchronous
 *     GET  /v1/runs           — list recent runs
 *     GET  /v1/runs/:id       — status + summary
 *     GET  /v1/runs/:id/report.json | report.html
 *     GET  /v1/runs/:id/screenshots[/:name]
 *     GET  /healthz
 *
 * Storage: filesystem at <data-dir>. No DB.
 * Concurrency: Queue caps simultaneous runs.
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { runPlanFromString, type EnrichedReport } from "../index.js";
import { parsePlan } from "../plan.js";
import { authorPlan } from "../author.js";
import { parseSchedule, createScheduler } from "../scheduling.js";
import { RunRegistry, type RunRecord } from "./runs.js";
import { Queue } from "./queue.js";
import { fireWebhooks } from "./webhooks.js";

export interface ServerOptions {
  port: number;
  dataDir: string;
  maxConcurrent: number;
  /** Bearer tokens. Empty = open mode (dev only). */
  apiKeys: string[];
  /** URLs that receive a JSON POST when any run finishes. */
  webhookUrls: string[];
  /** Optional shared secret — sent as `x-luna-orbit-signature: sha256=...`. */
  webhookSecret?: string;
  /** Directory of plan markdown files. Plans with `cron:` in frontmatter get auto-scheduled. */
  plansDir?: string;
}

export function createServer(opts: ServerOptions) {
  const registry = new RunRegistry(opts.dataDir);
  const queue = new Queue(opts.maxConcurrent);
  const app = new Hono();

  // ── Helpers (shared by /v1/* routes and the /new form) ─────────────

  type RunOpts = { headed?: boolean };

  function extractFromPlan(planMd: string) {
    const name = planMd.match(/(?:^|\n)name:\s*(.+?)\s*\n/)?.[1];
    const target = planMd.match(/(?:^|\n)target:\s*(.+?)\s*\n/)?.[1];
    const platform = planMd.match(/(?:^|\n)platform:\s*(web|mobile)\s*\n/)?.[1] as "web" | "mobile" | undefined;
    return { name, target, platform };
  }

  /** Queue a run that executes a pre-existing plan. */
  async function enqueueRunFromPlan(planMd: string, runOpts: RunOpts = {}): Promise<string> {
    const meta = extractFromPlan(planMd);
    const id = registry.newRunId();
    await registry.create({
      id,
      plan_name: meta.name ?? "(unnamed plan)",
      plan_target: meta.target ?? "",
      plan_platform: meta.platform ?? "web",
      status: "queued",
      queued_at: new Date().toISOString(),
    });
    await writeFile(join(registry.runDir(id), "plan.md"), planMd);

    void queue.run(async () => {
      await registry.update(id, { status: "running", started_at: new Date().toISOString() });
      let final: RunRecord | null = null;
      let report: EnrichedReport | null = null;
      try {
        report = await runPlanFromString(planMd, {
          outDir: registry.runDir(id),
          headed: runOpts.headed,
        });
        final = await registry.update(id, summariseReport(report));
      } catch (e) {
        final = await registry.update(id, {
          status: "errored",
          error: (e as Error).message,
          finished_at: new Date().toISOString(),
        });
      }
      if (final) await fireWebhooks(final, opts.webhookUrls, opts.webhookSecret, report?.bug_report);
    });

    return id;
  }

  /** Queue an AI-native run — author the plan from a requirement, then execute. */
  async function enqueueAuto(args: {
    target: string;
    requirement: string;
    platform?: "web" | "mobile";
    viewport?: string;
    capabilities?: Record<string, unknown>;
    maxExploreSteps?: number;
  }, runOpts: RunOpts = {}): Promise<string> {
    const id = registry.newRunId();
    await registry.create({
      id,
      plan_name: `(authoring) ${args.requirement.slice(0, 80)}`,
      plan_target: args.target,
      plan_platform: args.platform ?? "web",
      status: "queued",
      queued_at: new Date().toISOString(),
    });

    void queue.run(async () => {
      await registry.update(id, { status: "running", started_at: new Date().toISOString() });
      let final: RunRecord | null = null;
      let report: EnrichedReport | null = null;
      try {
        const author = await authorPlan(args);
        await writeFile(join(registry.runDir(id), "plan.md"), author.planMd);
        const meta = extractFromPlan(author.planMd);
        if (meta.name) await registry.update(id, { plan_name: meta.name });

        report = await runPlanFromString(author.planMd, {
          outDir: registry.runDir(id),
          headed: runOpts.headed,
        });
        final = await registry.update(id, summariseReport(report));
      } catch (e) {
        final = await registry.update(id, {
          status: "errored",
          error: (e as Error).message,
          finished_at: new Date().toISOString(),
        });
      }
      if (final) await fireWebhooks(final, opts.webhookUrls, opts.webhookSecret, report?.bug_report);
    });

    return id;
  }

  function summariseReport(report: EnrichedReport): Partial<RunRecord> {
    return {
      status: report.passed ? "passed" : "failed",
      passed: report.passed,
      intents_satisfied: report.intents.filter((it) => it.outcome === "satisfied").length,
      intents_total: report.intents.length,
      assertions_pass: report.assertions.filter((a) => a.pass).length,
      assertions_total: report.assertions.length,
      duration_ms: report.durationMs,
      finished_at: report.finishedAt,
    };
  }

  // ── Auth middleware (machine API only — dashboard is unauthed) ─────
  app.use("/v1/*", async (c, next) => {
    if (opts.apiKeys.length === 0) return next();
    const auth = c.req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!opts.apiKeys.includes(token)) return c.json({ error: "unauthorized" }, 401);
    return next();
  });

  // ── Health ─────────────────────────────────────────────────────────
  app.get("/healthz", (c) => c.json({
    ok: true, in_flight: queue.inFlight, queued: queue.queued,
    auth_required: opts.apiKeys.length > 0,
  }));

  // ── Machine API ────────────────────────────────────────────────────

  app.post("/v1/runs", async (c) => {
    let body: { plan_md?: string; plan_path?: string; options?: RunOpts };
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
    let planMd = body.plan_md;
    if (!planMd && body.plan_path) {
      try { planMd = await readFile(body.plan_path, "utf8"); }
      catch (e) { return c.json({ error: "plan_path_unreadable", detail: (e as Error).message }, 400); }
    }
    if (!planMd) return c.json({ error: "missing_plan", detail: "Provide `plan_md` or `plan_path`" }, 400);
    const id = await enqueueRunFromPlan(planMd, body.options);
    return c.json({ id, status: "queued" }, 202);
  });

  app.post("/v1/author", async (c) => {
    let body: { target?: string; requirement?: string; platform?: "web" | "mobile"; viewport?: string; capabilities?: Record<string, unknown>; max_explore_steps?: number };
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
    if (!body.target || !body.requirement) return c.json({ error: "missing_fields", detail: "target and requirement are required" }, 400);
    try {
      const r = await authorPlan({
        target: body.target, requirement: body.requirement,
        platform: body.platform, viewport: body.viewport,
        capabilities: body.capabilities, maxExploreSteps: body.max_explore_steps,
      });
      return c.json({ plan_md: r.planMd, exploration: r.exploration, ended_at: r.endedAt });
    } catch (e) { return c.json({ error: "author_failed", detail: (e as Error).message }, 500); }
  });

  app.post("/v1/auto", async (c) => {
    let body: { target?: string; requirement?: string; platform?: "web" | "mobile"; viewport?: string; capabilities?: Record<string, unknown>; max_explore_steps?: number; options?: RunOpts };
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
    if (!body.target || !body.requirement) return c.json({ error: "missing_fields", detail: "target and requirement are required" }, 400);
    const id = await enqueueAuto({
      target: body.target, requirement: body.requirement, platform: body.platform,
      viewport: body.viewport, capabilities: body.capabilities, maxExploreSteps: body.max_explore_steps,
    }, body.options);
    return c.json({ id, status: "queued" }, 202);
  });

  app.get("/v1/runs", (c) => {
    const limit = Number(c.req.query("limit") ?? "50");
    const status = c.req.query("status") as RunRecord["status"] | undefined;
    return c.json({ data: registry.list({ limit, status }) });
  });

  app.get("/v1/runs/:id", (c) => {
    const r = registry.get(c.req.param("id"));
    if (!r) return c.json({ error: "not_found" }, 404);
    return c.json(r);
  });

  app.get("/v1/runs/:id/report.json", async (c) => {
    const id = c.req.param("id");
    if (!registry.get(id)) return c.json({ error: "not_found" }, 404);
    try {
      const json = await readFile(join(registry.runDir(id), "report.json"), "utf8");
      return c.body(json, 200, { "content-type": "application/json" });
    } catch { return c.json({ error: "not_ready" }, 409); }
  });

  app.get("/v1/runs/:id/report.html", async (c) => {
    const id = c.req.param("id");
    if (!registry.get(id)) return c.text("not found", 404);
    try {
      const html = await readFile(join(registry.runDir(id), "report.html"), "utf8");
      return c.body(html, 200, { "content-type": "text/html; charset=utf-8" });
    } catch { return c.text("Report not ready yet.", 409); }
  });

  app.get("/v1/runs/:id/screenshots", async (c) => {
    const id = c.req.param("id");
    if (!registry.get(id)) return c.json({ error: "not_found" }, 404);
    try {
      const names = (await readdir(join(registry.runDir(id), "screenshots"))).filter((n) => n.endsWith(".png")).sort();
      return c.json({ names });
    } catch { return c.json({ names: [] }); }
  });

  app.get("/v1/runs/:id/screenshots/:name", async (c) => {
    const id = c.req.param("id");
    const name = c.req.param("name").replace(/[^A-Za-z0-9._-]/g, "");
    if (!name || !registry.get(id)) return c.text("not found", 404);
    try {
      const buf = await readFile(join(registry.runDir(id), "screenshots", name));
      return c.body(buf as unknown as ArrayBuffer, 200, { "content-type": "image/png" });
    } catch { return c.text("not found", 404); }
  });

  // ── Browser-friendly dashboard ─────────────────────────────────────

  app.get("/", () => {
    const recent = registry.list({ limit: 50 });
    const rows = recent.map((r) => `
      <tr>
        <td><a href="/runs/${r.id}">${r.id.slice(0, 12)}…</a></td>
        <td>${esc(r.plan_name)}</td>
        <td><span class="s s-${r.status}">${r.status}</span></td>
        <td>${r.intents_satisfied ?? "—"}/${r.intents_total ?? "—"}</td>
        <td>${r.assertions_pass ?? "—"}/${r.assertions_total ?? "—"}</td>
        <td>${r.duration_ms ? (r.duration_ms / 1000).toFixed(1) + "s" : "—"}</td>
        <td><time>${r.queued_at}</time></td>
      </tr>`).join("") || `<tr><td colspan="7" class="empty">No runs yet — click <strong>+ New Run</strong> above.</td></tr>`;
    return htmlPage("Luna Orbit · runs", `
      <header class="hdr">
        <div>
          <h1>Luna Orbit</h1>
          <div class="meta">${recent.length} run${recent.length === 1 ? "" : "s"} · in-flight ${queue.inFlight} · queued ${queue.queued}</div>
        </div>
        <a class="btn primary" href="/new">+ New Run</a>
      </header>
      <table>
        <thead><tr><th>ID</th><th>Plan</th><th>Status</th><th>Intents</th><th>Asserts</th><th>Time</th><th>Queued at</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`);
  });

  app.get("/new", () => htmlPage("Luna Orbit · new run", `
    <header class="hdr">
      <h1>New run</h1>
      <a class="btn ghost" href="/">← all runs</a>
    </header>

    <div class="tabs">
      <button class="tab active" data-tab="auto">AI-native (recommended)</button>
      <button class="tab" data-tab="plan">Use existing plan</button>
    </div>

    <form method="POST" action="/new" class="card">
      <input type="hidden" name="mode" id="mode" value="auto"/>

      <div data-pane="auto">
        <label>Target URL <span class="hint">(the website or app you want to test)</span>
          <input type="url" name="target" placeholder="https://your-app.com" required/>
        </label>

        <label>What should we test? <span class="hint">(plain English — Luna writes the test plan)</span>
          <textarea name="requirement" rows="4" placeholder="Verify a logged-out user can search for a product, add it to cart, and reach the checkout page" required></textarea>
        </label>

        <label class="row">
          <span>Platform</span>
          <select name="platform">
            <option value="web">Web (any website / SPA / webapp)</option>
            <option value="mobile">Mobile (Appium — needs a server running)</option>
          </select>
        </label>
      </div>

      <div data-pane="plan" hidden>
        <label>Paste a plan in markdown <span class="hint">(YAML frontmatter + Steps + Assertions)</span>
          <textarea name="plan_md" rows="14" placeholder="---&#10;name: My flow&#10;target: https://example.com&#10;platform: web&#10;---&#10;&#10;## Steps&#10;1. Click &quot;Sign in&quot;&#10;2. ...&#10;&#10;## Assertions&#10;- A welcome message is visible"></textarea>
        </label>
      </div>

      <div class="actions">
        <button type="submit" class="btn primary">Run</button>
        <span class="hint">A real browser opens, Luna explores, then runs. Takes 30s – 2 min.</span>
      </div>
    </form>

    <script>
      const tabs = document.querySelectorAll('.tab');
      const panes = { auto: document.querySelector('[data-pane="auto"]'), plan: document.querySelector('[data-pane="plan"]') };
      const modeInput = document.getElementById('mode');
      tabs.forEach((b) => b.addEventListener('click', (e) => {
        e.preventDefault();
        const mode = b.dataset.tab;
        tabs.forEach((x) => x.classList.toggle('active', x === b));
        Object.entries(panes).forEach(([k, el]) => el.hidden = (k !== mode));
        modeInput.value = mode;
        // toggle required attrs so HTML5 validation doesn't fight the inactive pane
        document.querySelector('[name=target]').required = (mode === 'auto');
        document.querySelector('[name=requirement]').required = (mode === 'auto');
        document.querySelector('[name=plan_md]').required = (mode === 'plan');
      }));
    </script>
  `));

  app.post("/new", async (c) => {
    const form = await c.req.parseBody();
    const mode = String(form.mode ?? "auto");
    try {
      let id: string;
      if (mode === "plan") {
        const planMd = String(form.plan_md ?? "").trim();
        if (!planMd) return c.text("Plan markdown is required.", 400);
        id = await enqueueRunFromPlan(planMd);
      } else {
        const target = String(form.target ?? "").trim();
        const requirement = String(form.requirement ?? "").trim();
        const platform = (String(form.platform ?? "web") as "web" | "mobile");
        if (!target || !requirement) return c.text("Target URL and requirement are required.", 400);
        id = await enqueueAuto({ target, requirement, platform });
      }
      return c.redirect(`/runs/${id}`, 303);
    } catch (e) {
      return c.text("Failed to start run: " + (e as Error).message, 500);
    }
  });

  app.get("/runs/:id", (c) => {
    const id = c.req.param("id");
    const r = registry.get(id);
    if (!r) return c.text("Run not found.", 404);
    // Page is mostly client-side: it polls /v1/runs/:id and /v1/runs/:id/screenshots
    // every 3s while running, then loads the final HTML report in an iframe.
    return htmlPage(`Run ${r.id.slice(0, 12)} · Luna Orbit`, `
      <header class="hdr">
        <div>
          <h1 id="plan-name">${esc(r.plan_name)}</h1>
          <div class="meta"><a href="/">← all runs</a> · <code>${r.id}</code> · <span id="target">${esc(r.plan_target)}</span></div>
        </div>
        <span class="s s-${r.status}" id="status-pill">${r.status}</span>
      </header>

      <div class="card stats" id="stats">
        <div><span class="lbl">intents</span><span class="val" id="stat-intents">${r.intents_satisfied ?? "—"} / ${r.intents_total ?? "—"}</span></div>
        <div><span class="lbl">assertions</span><span class="val" id="stat-asserts">${r.assertions_pass ?? "—"} / ${r.assertions_total ?? "—"}</span></div>
        <div><span class="lbl">duration</span><span class="val" id="stat-dur">${r.duration_ms ? (r.duration_ms / 1000).toFixed(1) + "s" : "—"}</span></div>
        <div><span class="lbl">started</span><span class="val">${r.started_at ?? r.queued_at}</span></div>
      </div>

      <div class="card" id="error-box" hidden>
        <h3 style="margin-top:0;color:#991b1b">Error</h3>
        <pre id="error-text" style="white-space:pre-wrap;font-size:12px;color:#991b1b"></pre>
      </div>

      <h2 style="margin-top:32px">Live screenshots</h2>
      <div class="shots" id="shots"></div>

      <h2 style="margin-top:32px" id="report-h" hidden>Full report</h2>
      <iframe id="report-frame" hidden></iframe>

      <script>
        const id = ${JSON.stringify(r.id)};
        const pill = document.getElementById('status-pill');
        const errorBox = document.getElementById('error-box');
        const errorText = document.getElementById('error-text');
        const shotsEl = document.getElementById('shots');
        const reportH = document.getElementById('report-h');
        const reportFrame = document.getElementById('report-frame');
        const seen = new Set();

        async function tick() {
          try {
            const r = await (await fetch('/v1/runs/' + id)).json();
            pill.textContent = r.status;
            pill.className = 's s-' + r.status;
            document.getElementById('plan-name').textContent = r.plan_name;
            document.getElementById('stat-intents').textContent = (r.intents_satisfied ?? '—') + ' / ' + (r.intents_total ?? '—');
            document.getElementById('stat-asserts').textContent = (r.assertions_pass ?? '—') + ' / ' + (r.assertions_total ?? '—');
            document.getElementById('stat-dur').textContent = r.duration_ms ? (r.duration_ms / 1000).toFixed(1) + 's' : '—';

            if (r.error) {
              errorBox.hidden = false;
              errorText.textContent = r.error;
            }

            // Append any new screenshots
            const list = await (await fetch('/v1/runs/' + id + '/screenshots')).json();
            for (const name of (list.names || [])) {
              if (seen.has(name)) continue;
              seen.add(name);
              const wrap = document.createElement('a');
              wrap.href = '/v1/runs/' + id + '/screenshots/' + name;
              wrap.target = '_blank';
              wrap.className = 'shot';
              wrap.innerHTML = '<img src="' + wrap.href + '" alt="' + name + '"/><span>' + name.replace('.png','') + '</span>';
              shotsEl.appendChild(wrap);
            }

            const done = ['passed', 'failed', 'errored'].includes(r.status);
            if (done) {
              reportH.hidden = false;
              reportFrame.hidden = false;
              reportFrame.src = '/v1/runs/' + id + '/report.html';
            }
            return done;
          } catch (e) {
            console.error(e);
            return false;
          }
        }

        (async function loop() {
          while (true) {
            const done = await tick();
            if (done) break;
            await new Promise((r) => setTimeout(r, 3000));
          }
        })();
      </script>
    `);
  });

  const scheduler = createScheduler();

  /** Scan plansDir for plans with `cron:` in frontmatter and arm them. */
  async function loadScheduledPlans(): Promise<number> {
    if (!opts.plansDir) return 0;
    let armed = 0;
    try {
      const files = (await readdir(opts.plansDir)).filter((n) => n.endsWith(".md"));
      for (const f of files) {
        const path = join(opts.plansDir, f);
        try {
          const md = await readFile(path, "utf8");
          const plan = parsePlan(md, path);
          if (!plan.cron) continue;
          const sched = parseSchedule(plan.cron);
          if (!sched) {
            console.warn(`[scheduler] ${f}: unrecognised cron expression "${plan.cron}" — skipping`);
            continue;
          }
          scheduler.register(`plan:${f}`, sched, async () => {
            console.log(`[scheduler] firing ${f} (${sched.expression})`);
            await enqueueRunFromPlan(md);
          });
          armed++;
        } catch (e) {
          console.warn(`[scheduler] ${f}: ${(e as Error).message} — skipping`);
        }
      }
    } catch (e) {
      console.warn(`[scheduler] could not read plansDir ${opts.plansDir}: ${(e as Error).message}`);
    }
    return armed;
  }

  app.get("/v1/schedule", (c) => c.json({ data: scheduler.list() }));

  return {
    app,
    async start(): Promise<void> {
      await registry.init();
      const armed = await loadScheduledPlans();
      serve({ fetch: app.fetch, port: opts.port });
      console.log(`luna-orbit · listening on http://127.0.0.1:${opts.port}`);
      console.log(`  dashboard:  http://127.0.0.1:${opts.port}/`);
      console.log(`  new run:    http://127.0.0.1:${opts.port}/new`);
      console.log(`  data dir:   ${opts.dataDir}`);
      console.log(`  auth:       ${opts.apiKeys.length > 0 ? `${opts.apiKeys.length} key(s) required for /v1/*` : "OPEN — set LUNA_ORBIT_API_KEYS for production"}`);
      console.log(`  parallel:   ${opts.maxConcurrent}`);
      if (opts.plansDir) {
        console.log(`  scheduler:  ${armed} plan(s) armed from ${opts.plansDir}`);
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Shared HTML chrome — keep style consistent across pages, no JS deps
// ─────────────────────────────────────────────────────────────────────

function htmlPage(title: string, body: string): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *{box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"Inter",system-ui,sans-serif;max-width:1100px;margin:32px auto;padding:0 16px;color:#111827;line-height:1.5}
  h1{margin:0 0 4px;font-size:24px;letter-spacing:-0.01em}
  h2{font-size:15px;font-weight:600;color:#374151;margin:0 0 12px;text-transform:uppercase;letter-spacing:0.05em}
  h3{font-size:14px;font-weight:600;margin:0 0 8px}
  a{color:#1e40af;text-decoration:none} a:hover{text-decoration:underline}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:#f3f4f6;padding:1px 5px;border-radius:3px}
  .meta{color:#6b7280;font-size:13px}
  .hdr{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:24px}
  .btn{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:8px;border:1px solid #d1d5db;font-size:13px;font-weight:500;cursor:pointer;background:white;color:#111827}
  .btn:hover{background:#f9fafb;text-decoration:none}
  .btn.primary{background:#111827;color:white;border-color:#111827}
  .btn.primary:hover{background:#1f2937}
  .btn.ghost{background:transparent;border-color:transparent;color:#6b7280}
  .card{background:white;border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin-bottom:16px}
  .card label{display:block;margin-bottom:14px;font-size:13px;color:#374151;font-weight:500}
  .card .hint{color:#9ca3af;font-weight:400;margin-left:4px}
  .card input[type=url],.card input[type=text],.card textarea,.card select{display:block;margin-top:4px;width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;font-family:inherit;color:#111827}
  .card input:focus,.card textarea:focus,.card select:focus{outline:none;border-color:#1e40af;box-shadow:0 0 0 3px rgba(30,64,175,0.1)}
  .card textarea{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
  .card label.row{display:flex;align-items:center;gap:12px}
  .card label.row select{width:auto;flex:1;margin-top:0}
  .actions{display:flex;align-items:center;gap:14px;margin-top:8px}
  .tabs{display:flex;gap:4px;margin-bottom:0;border-bottom:1px solid #e5e7eb;padding:0 4px}
  .tab{background:transparent;border:none;border-bottom:2px solid transparent;padding:10px 14px;font-size:13px;font-weight:500;color:#6b7280;cursor:pointer;margin-bottom:-1px}
  .tab:hover{color:#111827}
  .tab.active{color:#111827;border-bottom-color:#111827}
  .tabs + .card{border-top-left-radius:0;border-top-right-radius:0;border-top:1px solid #e5e7eb}
  table{border-collapse:collapse;width:100%;font-size:13px;background:white;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden}
  th,td{padding:10px 14px;border-bottom:1px solid #f3f4f6;text-align:left;vertical-align:middle}
  tbody tr:last-child td{border-bottom:none}
  th{background:#f9fafb;color:#6b7280;font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:0.05em}
  td.empty{color:#9ca3af;text-align:center;padding:32px}
  .s{display:inline-block;padding:3px 10px;border-radius:99px;font-size:11px;font-weight:600;letter-spacing:0.02em}
  .s-passed{background:#dcfce7;color:#166534}
  .s-failed{background:#fee2e2;color:#991b1b}
  .s-errored{background:#fef3c7;color:#92400e}
  .s-running{background:#dbeafe;color:#1e40af;animation:pulse 1.6s ease-in-out infinite}
  .s-queued{background:#f3f4f6;color:#6b7280}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.6}}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:24px}
  .stats .lbl{display:block;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px}
  .stats .val{display:block;font-size:18px;font-weight:600;font-variant-numeric:tabular-nums}
  .shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
  .shot{display:block;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;background:white}
  .shot:hover{border-color:#9ca3af;text-decoration:none}
  .shot img{display:block;width:100%;height:auto;background:#f9fafb}
  .shot span{display:block;padding:6px 10px;font-size:11px;color:#6b7280;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  iframe{width:100%;height:80vh;border:1px solid #e5e7eb;border-radius:10px;background:white}
</style></head><body>${body}</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]!));
}
