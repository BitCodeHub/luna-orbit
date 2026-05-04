# Luna Orbit

[![CI](https://github.com/BitCodeHub/luna-orbit/actions/workflows/ci.yml/badge.svg)](https://github.com/BitCodeHub/luna-orbit/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**AI-native regression testing. You describe what to test. Luna writes the test plan AND runs it.**

```bash
luna-orbit auto \
  --target https://shop.example.com \
  --requirement "Verify a logged-out user can search for a product, add it to cart, and reach checkout"
```

That's the whole interface. No selectors. No recording. No prior plan file. Luna opens the app, explores it briefly, **writes a runnable test plan in markdown**, **executes the plan**, and prints PASS/FAIL with per-step screenshots and an HTML report.

Of course you can also keep your tests as files in your repo (`luna-orbit run plans/checkout.md`), or have Luna only write plans (`luna-orbit author --save`), or stand up an HTTP API (`luna-orbit serve`) — all four flows are first-class.

> Built by **Lumen AI Solutions**. Same MLX agent stack that powers our internal agents (Lysa, Luna) — `gemma-4-31b-it` running locally on a Mac Studio over Tailscale, free per-run. Swap in Claude / GPT / Azure with one env var.

---

## How Luna Orbit is different

Tested against 22 competitors (Mabl, QA.tech, Octomind, Reflect, Momentic, Functionize, TestRigor, Stagehand, Browser-Use, Skyvern, Hercules, LaVague, Magnitude, Cypress Cloud, Sauce Labs, BrowserStack, Applitools, Katalon, Mabl, Testim, Checkly, Anthropic Computer Use). Luna Orbit's four real differentiators:

1. **AI-NATIVE: tests write themselves.** `luna-orbit auto --target URL --requirement "..."` is the headline interface — Luna explores the app and authors the plan from one sentence, then runs it. Octomind/QA.tech/Reflect have plan generation but it's locked behind closed-source SaaS that ships your DOM to OpenAI. **No OSS competitor offers AI-native authoring + local LLM.**

2. **Local-LLM default = $0/run, no data leaves your network.** Defaults to MLX `gemma-4-31b-it` on Tailscale. Override to Claude/GPT/Azure with one env var. **No competitor defaults to local.** Stagehand technically supports local but the docs nudge you to OpenAI/Anthropic. Big deal in regulated industries (health, fintech, defense) where SOC2/HIPAA prohibits sending UI traces to a third-party LLM.

3. **One markdown plan format → web AND mobile.** Same authoring surface for Playwright (web) and Appium (mobile). **Stagehand, Browser-Use, Skyvern, Magnitude, Hercules, LaVague are web-only.** Mabl/Reflect/Momentic have both but with separate authoring stacks. Luna Orbit unifies them under one `platform: web|mobile` toggle.

4. **Tests live as markdown files in your app repo.** Version-controlled, code-reviewed in PRs, diff-able. **All SaaS competitors store tests in their cloud DB.** OSS Hercules/LaVague come closest but use Gherkin, not plain markdown.

Pricing: **MIT-licensed core, free forever for local runs.** Hosted dashboard / shareable links / scheduled runners coming as a paid add-on (usage-based).

---

## The four ways to use Luna Orbit

| Interface | When |
|---|---|
| `luna-orbit auto --target … --requirement …` | **Pure AI-native.** Don't even write a plan — describe what you want tested, Luna does the rest. Best for smoke tests, exploratory QA, "did this PR break anything obvious." |
| `luna-orbit author --target … --requirement … --save plan.md` | Have Luna write the plan, then you commit it to your repo. Best when you want repeatable tests but don't want to author them by hand. |
| `luna-orbit run plan.md` | Run an existing plan. Best for CI — tests are version-controlled markdown files in your app repo. |
| `luna-orbit serve` | Long-lived HTTP API + tiny dashboard. Best when other services or non-engineers need to trigger runs and see history. |

---

## What it covers

| Platform | Driver | Targets |
|---|---|---|
| **Web** (`platform: web`) | [agent-browser](https://www.npmjs.com/package/agent-browser) (Playwright under the hood) | Any **website / SPA / webapp** — Chrome, Edge, Safari, Firefox |
| **Mobile** (`platform: mobile`) | Appium via WebDriverIO | Any **iOS or Android app** (native, hybrid, or WebView) |

> **Appium is mobile-only.** For web/webapps, Luna Orbit uses Playwright through agent-browser. The same plan format, the same agent loop, the same report — just a different driver under the hood.

---

## Why Luna Orbit vs hand-written Playwright/Cypress

Selector-based E2E suites break the moment someone renames a button. They also can't author themselves. Luna Orbit:

- **Self-heals** — refs come from the accessibility tree, not CSS. When a ref vanishes, the agent re-snapshots and picks a new one.
- **Writes themselves from intent** — `1. Click "Send for signature"` is the test. No `cy.get('[data-testid=send-btn]')`.
- **Catches semantic bugs** — assertions are natural language ("the latest response mentions Trump by name"), checked by the LLM against the live snapshot.
- **One package, two platforms** — same plan format works for web and mobile.
- **Defaults to local LLM** — uses our MLX `gemma-4-31b-it` over Tailscale by default. Free, fast enough, no rate limits. Override to Claude/GPT via `LUNA_ORBIT_LLM_*` env vars.
- **Drop into any platform** — installable npm package + CLI, no coupling to any specific app.

---

## Install

```bash
npm i -D luna-orbit
# Once-off: install the headless browser binary used by the web driver
npx agent-browser install
```

For mobile: install [Appium](https://appium.io) (`npm i -g appium && appium driver install uiautomator2 xcuitest`) and have the device/simulator running.

---

## Plan format

Markdown with a YAML frontmatter block + `## Steps` + `## Assertions`:

### Web

```markdown
---
name: My checkout flow
target: https://shop.example.com
platform: web
viewport: 1280x900
max_steps_per_intent: 8
---

## Steps
1. Click "Add to cart" on the first product
2. Open the cart
3. Click "Checkout"
4. Fill the email field with "qa@example.com"
5. Click "Continue to payment"

## Assertions
- The order summary shows exactly one item
- The "Continue to payment" page is visible
```

### Mobile (generic Appium — any app)

```markdown
---
name: Settings smoke
platform: mobile
mobile_mode: appium
capabilities: {"platformName":"Android","appium:automationName":"UiAutomator2","appium:appPackage":"com.android.settings","appium:appActivity":".Settings"}
---

## Steps
1. Tap "Network & internet"
2. Tap "Internet"

## Assertions
- A list of nearby Wi-Fi networks is visible
```

`capabilities:` is a single-line JSON object — passes straight to Appium. iOS example: `{"platformName":"iOS","appium:automationName":"XCUITest","appium:bundleId":"com.example.MyApp","appium:platformVersion":"17.0","appium:deviceName":"iPhone 15"}`.

### Mobile (Lumen-specific Hyundai POM)

If you already have a Page-Object-Model suite (we use `~/Code/hma_automation` for Hyundai/Genesis dealer flows), use `mobile_mode: hma` and reference `Page.method`:

```markdown
---
name: Dealer onboarding smoke
platform: mobile
mobile_mode: hma
hma_entry: dealer_onboarding_myh.py
---

## Steps
1. HomePage.tap_search
2. DealersPage.tap_first_result
3. DealerDetailPage.tap_schedule_service
```

---

## CLI

```bash
# One-shot: run a plan, print PASS/FAIL, exit
luna-orbit run plans/checkout.md --out ./orbit-out
luna-orbit run plans/checkout.md --headed   # see the browser window
orbit run plans/checkout.md                 # short alias

# Long-lived: HTTP API + tiny dashboard at /
luna-orbit serve --port 8780 --data-dir ./orbit-data --max-parallel 2
```

`run` exits **0** on pass, **1** on test failure, **2** on crash.

---

## Programmatic

```ts
import { runPlan } from "luna-orbit";

const report = await runPlan("plans/checkout.md");
if (!report.passed) process.exit(1);
```

---

## HTTP API (`luna-orbit serve`)

For triggering runs from a service, scheduling jobs, or letting a non-engineer kick off a smoke from a tiny built-in dashboard.

```bash
luna-orbit serve --port 8780 --data-dir ./orbit-data --max-parallel 2
# Open http://localhost:8780/  → list of recent runs + links to each report
```

Endpoints:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/runs` | Start a run. Body: `{ "plan_md": "<markdown>", "options": { "headed": false } }` (or `"plan_path": "/path/on/server"`). Returns `{ id, status: "queued" }`. |
| `GET` | `/v1/runs` | List recent runs (`?limit=N&status=passed\|failed\|errored\|running`). |
| `GET` | `/v1/runs/:id` | Status + summary (`status`, `passed`, `intents_satisfied/total`, `assertions_pass/total`, `duration_ms`). |
| `GET` | `/v1/runs/:id/report.json` | Full machine-readable trace. |
| `GET` | `/v1/runs/:id/report.html` | Pre-rendered single-file HTML report with screenshots. |
| `GET` | `/v1/runs/:id/screenshots/:name` | Serve a per-step screenshot PNG. |
| `GET` | `/healthz` | Liveness + queue depth. |
| `GET` | `/` | Tiny built-in dashboard (HTML). |

**Auth:** set `LUNA_ORBIT_API_KEYS=key1,key2,key3`. All `/v1/*` endpoints then require `Authorization: Bearer <one-of-them>`. With the env var unset, the server is **OPEN** — fine for local dev, never expose to the internet without keys set.

**Concurrency:** `--max-parallel` caps simultaneous runs (default 2). Each run spawns a real Chromium / Appium session, so set this conservatively.

**Storage:** filesystem. `<data-dir>/index.json` is the registry; `<data-dir>/runs/<id>/` holds each run's plan + report + screenshots. No DB.

### Outbound webhooks

When any run finishes, POST a JSON payload to one or more URLs. Slack and Discord webhook URLs are auto-detected and reshaped — generic URLs receive the canonical payload.

```bash
LUNA_ORBIT_WEBHOOKS="https://hooks.slack.com/services/T0/B0/XYZ,https://example.com/ci/luna" \
LUNA_ORBIT_WEBHOOK_SECRET="my-shared-secret" \
luna-orbit serve
```

Generic payload (sent to non-Slack/Discord URLs):

```json
{
  "event": "run.completed",
  "run": { "id": "run_…", "plan_name": "Checkout · happy path", "status": "passed",
           "passed": true, "intents_satisfied": 5, "intents_total": 5,
           "assertions_pass": 3, "assertions_total": 3, "duration_ms": 28341, … },
  "summary": "✓ PASS — Checkout · happy path · intents 5/5 · assertions 3/3 · 28.3s",
  "emitted_at": "2026-05-04T04:21:12.839Z"
}
```

If `LUNA_ORBIT_WEBHOOK_SECRET` is set, an `x-luna-orbit-signature: sha256=<hex>` header is added — verify on the receiving side to defend against forged calls.

---

## Reports

Each run writes:
- `<outDir>/report.json` — full machine-readable trace (intents, actions, decisions, assertions)
- `<outDir>/report.html` — single-file HTML rollup with per-intent screenshots
- `<outDir>/screenshots/intent-NN.png` + `final.png`

---

## Env vars

| Var | Default | Notes |
|---|---|---|
| `LUNA_ORBIT_LLM_BASE_URL` | `http://100.90.199.128:8084/v1` | OpenAI-compatible chat endpoint. Same gemma-4-31b instance Lysa uses. |
| `LUNA_ORBIT_LLM_MODEL` | `mlx-community/gemma-4-31b-it-bf16` | Model name |
| `LUNA_ORBIT_LLM_API_KEY` | _(none)_ | Bearer token if the endpoint requires it |
| `LUNA_ORBIT_AGENT_BROWSER_BIN` | `agent-browser` | Override path/binary |
| `LUNA_ORBIT_APPIUM_URL` | `http://127.0.0.1:4723` | Appium server URL for mobile |
| `LUNA_ORBIT_HMA_DIR` | `~/Code/hma_automation` | Lumen-specific POM dir (only used when `mobile_mode: hma`) |

> **Cloud LLM examples** — point at Anthropic Claude:
> ```bash
> export LUNA_ORBIT_LLM_BASE_URL="https://api.anthropic.com/v1"
> export LUNA_ORBIT_LLM_MODEL="claude-sonnet-4"
> export LUNA_ORBIT_LLM_API_KEY="sk-ant-..."
> ```
> Or OpenAI:
> ```bash
> export LUNA_ORBIT_LLM_BASE_URL="https://api.openai.com/v1"
> export LUNA_ORBIT_LLM_MODEL="gpt-4o"
> export LUNA_ORBIT_LLM_API_KEY="sk-..."
> ```

Legacy `QA_PILOT_*` env vars are also accepted (Luna Orbit was renamed from `qa-pilot` on 2026-05-03).

---

## Architecture

```
   plan.md ──► parsePlan ──► [intent₁, intent₂, …] ──┐
                                                      ▼
   driver (web | mobile) ◄─── agent loop ◄─── LLM ─── for each intent:
       │                       │                          snapshot → LLM picks action
       │                       │                          act → re-snapshot
       │                       │                          repeat until done|give_up|max
       │                       ▼
       │                 final assertions ──► LLM checks each natural-language assertion
       ▼
   report.html + report.json + screenshots/
```

- **Web driver** = subprocess wrapper around `agent-browser` CLI (Playwright underneath).
- **Mobile driver** = WebDriverIO + Appium (generic mode) **or** subprocess shells to a Python POM (`hma` mode).
- **Agent loop** runs LLM-picked actions one-at-a-time; anti-loop guard forces a wait if the same action runs three times in a row.
- Adding a new platform = implement the `Driver` interface (`open`, `snapshot`, `act`, `screenshot`, `close`).

---

## License

MIT. Built by Lumen AI Solutions.
