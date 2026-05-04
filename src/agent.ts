/**
 * Agent loop — the LLM picks one action at a time given the current
 * snapshot and the intent it's working on. Self-heals: if an action fails
 * (e.g. ref disappeared after navigation), we re-snapshot and let the LLM
 * pick again with a "previous attempt failed" hint.
 *
 * The LLM never sees raw HTML or DOM — only the structured snapshot from
 * the driver. This keeps prompts small and platform-agnostic.
 */
import { chatJson, type ChatMsg } from "./llm.js";
import type { Driver, Snapshot, Action } from "./drivers/types.js";

const SYSTEM_PROMPT = `You are an autonomous QA agent that drives a web or mobile app to validate a user-supplied test plan.

You will receive:
  - the current INTENT (one natural-language step from the plan)
  - a SNAPSHOT of the current page (URL, title, list of interactive elements with refs like @e1, @e2)
  - a HISTORY of actions you have already taken on this intent (with their outcomes)

You output a single JSON object describing your next action. Available actions:
  {"type":"click","ref":"@e1"}
  {"type":"fill","ref":"@e2","text":"alice@example.com"}
  {"type":"select","ref":"@e3","option":"California"}
  {"type":"check","ref":"@e4"}
  {"type":"press","key":"Enter"}
  {"type":"scroll","direction":"down","pixels":600}
  {"type":"wait","ms":1500}
  {"type":"wait","refOrUrl":"@e1"}                # wait for element
  {"type":"wait","refOrUrl":"**/redline"}         # wait for URL match
  {"type":"get_text","ref":"@e1"}                 # for assertion / verification
  {"type":"open","url":"https://..."}
  {"type":"done","reason":"intent satisfied because ..."}
  {"type":"give_up","reason":"could not complete because ..."}

RULES:
  1. Output ONLY a JSON object — no preamble, no commentary, no code fences. Just {...}.
  2. Pick refs that match the user's intent. Read element names carefully.
  3. After a click that likely navigated, the next iteration will re-snapshot — you don't need to add an explicit wait unless the page is slow.
  4. If you are confident the intent is satisfied (visual/state evidence in the snapshot), return {"type":"done", "reason":"..."}.
  5. If the page clearly does not contain what's needed and you've tried 2+ approaches, return {"type":"give_up", "reason":"..."}.
  6. Do NOT invent refs that aren't in the snapshot.
  7. Never repeat the same action twice in a row. If your last action ran ok but the page didn't change in the way you expected, the next action should be {"type":"wait","ms":3000} (async work in flight) or a different approach (e.g. press Enter instead of click, scroll to reveal more, look for a different ref).`;

export interface AgentDecision {
  type: string;
  ref?: string;
  text?: string;
  option?: string;
  key?: string;
  direction?: "up" | "down";
  pixels?: number;
  ms?: number;
  refOrUrl?: string;
  url?: string;
  reason?: string;
}

export interface IntentRun {
  intent: string;
  steps: Array<{ action: AgentDecision; ok: boolean; detail?: string; snapshotAfter?: { url?: string; title?: string } }>;
  outcome: "satisfied" | "gave_up" | "max_steps_reached" | "errored";
  finalReason?: string;
}

function snapshotForLLM(s: Snapshot): string {
  const lines: string[] = [];
  if (s.url) lines.push(`URL: ${s.url}`);
  if (s.title) lines.push(`Title: ${s.title}`);
  lines.push("Interactive elements:");
  if (s.elements.length === 0) {
    lines.push("  (none in accessibility tree)");
  } else {
    for (const el of s.elements.slice(0, 60)) {
      const bits = [el.ref, `[${el.role}]`];
      if (el.name) bits.push(`"${el.name}"`);
      if (el.value) bits.push(`value="${el.value}"`);
      lines.push(`  ${bits.join(" ")}`);
    }
    if (s.elements.length > 60) lines.push(`  … (${s.elements.length - 60} more elements omitted)`);
  }
  // Always include the raw snapshot too — many apps render meaningful content
  // (chat threads, status banners, error messages) as plain divs that don't
  // appear in the structured element list. The LLM needs both.
  if (s.raw) {
    lines.push("");
    lines.push("Raw page content (use this to verify text/responses appeared):");
    lines.push(s.raw.slice(-3500));
  }
  return lines.join("\n");
}

