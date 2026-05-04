/**
 * Mobile driver — two modes:
 *
 *   1. "appium" mode (DEFAULT, generic): WebDriverIO talks to a local Appium
 *      server (default http://127.0.0.1:4723). Works with any iOS or Android
 *      app. Snapshot returns the active screen's page-source as a structured
 *      element list keyed by Appium element ids; refs map 1:1.
 *
 *   2. "hma" mode (Lumen-specific): shells to the existing Python Appium
 *      suite at ~/Code/hma_automation. Reuses brand-specific page objects
 *      (Hyundai/Genesis) and YAML locators. Plan steps reference page-object
 *      methods directly — `Page.method`. Best when you already have a
 *      hand-curated POM and just want the LLM to stitch flows.
 *
 * The agent loop doesn't care which mode is in use — both expose the same
 * Driver interface.
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { remote, type Browser } from "webdriverio";
import type { Driver, Snapshot, SnapshotElement, Action, ActionResult } from "./types.js";

const HMA_DIR = process.env.LUNA_ORBIT_HMA_DIR ?? process.env.QA_PILOT_HMA_DIR ?? `${process.env.HOME}/Code/hma_automation`;
const HMA_PYTHON = process.env.LUNA_ORBIT_HMA_PYTHON ?? process.env.QA_PILOT_HMA_PYTHON ?? `${HMA_DIR}/.venv/bin/python`;
const APPIUM_URL = process.env.LUNA_ORBIT_APPIUM_URL ?? "http://127.0.0.1:4723";

export interface MobileDriverOptions {
  /** "appium" = generic (any app); "hma" = Hyundai/Genesis page-object suite. Default "appium". */
  mode?: "appium" | "hma";
  /** Capabilities object passed to Appium when mode = "appium". Required for appium mode. */
  capabilities?: Record<string, unknown>;
  /** When mode = "hma", which entry point. */
  hmaEntry?: string;
  hmaArgs?: string[];
}

function runPython(args: string[], cwd: string, timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(HMA_PYTHON, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const t = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error(`python timed out after ${timeoutMs}ms`)); }, timeoutMs);
    proc.stdout.on("data", (b) => out += b.toString());
    proc.stderr.on("data", (b) => err += b.toString());
    proc.on("error", (e) => { clearTimeout(t); reject(e); });
    proc.on("close", (code) => {
      clearTimeout(t);
      if (code !== 0) reject(new Error(`python exit ${code}\nstderr: ${err.trim().slice(-500)}`));
      else resolve(out);
    });
  });
}

export class MobileDriver implements Driver {
  private browser: Browser | null = null;
  /** Per-snapshot map: ref → underlying Appium element-id, set by snapshot(). */
  private refMap = new Map<string, string>();
  private mode: "appium" | "hma";

  constructor(private opts: MobileDriverOptions = {}) {
    this.mode = opts.mode ?? "appium";
  }

