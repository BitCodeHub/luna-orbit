/**
 * Auth fixtures — saved login state so test plans can skip the login UI.
 *
 *   Engineer (one-time, per app):
 *     luna-orbit login --target https://app.example.com --save fixtures/admin.json
 *     # opens a headed browser, you log in manually, close → cookies dumped
 *
 *   Plan (any number of plans use it):
 *     ---
 *     auth: fixtures/admin.json
 *     target: https://app.example.com/dashboard
 *     ---
 *     ## Steps
 *     1. Click "Settings"   ← starts already-logged-in
 *
 * Fixture format is the same as Playwright's storage state JSON
 * (cookies + localStorage), so you can also reuse Playwright fixtures.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn } from "node:child_process";

export interface AuthFixture {
  cookies?: Array<{ name: string; value: string; domain?: string; path?: string; expires?: number; httpOnly?: boolean; secure?: boolean; sameSite?: string }>;
  origins?: Array<{ origin: string; localStorage?: Array<{ name: string; value: string }> }>;
  /** Captured-at timestamp + the URL the user landed on after login (useful for setting target in a plan). */
  meta?: { captured_at: string; final_url?: string };
}

const BIN = process.env.LUNA_ORBIT_AGENT_BROWSER_BIN
         ?? process.env.QA_PILOT_AGENT_BROWSER_BIN
         ?? "agent-browser";

function runAB(args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const t = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error(`timeout ${timeoutMs}ms`)); }, timeoutMs);
    proc.stdout.on("data", (b) => out += b.toString());
    proc.stderr.on("data", (b) => err += b.toString());
    proc.on("error", (e) => { clearTimeout(t); reject(e); });
    proc.on("close", (code) => {
      clearTimeout(t);
      if (code !== 0) reject(new Error(`agent-browser ${args.join(" ")} → exit ${code}\n${err.slice(-400)}`));
      else resolve(out);
    });
  });
}

/**
 * Open a headed browser at `target`, wait for the user to press Enter at the
 * terminal (after they've logged in), capture cookies + localStorage, write
 * to `outPath`, close.
 */
export async function captureFixture(target: string, outPath: string): Promise<AuthFixture> {
  // Open headed so the user can interact.
  await runAB(["open", target, "--headed"], 30_000);
  process.stderr.write(
    `\n  ──────────────────────────────────────────────────────────────\n` +
    `  A browser opened at ${target}.\n` +
    `  → Log in manually (any 2FA / SSO is fine — your call).\n` +
    `  → When you're past the login wall and on the page you want\n` +
    `    plans to start from, come back here and press ENTER.\n` +
    `  ──────────────────────────────────────────────────────────────\n\n`,
  );
  await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));

  let finalUrl: string | undefined;
  try { finalUrl = (await runAB(["get", "url"], 5_000)).trim(); } catch { /* ok */ }

  // agent-browser's `cookies` command (if available) → JSON. Falls back to a
  // manual document.cookie snapshot if not.
  let cookiesRaw: string;
  try {
    cookiesRaw = await runAB(["cookies"], 8_000);
  } catch {
    // Minimal fallback — just document.cookie. Loses HttpOnly cookies but better than nothing.
    cookiesRaw = await runAB(["evaluate", "document.cookie"], 8_000);
  }

  let cookies: AuthFixture["cookies"] = [];
  try {
    const j = JSON.parse(cookiesRaw);
    if (Array.isArray(j)) cookies = j;
  } catch {
    // Comma-separated `name=value; ...` form.
    cookies = cookiesRaw.split(";").map((kv) => kv.trim()).filter(Boolean).map((kv) => {
      const idx = kv.indexOf("=");
      return { name: kv.slice(0, idx).trim(), value: kv.slice(idx + 1).trim() };
    });
  }

  let localStorage: Array<{ name: string; value: string }> = [];
  try {
    const ls = await runAB(["evaluate", "JSON.stringify(Object.entries(localStorage))"], 5_000);
    const arr = JSON.parse(JSON.parse(ls)) as Array<[string, string]>;
    localStorage = arr.map(([name, value]) => ({ name, value }));
  } catch { /* ok */ }

  const fixture: AuthFixture = {
    cookies,
    origins: finalUrl ? [{ origin: new URL(finalUrl).origin, localStorage }] : undefined,
    meta: { captured_at: new Date().toISOString(), final_url: finalUrl },
  };

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(fixture, null, 2));
  await runAB(["close"], 5_000).catch(() => undefined);
  return fixture;
}

/**
 * Load a fixture and apply it to the current agent-browser session.
 * Called by index.ts before kicking off the run if `plan.auth` is set.
 */
export async function applyFixture(fixturePath: string): Promise<void> {
  const raw = await readFile(fixturePath, "utf8");
  const fix = JSON.parse(raw) as AuthFixture;

  // Set cookies one at a time. Tries `cookies set <json>` then falls back to
  // document.cookie (won't restore HttpOnly cookies — those need browser-API
  // setting which not every agent-browser version exposes).
  for (const c of fix.cookies ?? []) {
    try {
      await runAB(["cookies", "set", JSON.stringify(c)], 5_000);
    } catch {
      const expr = `document.cookie=${JSON.stringify(`${c.name}=${c.value}; path=${c.path ?? "/"}`)}`;
      await runAB(["evaluate", expr], 5_000).catch(() => undefined);
    }
  }
  // Apply localStorage for the captured origin.
  for (const o of fix.origins ?? []) {
    for (const item of o.localStorage ?? []) {
      const expr = `localStorage.setItem(${JSON.stringify(item.name)}, ${JSON.stringify(item.value)})`;
      await runAB(["evaluate", expr], 5_000).catch(() => undefined);
    }
  }
}