function decisionToAction(d: AgentDecision): Action | null {
  switch (d.type) {
    case "click":      return d.ref ? { type: "click", ref: d.ref } : null;
    case "fill":       return d.ref && typeof d.text === "string" ? { type: "fill", ref: d.ref, text: d.text } : null;
    case "select":     return d.ref && d.option ? { type: "select", ref: d.ref, option: d.option } : null;
    case "check":      return d.ref ? { type: "check", ref: d.ref } : null;
    case "press":      return d.key ? { type: "press", key: d.key } : null;
    case "scroll":     return { type: "scroll", direction: d.direction ?? "down", pixels: d.pixels };
    case "wait":       return { type: "wait", ms: d.ms, refOrUrl: d.refOrUrl };
    case "get_text":   return d.ref ? { type: "get_text", ref: d.ref } : null;
    case "open":       return d.url ? { type: "open", url: d.url } : null;
    default:           return null;
  }
}

export async function runIntent(
  driver: Driver,
  intent: string,
  maxSteps: number,
): Promise<IntentRun> {
  const run: IntentRun = { intent, steps: [], outcome: "max_steps_reached" };

  for (let i = 0; i < maxSteps; i++) {
    let snap: Snapshot;
    try {
      snap = await driver.snapshot();
    } catch (e) {
      run.outcome = "errored";
      run.finalReason = `snapshot failed: ${(e as Error).message}`;
      return run;
    }

    const historyText = run.steps.length === 0
      ? "(no prior actions on this intent)"
      : run.steps.map((s, idx) => `${idx + 1}. ${JSON.stringify(s.action)} → ${s.ok ? "ok" : "FAIL"}${s.detail ? `: ${s.detail.slice(0, 120)}` : ""}`).join("\n");

    const messages: ChatMsg[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `INTENT: ${intent}\n\nHISTORY:\n${historyText}\n\nSNAPSHOT:\n${snapshotForLLM(snap)}\n\nWhat is your next action? Output a single JSON object.` },
    ];

    let decision: AgentDecision;
    try {
      decision = await chatJson<AgentDecision>(messages, { maxTokens: 512 });
    } catch (e) {
      run.outcome = "errored";
      run.finalReason = `LLM error: ${(e as Error).message}`;
      return run;
    }

    if (decision.type === "done") {
      run.outcome = "satisfied";
      run.finalReason = decision.reason;
      return run;
    }
    if (decision.type === "give_up") {
      run.outcome = "gave_up";
      run.finalReason = decision.reason;
      return run;
    }

    let action = decisionToAction(decision);
    if (!action) {
      run.steps.push({ action: decision, ok: false, detail: "invalid action shape from LLM" });
      continue;
    }

    // Hard anti-loop guard: if the previous two actions are identical to this
    // one and both succeeded with no visible state change, force a 3s wait
    // before retrying. The LLM is often correct that the click works — async
    // UI just hasn't settled yet.
    const last = run.steps.at(-1);
    const prev = run.steps.at(-2);
    const sameAsLast = last && JSON.stringify(last.action) === JSON.stringify(decision);
    const sameAsPrev = prev && JSON.stringify(prev.action) === JSON.stringify(decision);
    if (sameAsLast && sameAsPrev && last.ok && prev.ok) {
      action = { type: "wait", ms: 3000 };
      run.steps.push({ action: { type: "wait", ms: 3000, reason: "anti-loop: forced wait" } as AgentDecision, ok: true, detail: "forced wait — same action repeated", snapshotAfter: { url: snap.url, title: snap.title } });
      try { await driver.act(action); } catch { /* ok */ }
      continue;
    }

    let result;
    try {
      result = await driver.act(action);
    } catch (e) {
      result = { ok: false, detail: (e as Error).message };
    }

    run.steps.push({
      action: decision,
      ok: result.ok,
      detail: result.detail,
      snapshotAfter: { url: snap.url, title: snap.title },
    });
  }

  return run;
}

/**
 * Final assertion pass — for each natural-language assertion in the plan,
 * we hand the LLM the latest snapshot and ask "is this true?". Returns
 * pass/fail + reasoning.
 */
export async function checkAssertion(
  driver: Driver,
  assertion: string,
): Promise<{ pass: boolean; reason: string }> {
  const snap = await driver.snapshot();
  const messages: ChatMsg[] = [
    { role: "system", content: "You verify whether an assertion is true given the current page snapshot. Output ONLY a JSON object: {\"pass\": boolean, \"reason\": string}. Be strict — only `true` if there is concrete evidence in the snapshot." },
    { role: "user", content: `ASSERTION: ${assertion}\n\nSNAPSHOT:\n${snapshotForLLM(snap)}` },
  ];
  try {
    const r = await chatJson<{ pass: boolean; reason: string }>(messages, { maxTokens: 256 });
    return { pass: !!r.pass, reason: r.reason || "" };
  } catch (e) {
    return { pass: false, reason: `assertion check errored: ${(e as Error).message}` };
  }
}