  async start(): Promise<void> {
    if (this.mode === "hma") {
      try {
        await runPython(["-c", "import appium; print(appium.__version__)"], HMA_DIR, 10_000);
      } catch (e) {
        throw new Error(
          `hma_automation Python venv missing or broken at ${HMA_PYTHON}. Set up: cd ${HMA_DIR} && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt. Underlying: ${(e as Error).message}`,
        );
      }
      return;
    }
    // appium mode — connect via WebDriverIO. Appium server must be running.
    if (!this.opts.capabilities) {
      throw new Error(
        "Appium mode needs `capabilities` set in the plan frontmatter (or constructor opts). Example for Android: {platformName: 'Android', 'appium:automationName': 'UiAutomator2', 'appium:app': '/path/to/app.apk'}.",
      );
    }
    const url = new URL(APPIUM_URL);
    this.browser = await remote({
      hostname: url.hostname,
      port: Number(url.port) || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`,
      protocol: url.protocol.replace(":", "") as "http" | "https",
      capabilities: this.opts.capabilities,
      logLevel: "warn",
    });
  }

  async open(target: string): Promise<void> {
    if (this.mode === "hma") return; // hma entry-point already launches the app
    if (!this.browser) throw new Error("Appium browser not started — call start() first");
    // For mobile, "target" is an optional deep-link / activity hint. If it
    // looks like a URL, navigate (browsers + WebViews); otherwise no-op.
    if (/^https?:\/\//.test(target)) {
      await this.browser.url(target);
    }
  }

  async snapshot(): Promise<Snapshot> {
    if (this.mode === "hma") {
      return {
        url: `hma:${this.opts.hmaEntry ?? "dealer_onboarding_myh.py"}`,
        title: undefined,
        elements: [],
        raw: "[hma mode — drive via Page.method actions in your plan]",
      };
    }
    if (!this.browser) throw new Error("not started");
    // Find a useful set of elements: anything tappable + anything with text.
    // We use the Appium "find by xpath" with a wide net, then assign sequential
    // refs e1, e2, … per snapshot so the agent has a stable handle within one turn.
    const xpath = "//*[@clickable='true' or @enabled='true' or @text or @label or @value or @hint]";
    const els = await this.browser.$$(xpath as never);
    this.refMap.clear();
    const elements: SnapshotElement[] = [];
    let i = 0;
    for (const el of els) {
      if (i >= 80) break;
      try {
        const id = (el as unknown as { elementId: string }).elementId;
        const tag = await el.getTagName().catch(() => "element");
        const name = await el.getText().catch(() => "")
                  || await el.getAttribute("label").catch(() => "")
                  || await el.getAttribute("name").catch(() => "")
                  || await el.getAttribute("content-desc").catch(() => "");
        const ref = `@e${++i}`;
        this.refMap.set(ref, id);
        elements.push({
          ref,
          role: tag,
          name: name?.toString().trim().slice(0, 120) || undefined,
        });
      } catch { /* skip */ }
    }
    const pageSource = await this.browser.getPageSource().catch(() => "");
    const raw = `Mobile snapshot — ${elements.length} elements\n\n` + pageSource.slice(0, 4000);
    return { url: undefined, title: undefined, elements, raw };
  }

  async act(a: Action): Promise<ActionResult> {
    if (this.mode === "hma") return this.actHma(a);
    if (!this.browser) return { ok: false, detail: "not started" };

    try {
      switch (a.type) {
        case "click": {
          const id = this.refMap.get(a.ref);
          if (!id) return { ok: false, detail: `unknown ref ${a.ref} — re-snapshot` };
          await this.browser.elementClick(id);
          return { ok: true };
        }
        case "fill": {
          const id = this.refMap.get(a.ref);
          if (!id) return { ok: false, detail: `unknown ref ${a.ref} — re-snapshot` };
          await this.browser.elementClear(id).catch(() => undefined);
          await this.browser.elementSendKeys(id, a.text);
          return { ok: true };
        }
        case "press": {
          // Best-effort: send the key as text to the focused element.
          await this.browser.keys(a.key);
          return { ok: true };
        }
        case "scroll": {
          // Touch-action scroll; works on both platforms via mobile: scrollGesture.
          const dir = a.direction === "up" ? "down" : "up";
          await this.browser.execute("mobile: scrollGesture", { direction: dir, percent: 0.8 } as never).catch(() => undefined);
          return { ok: true };
        }
        case "wait": {
          if (a.refOrUrl?.startsWith("@")) {
            const id = this.refMap.get(a.refOrUrl);
            if (!id) return { ok: false, detail: `unknown ref ${a.refOrUrl}` };
            await this.browser.waitUntil(async () => !!(await this.browser!.elementClick(id).then(() => true).catch(() => false)), { timeout: 15_000 });
          } else {
            await new Promise((r) => setTimeout(r, a.ms ?? 1500));
          }
          return { ok: true };
        }
        case "get_text": {
          const id = this.refMap.get(a.ref);
          if (!id) return { ok: false, detail: `unknown ref ${a.ref}` };
          const t = await this.browser.getElementText(id);
          return { ok: true, detail: t };
        }
        case "screenshot": {
          await this.screenshot(a.path, a.fullPage);
          return { ok: true, detail: a.path };
        }
        default:
          return { ok: false, detail: `mobile/appium does not support action ${a.type}` };
      }
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }

  /** hma mode: dispatch Page.method against the existing Python POM. */
  private async actHma(a: Action): Promise<ActionResult> {
    try {
      if (a.type !== "click" || !a.ref.includes(".")) {
        return { ok: false, detail: `hma mode only supports click {ref: "Page.method"}; got ${JSON.stringify(a)}` };
      }
      const parts = a.ref.split(".", 2);
      const pageName = parts[0];
      const methodName = parts[1];
      if (!pageName || !methodName) {
        return { ok: false, detail: `hma mode expects ref "Page.method"; got "${a.ref}"` };
      }
      const pyScript = [
        `import importlib`,
        `mod = importlib.import_module("pages.${pageName.toLowerCase()}")`,
        `Page = getattr(mod, "${pageName}")`,
        `from utils import driver_singleton`,
        `p = Page(driver_singleton.get())`,
        `p.${methodName}()`,
      ].join("\n");
      const out = await runPython(["-c", pyScript], HMA_DIR, 30_000);
      return { ok: true, detail: out.trim().slice(-200) };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }

  async screenshot(filePath: string, _fullPage = false): Promise<string> {
    await mkdir(dirname(filePath), { recursive: true });
    if (this.mode === "hma") {
      const pyScript = `from utils import driver_singleton; driver_singleton.get().save_screenshot("${filePath.replace(/"/g, '\\"')}")`;
      await runPython(["-c", pyScript], HMA_DIR, 15_000);
      return filePath;
    }
    if (!this.browser) throw new Error("not started");
    const png = await this.browser.takeScreenshot();
    await writeFile(filePath, Buffer.from(png, "base64"));
    return filePath;
  }

  async close(): Promise<void> {
    if (this.mode === "hma") {
      try {
        await runPython(["-c", "from utils import driver_singleton; driver_singleton.quit()"], HMA_DIR, 10_000);
      } catch { /* ignore */ }
      return;
    }
    if (this.browser) {
      try { await this.browser.deleteSession(); } catch { /* ignore */ }
      this.browser = null;
    }
  }
}
