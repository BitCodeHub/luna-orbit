/**
 * Luna Orbit HTTP server (v0.4) — multi-tenant SaaS-ready.
 *
 *   PUBLIC:
 *     GET  /                  — landing (logged-out) or recent runs (logged-in)
 *     GET  /signup, /login    — auth pages
 *     POST /signup, /login    — form handlers
 *     POST /logout            — clear session
 *     GET  /widget.js         — drop-in JS widget (any website)
 *     GET  /healthz           — liveness
 *
 *   AUTHED (session cookie):
 *     GET  /new               — form: target + plain-English requirement
 *     POST /new               — form handler; redirects to /runs/:id
 *     GET  /runs/:id          — live single-run page
 *     GET  /settings          — API keys, plan, usage
 *     POST /settings/api-keys — create new key (returns once)
 *     POST /settings/api-keys/:id/revoke
 *     GET  /onboarding        — first-run wizard (templates + AI guide)
 *
 *   API (Bearer api-key):
 *     POST /v1/runs, /v1/auto, /v1/author
 *     GET  /v1/runs, /v1/runs/:id, /v1/runs/:id/report.{json,html}, /v1/runs/:id/screenshots[/:name]
 *     GET  /v1/schedule
 *
 * Auth precedence on any /v1/* request:
 *   1. `Authorization: Bearer lo_pk_xxxx_yyyy` → maps to a workspace
 *   2. session cookie → maps to user's default workspace
 *   3. else → 401
 *
 * Storage: SQLite at <data-dir>/luna.db + per-run files at <data-dir>/runs/<id>/.
 * Concurrency: Queue caps simultaneous runs (each spawns a real browser).
 */
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { runPlanFromString, type EnrichedReport } from "../index.js";
import { parsePlan } from "../plan.js";
import { authorPlan } from "../author.js";
import { parseSchedule, createScheduler } from "../scheduling.js";
import { RunRegistry, type RunRecord } from "./runs.js";
import { Queue } from "./queue.js";
import { fireWebhooks } from "./webhooks.js";
import { openDb } from "./db.js";
import { SESSION_COOKIE } from "./auth.js";
import {
  createUser, authenticate, createSession, userFromSession, deleteSession,
  getWorkspace, userInWorkspace, listApiKeys, createApiKey, revokeApiKey, workspaceFromApiKey,
  issueAuthToken, consumeAuthToken, markEmailVerified, isEmailVerified, userByEmail, setPassword,
  issueCsrfToken, consumeCsrfToken, tryRecordSignupAttempt,
  type UserRow, type WorkspaceRow,
} from "./users.js";
import { sendEmail } from "./email.js";
import { PLANS, refreshUsage, enforceRunQuota, bumpUsage } from "./billing.js";
import { renderPage, esc } from "./pages.js";
import { renderWidgetJs } from "./widget.js";

export interface ServerOptions {
  port: number;
  dataDir: string;
  maxConcurrent: number;
  /** URLs that receive a JSON POST when any run finishes. */
  webhookUrls: string[];
  webhookSecret?: string;
  /** Plans dir for cron-scheduled monitoring. */
  plansDir?: string;
  /** Public-facing base URL — used by widget snippet + signup confirmation. */
  publicBaseUrl?: string;
}

