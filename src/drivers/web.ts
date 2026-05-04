/**
 * Web driver — wraps Vercel's `agent-browser` CLI. agent-browser maintains a
 * persistent browser session keyed by working directory, so we just shell
 * out to it for each command and parse stdout. We don't link against its
 * internal API (it's a CLI-first tool) which keeps us decoupled from its
 * version bumps.
 */
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Driver, Snapshot, SnapshotElement, Action, ActionResult } from "./types.js";

const BIN = process.env.LUNA_ORBIT_AGENT_BROWSER_BIN
         ?? process.env.QA_PILOT_AGENT_BROWSER_BIN
         ?? "agent-browser";

/** Run `agent-browser <args>` and return stdout (throws on non-zero exit). */
function runAgentBrowser(args: string[], opts: { timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`agent-browser ${args.join(" ")} timed out after ${opts.timeoutMs ?? 30_000}ms`));
    }, opts.timeoutMs ?? 30_000);
    proc.stdout.on("data", (b) => (out += b.toString()));
    proc.stderr.on("data", (b) => (err += b.toString()));
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`agent-browser ${args.join(" ")} exit ${code}\nstderr: ${err.trim()}\nstdout: ${out.trim()}`));
      } else {
        resolve(out);
      }
    });
  });
}

/**
 * Parse a single snapshot line emitted by `agent-browser snapshot -i`.
 * Lines look roughly like:
 *   @e1 [button] "Send for signature"
 *   @e3 [textbox] (name: "email") value: "alice@x.com"
 * We don't try to fully reverse-engineer the format — we just extract the
 * ref + role + a free-form remainder. The LLM gets the raw text too.
 */
/**
 * agent-browser's actual snapshot format (verified against v0.26):
 *   - heading "Nexa AI" [level=1, ref=e3]
 *   - textbox "Ask anything..." [ref=e6]
 *   - button "Ask AI ✨" [ref=e8]
 *   - generic "Setup\n📅" [ref=e10] clickable [cursor:pointer, onclick]
 * Refs are addressed in commands as "@eN" (with the @ prefix).
 */
function parseSnapshotLine(line: string): SnapshotElement | null {
  const refMatch = line.match(/\bref=(e\d+)\b/);
  if (!refMatch || !refMatch[1]) return null;
  const ref = `@${refMatch[1]}`;
  // Role is the first word after the leading "- " bullet.
  const roleMatch = line.match(/^\s*-\s+([a-zA-Z]+)\b/);
  const role = roleMatch?.[1] ?? "element";
  // Accessible name is the first quoted string before the [ref=...] block.
  const beforeBracket = line.split("[")[0] ?? "";
  const nameMatch = beforeBracket.match(/"([^"]+)"/);
  const name = nameMatch?.[1]?.replace(/\s+/g, " ").trim();
  return { ref, role, name, description: line.trim() };
}

export interface WebDriverOptions {
  /** Initial viewport (e.g. "1280x800"). Passed to agent-browser. */
  viewport?: string;
  /** Headed mode = visible browser window (default headless for CI). */
  headed?: boolean;
}

export class WebDriver implements Driver {
  constructor(private opts: WebDriverOptions = {}) {}

  async start(): Promise<void> {
    // agent-browser auto-launches on first command. Nothing to do here,
    // but we surface install errors early.
    try {
      await runAgentBrowser(["--version"], { timeoutMs: 8_000 });
    } catch (e) {
      throw new Error(
        `agent-browser CLI is not available on PATH. Install with \`npm i -g agent-browser && agent-browser install\`. Underlying error: ${(e as Error).message}`,
      );
    }
  }

  async open(url: string): Promise<void> {
    const args = ["open", url];
    if (this.opts.viewport) args.push("--viewport", this.opts.viewport);
    if (this.opts.headed) args.push("--headed");
    await runAgentBrowser(args, { timeoutMs: 60_000 });
  }

  async snapshot(): Promise<Snapshot> {
    const raw = await runAgentBrowser(["snapshot", "-i"], { timeoutMs: 30_000 });
    const elements: SnapshotElement[] = [];
    for (const line of raw.split("\n")) {
      const el = parseSnapshotLine(line);
      if (el) elements.push(el);
    }
    let url: string | undefined;
    let title: string | undefined;
    let bodyText: string | undefined;
    try { url = (await runAgentBrowser(["get", "url"], { timeoutMs: 5_000 })).trim(); } catch { /* ok */ }
    try { title = (await runAgentBrowser(["get", "title"], { timeoutMs: 5_000 })).trim(); } catch { /* ok */ }
    // Many apps render meaningful content (chat threads, status banners) as plain
    // divs without ARIA roles, so they don't show up in the structured snapshot.
    // Include a tail of the body text so the LLM can still see them when checking
    // assertions or detecting "did the response arrive".
    try {
      bodyText = (await runAgentBrowser(["get", "text", "body"], { timeoutMs: 5_000 })).trim();
    } catch { /* ok */ }
    const enrichedRaw = bodyText
      ? `${raw}\n\nPAGE TEXT (truncated):\n${bodyText.slice(-2500)}`
      : raw;
    return { url, title, elements, raw: enrichedRaw };
  }

  async act(a: Action): Promise<ActionResult> {
    try {
      switch (a.type) {
        case "open":      await this.open(a.url); return { ok: true };
        case "click":     await runAgentBrowser(["click", a.ref], { timeoutMs: 15_000 }); return { ok: true };
        case "fill":      await runAgentBrowser(["fill", a.ref, a.text], { timeoutMs: 15_000 }); return { ok: true };
        case "select":    await runAgentBrowser(["select", a.ref, a.option], { timeoutMs: 15_000 }); return { ok: true };
        case "check":     await runAgentBrowser(["check", a.ref], { timeoutMs: 15_000 }); return { ok: true };
        case "press":     await runAgentBrowser(["press", a.key], { timeoutMs: 5_000 }); return { ok: true };
        case "scroll":    await runAgentBrowser(["scroll", a.direction, String(a.pixels ?? 500)], { timeoutMs: 5_000 }); return { ok: true };
        case "wait":      {
          if (a.refOrUrl?.startsWith("@")) await runAgentBrowser(["wait", a.refOrUrl], { timeoutMs: 30_000 });
          else if (a.refOrUrl) await runAgentBrowser(["wait", "--url", a.refOrUrl], { timeoutMs: 30_000 });
          else await runAgentBrowser(["wait", String(a.ms ?? 1500)], { timeoutMs: (a.ms ?? 1500) + 5_000 });
          return { ok: true };
        }
        case "get_text": {
          const t = await runAgentBrowser(["get", "text", a.ref], { timeoutMs: 8_000 });
          return { ok: true, detail: t.trim() };
        }
        case "screenshot": {
          await mkdir(dirname(a.path), { recursive: true });
          const args = ["screenshot", a.path];
          if (a.fullPage) args.push("--full");
          await runAgentBrowser(args, { timeoutMs: 15_000 });
          return { ok: true, detail: a.path };
        }
      }
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }

  async screenshot(filePath: string, fullPage = false): Promise<string> {
    await mkdir(dirname(filePath), { recursive: true });
    const args = ["screenshot", filePath];
    if (fullPage) args.push("--full");
    await runAgentBrowser(args, { timeoutMs: 15_000 });
    return filePath;
  }

  async close(): Promise<void> {
    try { await runAgentBrowser(["close"], { timeoutMs: 8_000 }); } catch { /* ignore */ }
  }
}
