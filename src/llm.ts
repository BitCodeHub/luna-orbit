/**
 * Tiny OpenAI-compatible chat client.
 *
 * Defaults to the same MLX stack Lysa & Luna already run on the lunalabs
 * Mac Studio — gemma-4-31b-it on port 8084, the "deep tier" used by Lysa
 * for non-trivial reasoning. Free, on Tailnet, no rate limits, no API
 * spend. Override any of these via env to point at Anthropic / OpenAI /
 * Azure / your own self-hosted MLX:
 *
 *   LUNA_ORBIT_LLM_BASE_URL   default http://100.90.199.128:8084/v1
 *   LUNA_ORBIT_LLM_MODEL      default mlx-community/gemma-4-31b-it-bf16
 *   LUNA_ORBIT_LLM_API_KEY    optional bearer token
 *
 * The Lumen agent stack uses three local models; Luna Orbit picks the
 * deep one because each agent step = perceive a snapshot + choose an
 * action, which benefits from a model that doesn't get easily confused.
 *
 *   :8080  gemma-4-26b-a4b-it      (vision/auxiliary, used as classifier)
 *   :8083  Qwen3.6-35B-A3B-8bit    (Lysa's main / fast tier)
 *   :8084  gemma-4-31b-it-bf16     (Lysa's deep tier — Luna Orbit default)
 */

const DEFAULT_BASE = "http://100.90.199.128:8084/v1";
const DEFAULT_MODEL = "mlx-community/gemma-4-31b-it-bf16";

// Read env with backward compatibility — accept legacy QA_PILOT_* names too
// so anyone with existing scripts can rename gradually.
function envFirst(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n];
    if (v) return v;
  }
  return undefined;
}

export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

/** Single round-trip — returns the assistant message content. */
export async function chat(messages: ChatMsg[], opts: ChatOptions = {}): Promise<string> {
  const baseUrl = opts.baseUrl ?? envFirst("LUNA_ORBIT_LLM_BASE_URL", "QA_PILOT_LLM_BASE_URL") ?? DEFAULT_BASE;
  const model = opts.model ?? envFirst("LUNA_ORBIT_LLM_MODEL", "QA_PILOT_LLM_MODEL") ?? DEFAULT_MODEL;
  const apiKey = opts.apiKey ?? envFirst("LUNA_ORBIT_LLM_API_KEY", "QA_PILOT_LLM_API_KEY") ?? "";
  const timeoutMs = opts.timeoutMs ?? 60_000;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: opts.maxTokens ?? 1024,
        temperature: opts.temperature ?? 0.2,
        stream: false,
        // Disable Qwen3-style reasoning preamble — we want clean JSON back.
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`LLM HTTP ${r.status}: ${body.slice(0, 300)}`);
    }
    const data = (await r.json()) as {
      choices?: Array<{ message?: { content?: string; reasoning?: string } }>;
    };
    const msg = data.choices?.[0]?.message ?? {};
    const text = (msg.content && msg.content.trim()) ? msg.content
               : (msg.reasoning && msg.reasoning.trim()) ? msg.reasoning
               : "";
    if (!text) throw new Error(`LLM returned empty response: ${JSON.stringify(data).slice(0, 300)}`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Helper: ask the LLM for a JSON object, retry once if the response isn't
 * valid JSON, throw on second failure.
 */
export async function chatJson<T = unknown>(messages: ChatMsg[], opts: ChatOptions = {}): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await chat(messages, opts);
    // Pull out the first {...} or [...] block to be tolerant of preambles.
    const m = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!m) {
      if (attempt === 1) throw new Error(`LLM did not return JSON: ${raw.slice(0, 200)}`);
      continue;
    }
    try {
      return JSON.parse(m[0]) as T;
    } catch (e) {
      if (attempt === 1) throw new Error(`Invalid JSON from LLM (${(e as Error).message}): ${m[0].slice(0, 300)}`);
    }
  }
  throw new Error("unreachable");
}