export function createServer(opts: ServerOptions) {
  const db = openDb(opts.dataDir);
  const registry = new RunRegistry(opts.dataDir, db);
  const queue = new Queue(opts.maxConcurrent);
  const scheduler = createScheduler();
  const app = new Hono();

  // ── Session helper ────────────────────────────────────────────────
  type SessionCtx = { user: UserRow; workspace: WorkspaceRow };

  async function sessionCtxFromCookie(c: Context): Promise<SessionCtx | null> {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) return null;
    const user = userFromSession(db, token);
    if (!user || !user.default_workspace_id) return null;
    const ws = getWorkspace(db, user.default_workspace_id);
    if (!ws) return null;
    return { user, workspace: ws };
  }

  async function sessionCtxFromBearer(c: Context): Promise<{ workspace: WorkspaceRow; userId: string } | null> {
    const auth = c.req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) return null;
    const m = workspaceFromApiKey(db, token);
    if (!m) return null;
    const ws = getWorkspace(db, m.workspaceId);
    if (!ws) return null;
    return { workspace: ws, userId: m.userId };
  }

  // ── Run-creation helpers ──────────────────────────────────────────

  type RunOpts = { headed?: boolean };

  function extractFromPlan(planMd: string) {
    const name = planMd.match(/(?:^|\n)name:\s*(.+?)\s*\n/)?.[1];
    const target = planMd.match(/(?:^|\n)target:\s*(.+?)\s*\n/)?.[1];
    const platform = planMd.match(/(?:^|\n)platform:\s*(web|mobile)\s*\n/)?.[1] as "web" | "mobile" | undefined;
    return { name, target, platform };
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

  async function enqueueRunFromPlan(workspaceId: string, planMd: string, runOpts: RunOpts = {}): Promise<string> {
    const ws = getWorkspace(db, workspaceId);
    if (!ws) throw new Error("workspace not found");
    enforceRunQuota(db, ws);
    bumpUsage(db, workspaceId);

    const meta = extractFromPlan(planMd);
    const id = registry.newRunId();
    await registry.create({
      id, workspace_id: workspaceId,
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
        report = await runPlanFromString(planMd, { outDir: registry.runDir(id), headed: runOpts.headed });
        final = await registry.update(id, summariseReport(report));
      } catch (e) {
        final = await registry.update(id, { status: "errored", error: (e as Error).message, finished_at: new Date().toISOString() });
      }
      if (final) await fireWebhooks(final, opts.webhookUrls, opts.webhookSecret, report?.bug_report);
    });
    return id;
  }

  async function enqueueAuto(workspaceId: string, args: { target: string; requirement: string; platform?: "web" | "mobile"; viewport?: string; capabilities?: Record<string, unknown>; maxExploreSteps?: number }, runOpts: RunOpts = {}): Promise<string> {
    const ws = getWorkspace(db, workspaceId);
    if (!ws) throw new Error("workspace not found");
    enforceRunQuota(db, ws);
    bumpUsage(db, workspaceId);

    const id = registry.newRunId();
    await registry.create({
      id, workspace_id: workspaceId,
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
        report = await runPlanFromString(author.planMd, { outDir: registry.runDir(id), headed: runOpts.headed });
        final = await registry.update(id, summariseReport(report));
      } catch (e) {
        final = await registry.update(id, { status: "errored", error: (e as Error).message, finished_at: new Date().toISOString() });
      }
      if (final) await fireWebhooks(final, opts.webhookUrls, opts.webhookSecret, report?.bug_report);
    });
    return id;
  }

  // ── Auth middleware for /v1/* ─────────────────────────────────────
  app.use("/v1/*", async (c, next) => {
    const fromBearer = await sessionCtxFromBearer(c);
    if (fromBearer) {
      c.set("workspaceId" as never, fromBearer.workspace.id);
      return next();
    }
    const fromCookie = await sessionCtxFromCookie(c);
    if (fromCookie) {
      c.set("workspaceId" as never, fromCookie.workspace.id);
      return next();
    }
    return c.json({ error: "unauthorized", detail: "Provide an `Authorization: Bearer lo_pk_...` header or a valid session cookie." }, 401);
  });

  function wsId(c: Context): string {
    return c.get("workspaceId" as never) as string;
  }

  // ── Health ────────────────────────────────────────────────────────
  app.get("/healthz", (c) => c.json({
    ok: true, in_flight: queue.inFlight, queued: queue.queued,
    plans: Object.keys(PLANS),
  }));

  // ── Public landing + auth pages ───────────────────────────────────
  app.get("/", async (c) => {
    const ctx = await sessionCtxFromCookie(c);
    if (!ctx) {
      return renderPage("Luna Orbit · AI-native regression testing", landingHtml(opts.publicBaseUrl));
    }
    // Logged in → recent runs for this workspace
    const recent = registry.list({ workspaceId: ctx.workspace.id, limit: 50 });
    const usage = refreshUsage(db, ctx.workspace);
    return renderPage(`${ctx.workspace.name} · Luna Orbit`, dashboardHtml(ctx, recent, usage, queue));
  });

  app.get("/signup", () => renderPage("Sign up · Luna Orbit", authPageHtml("signup")));
  app.get("/login", () => renderPage("Log in · Luna Orbit", authPageHtml("login")));

  function clientIp(c: Context): string {
    return c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
        || c.req.header("x-real-ip")
        || "0.0.0.0";
  }

  function makeVerificationLink(rawToken: string): string {
    const base = (opts.publicBaseUrl ?? "").replace(/\/$/, "");
    return `${base}/verify?token=${encodeURIComponent(rawToken)}`;
  }
  function makeResetLink(rawToken: string): string {
    const base = (opts.publicBaseUrl ?? "").replace(/\/$/, "");
    return `${base}/reset?token=${encodeURIComponent(rawToken)}`;
  }

  app.post("/signup", async (c) => {
    const ip = clientIp(c);
    if (!tryRecordSignupAttempt(db, ip)) {
      return renderPage("Sign up · Luna Orbit", authPageHtml("signup", "Too many signups from your network. Try again later."));
    }
    const f = await c.req.parseBody();
    const email = String(f.email ?? "").trim();
    const password = String(f.password ?? "");
    const name = String(f.name ?? "").trim() || undefined;
    try {
      const { user } = await createUser(db, email, password, name);
      // Fire-and-forget the verification email. Self-host = printed to stdout.
      const verifyToken = issueAuthToken(db, user.id, "verify_email");
      void sendEmail({
        to: user.email,
        subject: "Verify your Luna Orbit email",
        text: `Hi ${name ?? "there"},\n\nClick this link to verify your email and finish signup:\n\n${makeVerificationLink(verifyToken)}\n\nThe link expires in 24 hours.`,
      }).catch((e) => console.error("[email] verification send failed:", (e as Error).message));

      const token = createSession(db, user.id, c.req.header("user-agent"));
      setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 30 * 24 * 3600, secure: c.req.header("x-forwarded-proto") === "https" });
      return c.redirect("/onboarding", 303);
    } catch (e) {
      return renderPage("Sign up · Luna Orbit", authPageHtml("signup", (e as Error).message));
    }
  });

  app.post("/login", async (c) => {
    const f = await c.req.parseBody();
    const email = String(f.email ?? "").trim();
    const password = String(f.password ?? "");
    const user = await authenticate(db, email, password);
    if (!user) return renderPage("Log in · Luna Orbit", authPageHtml("login", "Invalid email or password."));
    const token = createSession(db, user.id, c.req.header("user-agent"));
    setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 30 * 24 * 3600, secure: c.req.header("x-forwarded-proto") === "https" });
    return c.redirect("/", 303);
  });

  app.post("/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) deleteSession(db, token);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.redirect("/", 303);
  });

  // ── Email verification ────────────────────────────────────────────
  app.get("/verify", async (c) => {
    const token = c.req.query("token") ?? "";
    const userId = consumeAuthToken(db, token, "verify_email");
    if (!userId) {
      return renderPage("Verify · Luna Orbit", `<header class="hdr"><h1>Link expired or invalid</h1></header><div class="card"><p>This verification link is no longer valid. <a href="/login">Log in</a> and request a new one from your settings.</p></div>`);
    }
    markEmailVerified(db, userId);
    return renderPage("Verified · Luna Orbit", `<header class="hdr"><h1>Email verified ✓</h1></header><div class="card"><p>Your email is verified. You can <a href="/">go to your dashboard</a>.</p></div>`);
  });

  // ── Forgot password ──────────────────────────────────────────────
  app.get("/forgot", () => renderPage("Forgot password · Luna Orbit", forgotPageHtml()));
  app.post("/forgot", async (c) => {
    const f = await c.req.parseBody();
    const email = String(f.email ?? "").trim();
    const user = userByEmail(db, email);
    // Always show the same success page — don't leak whether the email exists.
    if (user) {
      const token = issueAuthToken(db, user.id, "password_reset");
      void sendEmail({
        to: user.email,
        subject: "Reset your Luna Orbit password",
        text: `Click this link to set a new password (valid for 1 hour):\n\n${makeResetLink(token)}\n\nIf you didn't ask for a reset, ignore this email.`,
      }).catch((e) => console.error("[email] reset send failed:", (e as Error).message));
    }
    return renderPage("Forgot password · Luna Orbit", `<header class="hdr"><h1>Check your email</h1></header><div class="card"><p>If an account exists for <strong>${esc(email)}</strong>, a reset link has been sent. The link is valid for 1 hour.</p></div>`);
  });

  // ── Reset password ───────────────────────────────────────────────
  app.get("/reset", (c) => {
    const token = c.req.query("token") ?? "";
    return renderPage("Reset password · Luna Orbit", resetPageHtml(token));
  });
  app.post("/reset", async (c) => {
    const f = await c.req.parseBody();
    const token = String(f.token ?? "");
    const password = String(f.password ?? "");
    const userId = consumeAuthToken(db, token, "password_reset");
    if (!userId) return renderPage("Reset password · Luna Orbit", `<header class="hdr"><h1>Link expired or invalid</h1></header><div class="card"><p>Reset links last 1 hour. <a href="/forgot">Request a new one</a>.</p></div>`);
    try {
      await setPassword(db, userId, password);
    } catch (e) {
      return renderPage("Reset password · Luna Orbit", resetPageHtml(token, (e as Error).message));
    }
    return renderPage("Reset password · Luna Orbit", `<header class="hdr"><h1>Password updated ✓</h1></header><div class="card"><p>You can <a href="/login">log in</a> with your new password.</p></div>`);
  });

  // ── Onboarding (first-run wizard for non-tech users) ──────────────
  app.get("/onboarding", async (c) => {
    const ctx = await sessionCtxFromCookie(c);
    if (!ctx) return c.redirect("/login", 303);
    return renderPage("Welcome · Luna Orbit", onboardingHtml(ctx));
  });

  // ── Authed dashboard pages ────────────────────────────────────────
  function requireSession() {
    return async (c: Context, next: () => Promise<unknown>) => {
      const ctx = await sessionCtxFromCookie(c);
      if (!ctx) return c.redirect("/login", 303);
      c.set("session" as never, ctx);
      return next();
    };
  }

  /**
   * CSRF middleware — applied to authed POST routes that perform
   * state-changing actions on behalf of a user (key management, run
   * creation, logout). The token is one-shot: issued by GET handlers
   * via csrfFor(c), embedded in the form, consumed on POST.
   */
  function requireCsrf() {
    return async (c: Context, next: () => Promise<unknown>) => {
      const sess = getCookie(c, SESSION_COOKIE);
      if (!sess) return c.text("session required", 401);
      const f = await c.req.parseBody();
      const tok = String(f._csrf ?? "");
      if (!consumeCsrfToken(db, sess, tok)) {
        return c.text("CSRF token missing or invalid — refresh the page and try again.", 403);
      }
      // Stash the parsed body so handlers don't have to re-parse.
      c.set("formBody" as never, f);
      return next();
    };
  }

  /** Issue a fresh CSRF token bound to the current session, for embedding in a form. */
  function csrfFor(c: Context): string {
    const sess = getCookie(c, SESSION_COOKIE) ?? "";
    return sess ? issueCsrfToken(db, sess) : "";
  }
  function csrfInput(c: Context): string {
    return `<input type="hidden" name="_csrf" value="${csrfFor(c)}"/>`;
  }

  app.get("/new", requireSession(), async (c) => {
    return renderPage("New run · Luna Orbit", newRunFormHtml(csrfFor(c)));
  });

  app.post("/new", requireSession(), requireCsrf(), async (c) => {
    const ctx = c.get("session" as never) as SessionCtx;
    const f = c.get("formBody" as never) as Record<string, unknown>;
    const mode = String(f.mode ?? "auto");
    try {
      let id: string;
      if (mode === "plan") {
        const planMd = String(f.plan_md ?? "").trim();
        if (!planMd) return c.text("Plan markdown is required.", 400);
        id = await enqueueRunFromPlan(ctx.workspace.id, planMd);
      } else {
        const target = String(f.target ?? "").trim();
        const requirement = String(f.requirement ?? "").trim();
        const platform = (String(f.platform ?? "web") as "web" | "mobile");
        if (!target || !requirement) return c.text("Target URL and requirement are required.", 400);
        id = await enqueueAuto(ctx.workspace.id, { target, requirement, platform });
      }
      return c.redirect(`/runs/${id}`, 303);
    } catch (e) {
      return renderPage("New run · Luna Orbit", `<header class="hdr"><h1>Couldn't start the run</h1><a class="btn ghost" href="/new">← back</a></header><div class="card"><p style="color:#991b1b">${esc((e as Error).message)}</p></div>`);
    }
  });

  app.get("/runs/:id", requireSession(), async (c) => {
    const ctx = c.get("session" as never) as SessionCtx;
    const id = c.req.param("id") ?? "";
    const r = id ? registry.getForWorkspace(id, ctx.workspace.id) : null;
    if (!r) return c.text("Run not found.", 404);
    return renderPage(`Run ${r.id.slice(0, 12)} · Luna Orbit`, runDetailHtml(r));
  });

  app.get("/settings", requireSession(), async (c) => {
    const ctx = c.get("session" as never) as SessionCtx;
    const keys = listApiKeys(db, ctx.workspace.id);
    const usage = refreshUsage(db, ctx.workspace);
    const reveal = c.req.query("reveal");
    const verified = isEmailVerified(db, ctx.user.id);
    return renderPage("Settings · Luna Orbit", settingsHtml(ctx, keys, usage, csrfFor(c), verified, reveal));
  });

  app.post("/settings/api-keys", requireSession(), requireCsrf(), async (c) => {
    const ctx = c.get("session" as never) as SessionCtx;
    const f = c.get("formBody" as never) as Record<string, unknown>;
    const name = String(f.name ?? "").trim() || "Untitled key";
    const planLimit = PLANS[ctx.workspace.plan].api_keys;
    if (planLimit !== -1 && listApiKeys(db, ctx.workspace.id).length >= planLimit) {
      return c.text(`Plan limit reached (${planLimit} keys on ${PLANS[ctx.workspace.plan].display_name}). Upgrade to add more.`, 402);
    }
    const { full } = createApiKey(db, ctx.workspace.id, ctx.user.id, name);
    return c.redirect(`/settings?reveal=${encodeURIComponent(full)}`, 303);
  });

  app.post("/settings/api-keys/:id/revoke", requireSession(), requireCsrf(), async (c) => {
    const ctx = c.get("session" as never) as SessionCtx;
    const id = c.req.param("id");
    if (id) revokeApiKey(db, ctx.workspace.id, id);
    return c.redirect("/settings", 303);
  });

  /** Resend the verification email — for users who lost it. */
  app.post("/settings/resend-verification", requireSession(), requireCsrf(), async (c) => {
    const ctx = c.get("session" as never) as SessionCtx;
    if (isEmailVerified(db, ctx.user.id)) return c.redirect("/settings", 303);
    const tok = issueAuthToken(db, ctx.user.id, "verify_email");
    void sendEmail({
      to: ctx.user.email,
      subject: "Verify your Luna Orbit email",
      text: `Click this link to verify your email (valid 24h):\n\n${makeVerificationLink(tok)}`,
    }).catch((e) => console.error("[email] resend failed:", (e as Error).message));
    return c.redirect("/settings", 303);
  });

  app.get("/upgrade", requireSession(), async (c) => {
    const ctx = c.get("session" as never) as SessionCtx;
    return renderPage("Upgrade · Luna Orbit", upgradeHtml(ctx));
  });

  // ── Embeddable widget ─────────────────────────────────────────────
  app.get("/widget.js", (c) => {
    c.header("content-type", "application/javascript; charset=utf-8");
    c.header("cache-control", "public, max-age=300");
    return c.body(renderWidgetJs(opts.publicBaseUrl ?? ""));
  });

  // ── Machine API (workspace-scoped via Bearer or session) ──────────
  app.post("/v1/runs", async (c) => {
    let body: { plan_md?: string; plan_path?: string; options?: RunOpts };
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
    let planMd = body.plan_md;
    if (!planMd && body.plan_path) {
      try { planMd = await readFile(body.plan_path, "utf8"); }
      catch (e) { return c.json({ error: "plan_path_unreadable", detail: (e as Error).message }, 400); }
    }
    if (!planMd) return c.json({ error: "missing_plan" }, 400);
    try {
      const id = await enqueueRunFromPlan(wsId(c), planMd, body.options);
      return c.json({ id, status: "queued" }, 202);
    } catch (e) { return c.json({ error: "quota_or_workspace", detail: (e as Error).message }, 402); }
  });

  app.post("/v1/author", async (c) => {
    let body: { target?: string; requirement?: string; platform?: "web" | "mobile"; viewport?: string; capabilities?: Record<string, unknown>; max_explore_steps?: number };
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
    if (!body.target || !body.requirement) return c.json({ error: "missing_fields" }, 400);
    try {
      const r = await authorPlan({ target: body.target, requirement: body.requirement, platform: body.platform, viewport: body.viewport, capabilities: body.capabilities, maxExploreSteps: body.max_explore_steps });
      return c.json({ plan_md: r.planMd, exploration: r.exploration, ended_at: r.endedAt });
    } catch (e) { return c.json({ error: "author_failed", detail: (e as Error).message }, 500); }
  });

  app.post("/v1/auto", async (c) => {
    let body: { target?: string; requirement?: string; platform?: "web" | "mobile"; viewport?: string; capabilities?: Record<string, unknown>; max_explore_steps?: number; options?: RunOpts };
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
    if (!body.target || !body.requirement) return c.json({ error: "missing_fields" }, 400);
    try {
      const id = await enqueueAuto(wsId(c), { target: body.target, requirement: body.requirement, platform: body.platform, viewport: body.viewport, capabilities: body.capabilities, maxExploreSteps: body.max_explore_steps }, body.options);
      return c.json({ id, status: "queued" }, 202);
    } catch (e) { return c.json({ error: "quota_or_workspace", detail: (e as Error).message }, 402); }
  });

  app.get("/v1/runs", (c) => {
    const limit = Number(c.req.query("limit") ?? "50");
    const status = c.req.query("status") as RunRecord["status"] | undefined;
    return c.json({ data: registry.list({ workspaceId: wsId(c), limit, status }) });
  });

  app.get("/v1/runs/:id", (c) => {
    const r = registry.getForWorkspace(c.req.param("id"), wsId(c));
    if (!r) return c.json({ error: "not_found" }, 404);
    return c.json(r);
  });

  app.get("/v1/runs/:id/report.json", async (c) => {
    const r = registry.getForWorkspace(c.req.param("id"), wsId(c));
    if (!r) return c.json({ error: "not_found" }, 404);
    try { return c.body(await readFile(join(registry.runDir(r.id), "report.json"), "utf8"), 200, { "content-type": "application/json" }); }
    catch { return c.json({ error: "not_ready" }, 409); }
  });

  app.get("/v1/runs/:id/report.html", async (c) => {
    const r = registry.getForWorkspace(c.req.param("id"), wsId(c));
    if (!r) return c.text("not found", 404);
    try { return c.body(await readFile(join(registry.runDir(r.id), "report.html"), "utf8"), 200, { "content-type": "text/html; charset=utf-8" }); }
    catch { return c.text("Report not ready yet.", 409); }
  });

  app.get("/v1/runs/:id/screenshots", async (c) => {
    const r = registry.getForWorkspace(c.req.param("id"), wsId(c));
    if (!r) return c.json({ error: "not_found" }, 404);
    try {
      const names = (await readdir(join(registry.runDir(r.id), "screenshots"))).filter((n) => n.endsWith(".png")).sort();
      return c.json({ names });
    } catch { return c.json({ names: [] }); }
  });

  app.get("/v1/runs/:id/screenshots/:name", async (c) => {
    const r = registry.getForWorkspace(c.req.param("id"), wsId(c));
    const name = c.req.param("name").replace(/[^A-Za-z0-9._-]/g, "");
    if (!r || !name) return c.text("not found", 404);
    try {
      const buf = await readFile(join(registry.runDir(r.id), "screenshots", name));
      return c.body(buf as unknown as ArrayBuffer, 200, { "content-type": "image/png" });
    } catch { return c.text("not found", 404); }
  });

  app.get("/v1/schedule", (c) => c.json({ data: scheduler.list() }));

  // Same dashboard pages live under both / (logged in) and /runs/:id; we
  // use them above. Need access from the cookie-only browser flow too →
  // they're already wired via requireSession() above.

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
          if (!sched) continue;
          // Scheduled plans run under the FIRST workspace in the DB (system tenancy).
          // For multi-tenant scheduled monitoring with workspace ownership, each plan
          // file would carry a `workspace:` field — v0.5.
          const firstWs = db.prepare("SELECT id FROM workspaces ORDER BY created_at LIMIT 1").get() as { id: string } | undefined;
          if (!firstWs) continue;
          scheduler.register(`plan:${f}`, sched, async () => {
            console.log(`[scheduler] firing ${f} (${sched.expression})`);
            await enqueueRunFromPlan(firstWs.id, md);
          });
          armed++;
        } catch (e) {
          console.warn(`[scheduler] ${f}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      console.warn(`[scheduler] could not read plansDir ${opts.plansDir}: ${(e as Error).message}`);
    }
    return armed;
  }

  return {
    app,
    async start(): Promise<void> {
      await registry.init();
      const armed = await loadScheduledPlans();
      serve({ fetch: app.fetch, port: opts.port });
      console.log(`luna-orbit · v0.4 SaaS server listening on http://127.0.0.1:${opts.port}`);
      console.log(`  landing:    http://127.0.0.1:${opts.port}/`);
      console.log(`  signup:     http://127.0.0.1:${opts.port}/signup`);
      console.log(`  data dir:   ${opts.dataDir}`);
      console.log(`  parallel:   ${opts.maxConcurrent}`);
      if (armed) console.log(`  scheduler:  ${armed} plan(s) armed from ${opts.plansDir}`);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
//  HTML page bodies — kept inline for zero dependencies on a templating
//  engine. esc() is in pages.ts. renderPage() supplies the chrome.
// ─────────────────────────────────────────────────────────────────────

function landingHtml(publicBaseUrl?: string): string {
  return `
    <header class="hdr">
      <h1 style="font-size:32px">Luna Orbit</h1>
      <div>
        <a class="btn ghost" href="/login">Log in</a>
        <a class="btn primary" href="/signup">Sign up free</a>
      </div>
    </header>
    <div class="card" style="padding:40px;text-align:center">
      <h2 style="font-size:22px;color:#111827;text-transform:none;letter-spacing:0;margin-bottom:12px">AI writes your tests. AI runs your tests. You just describe what to check.</h2>
      <p style="color:#374151;font-size:15px;max-width:640px;margin:0 auto 24px">No QA experience. No selectors. No recording. Type a sentence; Luna explores your app, writes a test plan, runs it, and tells you what broke and how to fix it.</p>
      <a class="btn primary" href="/signup" style="font-size:14px;padding:12px 24px">Start free — 100 runs / month</a>
      <p class="meta" style="margin-top:12px">Or run it on your own machine: <code>npm i -g luna-orbit && luna-orbit serve</code></p>
    </div>
    <div class="grid-3" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin-top:32px">
      <div class="card"><h3 style="margin-top:0">AI-native authoring</h3><p style="color:#374151;font-size:13px">Describe what to test in plain English. Luna explores the app and writes the test plan for you.</p></div>
      <div class="card"><h3 style="margin-top:0">Self-healing</h3><p style="color:#374151;font-size:13px">Refs come from the accessibility tree, not CSS. Buttons can be renamed without breaking your tests.</p></div>
      <div class="card"><h3 style="margin-top:0">AI bug reports</h3><p style="color:#374151;font-size:13px">When a test fails, you get a Jira-ready summary: what broke, why, and a suggested fix.</p></div>
    </div>
    ${publicBaseUrl ? `<div class="meta" style="margin-top:32px;text-align:center"><strong>Embed it in your platform:</strong> <code>&lt;script src="${esc(publicBaseUrl)}/widget.js" data-workspace="YOUR_KEY"&gt;&lt;/script&gt;</code></div>` : ""}
  `;
}

function authPageHtml(mode: "signup" | "login", error?: string): string {
  const title = mode === "signup" ? "Create your account" : "Log in";
  const cta = mode === "signup" ? "Sign up" : "Log in";
  const other = mode === "signup"
    ? `<a href="/login">Already have an account? Log in</a>`
    : `<a href="/signup">Don't have an account? Sign up free</a> · <a href="/forgot">Forgot password?</a>`;
  return `
    <header class="hdr"><a href="/" style="text-decoration:none;color:inherit"><h1>Luna Orbit</h1></a></header>
    <div class="card" style="max-width:420px;margin:0 auto">
      <h2 style="margin-top:0;text-transform:none;font-size:18px;color:#111827;letter-spacing:0">${title}</h2>
      ${error ? `<div style="background:#fee2e2;color:#991b1b;padding:10px 12px;border-radius:6px;font-size:13px;margin-bottom:14px">${esc(error)}</div>` : ""}
      <form method="POST" action="/${mode}">
        ${mode === "signup" ? `<label>Name <span class="hint">(optional)</span><input type="text" name="name" autocomplete="name"/></label>` : ""}
        <label>Email <input type="email" name="email" required autocomplete="email"/></label>
        <label>Password ${mode === "signup" ? `<span class="hint">(8+ characters)</span>` : ""}<input type="password" name="password" required minlength="8" autocomplete="${mode === "signup" ? "new-password" : "current-password"}"/></label>
        <button type="submit" class="btn primary" style="width:100%;justify-content:center;margin-top:8px">${cta}</button>
      </form>
      <p style="margin:18px 0 0;text-align:center;font-size:13px">${other}</p>
    </div>
  `;
}

function forgotPageHtml(): string {
  return `
    <header class="hdr"><a href="/" style="text-decoration:none;color:inherit"><h1>Luna Orbit</h1></a></header>
    <div class="card" style="max-width:420px;margin:0 auto">
      <h2 style="margin-top:0;text-transform:none;font-size:18px;color:#111827;letter-spacing:0">Forgot your password?</h2>
      <p style="font-size:13px;color:#6b7280;margin-top:0">Enter your email — we'll send a reset link valid for 1 hour.</p>
      <form method="POST" action="/forgot">
        <label>Email<input type="email" name="email" required autocomplete="email"/></label>
        <button type="submit" class="btn primary" style="width:100%;justify-content:center">Send reset link</button>
      </form>
      <p style="margin:18px 0 0;text-align:center;font-size:13px"><a href="/login">← back to log in</a></p>
    </div>
  `;
}

function resetPageHtml(token: string, error?: string): string {
  return `
    <header class="hdr"><a href="/" style="text-decoration:none;color:inherit"><h1>Luna Orbit</h1></a></header>
    <div class="card" style="max-width:420px;margin:0 auto">
      <h2 style="margin-top:0;text-transform:none;font-size:18px;color:#111827;letter-spacing:0">Set a new password</h2>
      ${error ? `<div style="background:#fee2e2;color:#991b1b;padding:10px 12px;border-radius:6px;font-size:13px;margin-bottom:14px">${esc(error)}</div>` : ""}
      <form method="POST" action="/reset">
        <input type="hidden" name="token" value="${esc(token)}"/>
        <label>New password <span class="hint">(8+ characters)</span><input type="password" name="password" required minlength="8" autocomplete="new-password" autofocus/></label>
        <button type="submit" class="btn primary" style="width:100%;justify-content:center">Set password</button>
      </form>
    </div>
  `;
}

function dashboardHtml(ctx: { user: UserRow; workspace: WorkspaceRow }, recent: RunRecord[], usage: { used: number; limit: number }, queue: { inFlight: number; queued: number }): string {
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
  const usageBar = usage.limit === -1 ? "unlimited" : `${usage.used} / ${usage.limit}`;
  const userMenuName = esc(ctx.user.name ?? ctx.user.email);
  return `
    <header class="hdr">
      <div>
        <h1>${esc(ctx.workspace.name)}</h1>
        <div class="meta">${recent.length} run${recent.length === 1 ? "" : "s"} · in-flight ${queue.inFlight} · queued ${queue.queued} · usage ${usageBar} this month · plan <strong>${esc(PLANS[ctx.workspace.plan].display_name)}</strong></div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <a class="btn ghost" href="/settings">${userMenuName}</a>
        <a class="btn primary" href="/new">+ New Run</a>
      </div>
    </header>
    <table>
      <thead><tr><th>ID</th><th>Plan</th><th>Status</th><th>Intents</th><th>Asserts</th><th>Time</th><th>Queued at</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function newRunFormHtml(csrf: string): string {
  return `
    <header class="hdr"><h1>New run</h1><a class="btn ghost" href="/">← all runs</a></header>
    <div class="tabs">
      <button class="tab active" data-tab="auto">AI-native (recommended)</button>
      <button class="tab" data-tab="plan">Use existing plan</button>
    </div>
    <form method="POST" action="/new" class="card">
      <input type="hidden" name="_csrf" value="${esc(csrf)}"/>
      <input type="hidden" name="mode" id="mode" value="auto"/>
      <div data-pane="auto">
        <label>Target URL <span class="hint">(the website you want to test)</span><input type="url" name="target" placeholder="https://your-app.com" required/></label>
        <label>What should we test? <span class="hint">(plain English — Luna writes the test plan)</span><textarea name="requirement" rows="4" placeholder="Verify a logged-out user can search for a product, add it to cart, and reach the checkout page" required></textarea></label>
        <label class="row"><span>Platform</span><select name="platform"><option value="web">Web</option><option value="mobile">Mobile (Appium)</option></select></label>
      </div>
      <div data-pane="plan" hidden>
        <label>Paste a plan in markdown<textarea name="plan_md" rows="14" placeholder="---&#10;name: My flow&#10;target: https://example.com&#10;platform: web&#10;---&#10;## Steps&#10;1. ..."></textarea></label>
      </div>
      <div class="actions"><button type="submit" class="btn primary">Run</button><span class="hint">A real browser opens, Luna explores, then runs. Takes 30s – 2 min.</span></div>
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
        document.querySelector('[name=target]').required = (mode === 'auto');
        document.querySelector('[name=requirement]').required = (mode === 'auto');
        document.querySelector('[name=plan_md]').required = (mode === 'plan');
      }));
    </script>
  `;
}

function runDetailHtml(r: RunRecord): string {
  return `
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
    <div class="card" id="error-box" hidden><h3 style="margin-top:0;color:#991b1b">Error</h3><pre id="error-text" style="white-space:pre-wrap;font-size:12px;color:#991b1b"></pre></div>
    <h2 style="margin-top:32px">Live screenshots</h2>
    <div class="shots" id="shots"></div>
    <h2 style="margin-top:32px" id="report-h" hidden>Full report</h2>
    <iframe id="report-frame" hidden></iframe>
    <script>
      const id = ${JSON.stringify(r.id)};
      const seen = new Set();
      const pill = document.getElementById('status-pill');
      const errorBox = document.getElementById('error-box');
      const errorText = document.getElementById('error-text');
      const shotsEl = document.getElementById('shots');
      const reportH = document.getElementById('report-h');
      const reportFrame = document.getElementById('report-frame');
      async function tick() {
        try {
          const r = await (await fetch('/v1/runs/' + id, { credentials: 'include' })).json();
          pill.textContent = r.status; pill.className = 's s-' + r.status;
          document.getElementById('plan-name').textContent = r.plan_name;
          document.getElementById('stat-intents').textContent = (r.intents_satisfied ?? '—') + ' / ' + (r.intents_total ?? '—');
          document.getElementById('stat-asserts').textContent = (r.assertions_pass ?? '—') + ' / ' + (r.assertions_total ?? '—');
          document.getElementById('stat-dur').textContent = r.duration_ms ? (r.duration_ms / 1000).toFixed(1) + 's' : '—';
          if (r.error) { errorBox.hidden = false; errorText.textContent = r.error; }
          const list = await (await fetch('/v1/runs/' + id + '/screenshots', { credentials: 'include' })).json();
          for (const name of (list.names || [])) {
            if (seen.has(name)) continue; seen.add(name);
            const wrap = document.createElement('a');
            wrap.href = '/v1/runs/' + id + '/screenshots/' + name; wrap.target = '_blank'; wrap.className = 'shot';
            wrap.innerHTML = '<img src="' + wrap.href + '" alt="' + name + '"/><span>' + name.replace('.png','') + '</span>';
            shotsEl.appendChild(wrap);
          }
          const done = ['passed', 'failed', 'errored'].includes(r.status);
          if (done) { reportH.hidden = false; reportFrame.hidden = false; reportFrame.src = '/v1/runs/' + id + '/report.html'; }
          return done;
        } catch (e) { console.error(e); return false; }
      }
      (async function loop() { while (true) { const done = await tick(); if (done) break; await new Promise((r) => setTimeout(r, 3000)); } })();
    </script>
  `;
}

function settingsHtml(ctx: { user: UserRow; workspace: WorkspaceRow }, keys: Array<{ id: string; name: string; created_at: string; last_used_at: string | null }>, usage: { used: number; limit: number }, csrf: string, verified: boolean, reveal?: string): string {
  const keyRows = keys.map((k) => `
    <tr>
      <td><code>${esc(k.id)}</code></td>
      <td>${esc(k.name)}</td>
      <td>${k.last_used_at ?? "<span class=\"meta\">never</span>"}</td>
      <td>${k.created_at.slice(0, 10)}</td>
      <td><form method="POST" action="/settings/api-keys/${esc(k.id)}/revoke" onsubmit="return confirm('Revoke this key? Anything using it stops working.')"><input type="hidden" name="_csrf" value="${esc(csrf)}"/><button type="submit" class="btn ghost" style="color:#991b1b">Revoke</button></form></td>
    </tr>`).join("") || `<tr><td colspan="5" class="empty">No API keys yet.</td></tr>`;
  return `
    <header class="hdr">
      <div><h1>Settings</h1><div class="meta"><a href="/">← all runs</a> · ${esc(ctx.user.email)}</div></div>
      <form method="POST" action="/logout"><button class="btn ghost" type="submit">Log out</button></form>
    </header>

    ${!verified ? `<div class="card" style="background:#fef3c7;border-color:#fbbf24">
      <h3 style="margin-top:0;color:#92400e">Verify your email</h3>
      <p style="font-size:13px;margin:0 0 12px">We sent a verification link to <strong>${esc(ctx.user.email)}</strong>. Click it to confirm your address.</p>
      <form method="POST" action="/settings/resend-verification" style="display:inline">
        <input type="hidden" name="_csrf" value="${esc(csrf)}"/>
        <button class="btn" type="submit">Resend verification email</button>
      </form>
    </div>` : ""}

    ${reveal ? `<div class="card" style="background:#dcfce7;border-color:#86efac">
      <h3 style="margin-top:0;color:#166534">Your new API key — copy it now, it won't be shown again</h3>
      <code style="display:block;background:white;padding:10px;border-radius:6px;font-size:13px;word-break:break-all">${esc(reveal)}</code>
    </div>` : ""}

    <div class="card">
      <h3 style="margin-top:0">Plan & usage</h3>
      <p style="font-size:14px">You are on the <strong>${esc(PLANS[ctx.workspace.plan].display_name)}</strong> plan. ${usage.limit === -1 ? "Unlimited runs." : `Used <strong>${usage.used}</strong> of <strong>${usage.limit}</strong> runs this month.`}</p>
      ${ctx.workspace.plan === "free" ? `<a class="btn primary" href="/upgrade">Upgrade →</a>` : ""}
    </div>

    <div class="card">
      <h3 style="margin-top:0">API keys</h3>
      <p style="font-size:13px;color:#6b7280;margin-top:0">Use these to trigger runs from CI or your own services. Each key has access to <strong>all</strong> data in this workspace.</p>
      <form method="POST" action="/settings/api-keys" style="display:flex;gap:8px;margin-bottom:16px">
        <input type="hidden" name="_csrf" value="${esc(csrf)}"/>
        <input type="text" name="name" placeholder="key name (e.g. 'CI', 'GitHub Actions')" style="flex:1;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px"/>
        <button type="submit" class="btn primary">+ Generate key</button>
      </form>
      <table>
        <thead><tr><th>ID prefix</th><th>Name</th><th>Last used</th><th>Created</th><th></th></tr></thead>
        <tbody>${keyRows}</tbody>
      </table>
    </div>

    <div class="card">
      <h3 style="margin-top:0">Embed Luna Orbit in your own platform</h3>
      <p style="font-size:13px;color:#6b7280">Drop this script into any HTML page. A "Luna Orbit" button appears in the corner; clicking opens a drawer where users can run AI-powered regression tests against the current page.</p>
      <code style="display:block;background:#f3f4f6;padding:10px;border-radius:6px;font-size:12px;word-break:break-all">&lt;script src="/widget.js" data-key="<i>YOUR_API_KEY</i>"&gt;&lt;/script&gt;</code>
      <p style="margin-top:8px;font-size:12px;color:#6b7280">Replace <code>YOUR_API_KEY</code> with one from the table above. The widget posts to <code>/v1/auto</code> with that key.</p>
    </div>
  `;
}

function upgradeHtml(ctx: { workspace: WorkspaceRow }): string {
  const cards = (Object.entries(PLANS) as Array<[keyof typeof PLANS, typeof PLANS[keyof typeof PLANS]]>).map(([k, p]) => {
    const isCurrent = ctx.workspace.plan === k;
    const price = p.monthly_price_usd === -1 ? "Talk to us" : p.monthly_price_usd === 0 ? "Free" : `$${p.monthly_price_usd}/mo`;
    return `
      <div class="card" style="${isCurrent ? "border-color:#1e40af;border-width:2px" : ""}">
        <h3 style="margin-top:0">${esc(p.display_name)}${isCurrent ? " <span class=\"s s-running\" style=\"font-size:10px;margin-left:6px\">current</span>" : ""}</h3>
        <p style="font-size:24px;font-weight:600;margin:0 0 12px">${price}</p>
        <ul style="font-size:13px;color:#374151;padding-left:18px;margin:0 0 16px">
          <li>${p.monthly_runs === -1 ? "Unlimited" : p.monthly_runs.toLocaleString()} runs / month</li>
          <li>${p.parallel_runs} parallel run${p.parallel_runs === 1 ? "" : "s"}</li>
          <li>${p.retention_days} day report retention</li>
          <li>${p.max_team_members === -1 ? "Unlimited" : p.max_team_members} team member${p.max_team_members === 1 ? "" : "s"}</li>
          <li>${p.api_keys === -1 ? "Unlimited" : p.api_keys} API key${p.api_keys === 1 ? "" : "s"}</li>
        </ul>
        ${isCurrent ? "" : `<a class="btn primary" style="width:100%;justify-content:center" href="mailto:hello@lumenai.solutions?subject=Upgrade to ${esc(p.display_name)}&body=Workspace: ${esc(ctx.workspace.id)}">Contact sales</a>`}
      </div>`;
  }).join("");
  return `
    <header class="hdr"><h1>Upgrade</h1><a class="btn ghost" href="/settings">← settings</a></header>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px">${cards}</div>
    <p class="meta" style="margin-top:24px;text-align:center">Stripe self-serve checkout coming in v0.5. For now, contact us to upgrade — we'll switch your workspace plan within the day.</p>
  `;
}

function onboardingHtml(ctx: { user: UserRow; workspace: WorkspaceRow }): string {
  const templates = [
    { id: "smoke", icon: "🔥", title: "Smoke test", desc: "Verify the homepage loads and the main CTA is visible.", req: "Verify the homepage loads and the primary call-to-action button is visible and clickable." },
    { id: "signup", icon: "📝", title: "Signup flow", desc: "New user can create an account.", req: "Verify a new visitor can find the signup link, fill in email and password, submit, and reach a logged-in state or confirmation screen." },
    { id: "search", icon: "🔍", title: "Search", desc: "Search returns relevant results.", req: "Verify that the search box accepts a query, submits, and shows at least one result on the results page." },
    { id: "checkout", icon: "🛒", title: "Checkout", desc: "Logged-out user can add an item to cart and reach checkout.", req: "Verify a logged-out user can find a product, add it to their cart, open the cart, and reach the checkout page." },
    { id: "navigation", icon: "🧭", title: "Site navigation", desc: "Top-nav links resolve to a working page.", req: "Verify each link in the top navigation menu opens a page that loads successfully without errors." },
  ];
  return `
    <header class="hdr">
      <div><h1>Welcome to Luna Orbit, ${esc(ctx.user.name?.split(" ")[0] ?? ctx.user.email.split("@")[0]!)} 👋</h1><div class="meta">Let's run your first test in 30 seconds.</div></div>
      <a class="btn ghost" href="/">Skip → dashboard</a>
    </header>
    <div class="card">
      <h3 style="margin-top:0">Pick a template — or just describe what you want to test</h3>
      <p style="font-size:13px;color:#6b7280;margin-top:0">No QA experience needed. Pick any template, paste your URL, and Luna writes + runs the test plan for you.</p>
      <form method="POST" action="/new">
        <input type="hidden" name="mode" value="auto"/>
        <input type="hidden" name="platform" value="web"/>
        <label>Your app's URL<input type="url" name="target" placeholder="https://your-app.com" required autofocus/></label>
        <label>What should we test?<textarea name="requirement" id="req" rows="3" required></textarea></label>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px;margin-bottom:16px">
          ${templates.map((t) => `
            <button type="button" class="tpl-btn" data-req="${esc(t.req)}" style="text-align:left;padding:12px;background:white;border:1px solid #d1d5db;border-radius:8px;cursor:pointer;font-family:inherit">
              <div style="font-size:18px;margin-bottom:4px">${t.icon} <strong>${esc(t.title)}</strong></div>
              <div style="font-size:12px;color:#6b7280">${esc(t.desc)}</div>
            </button>
          `).join("")}
        </div>
        <button type="submit" class="btn primary" style="width:100%;justify-content:center;font-size:14px;padding:12px">Run my first test →</button>
      </form>
    </div>
    <script>
      const reqEl = document.getElementById('req');
      document.querySelectorAll('.tpl-btn').forEach((b) => b.addEventListener('click', () => {
        reqEl.value = b.dataset.req;
        reqEl.style.borderColor = '#1e40af';
        b.style.borderColor = '#1e40af'; b.style.background = '#eff6ff';
      }));
    </script>
  `;
}
