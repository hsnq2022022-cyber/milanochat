/**
 * generate-flow: Gemini call (native generateContent, JSON mode).
 *
 * Same API shape as server/src/llm.ts (v1beta generateContent,
 * systemInstruction, responseMimeType application/json) and the same header
 * auth as flow-outbox-worker/aiStep.ts (x-goog-api-key, never in the URL).
 * Fixed Google host only; the model name is validated before it reaches the
 * path. 25 s per attempt, at most one retry (transport/429/5xx only).
 * Never logs prompt or response content.
 */
export const GEMINI_HOST = "https://generativelanguage.googleapis.com";
export const GEMINI_TIMEOUT_MS = 25_000;
export const DEFAULT_MODEL = "gemini-2.5-flash";
const MODEL_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;

export type LlmErrorCode = "timeout" | "http" | "network" | "empty" | "config";
export class LlmError extends Error {
  readonly code: LlmErrorCode;
  constructor(code: LlmErrorCode) { super("llm_" + code); this.code = code; }
}

export type LlmCall = (system: string, user: string) => Promise<string>;

export function geminiModel(raw: string | undefined): string {
  const m = (raw ?? "").trim();
  return MODEL_RE.test(m) ? m : DEFAULT_MODEL;
}

export function createGeminiCall(opts: {
  apiKey: string; model: string; fetcher?: typeof fetch; timeoutMs?: number; retryDelayMs?: number;
}): LlmCall {
  const fetcher = opts.fetcher ?? fetch;
  const timeoutMs = opts.timeoutMs ?? GEMINI_TIMEOUT_MS;
  const model = geminiModel(opts.model);
  const url = `${GEMINI_HOST}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const once = async (system: string, user: string): Promise<string> => {
    let res: Response;
    try {
      res = await fetcher(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": opts.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 8192, responseMimeType: "application/json" },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      throw new LlmError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network");
    }
    if (!res.ok) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      const err = new LlmError("http");
      (err as LlmError & { status?: number }).status = res.status;
      throw err;
    }
    let data: unknown;
    try { data = await res.json(); } catch { throw new LlmError("empty"); }
    const parts = (data as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> })
      ?.candidates?.[0]?.content?.parts;
    const text = Array.isArray(parts) ? parts.map(p => typeof p?.text === "string" ? p.text : "").join("") : "";
    if (!text) throw new LlmError("empty");
    return text;
  };
  return async (system, user) => {
    if (!opts.apiKey) throw new LlmError("config");
    try {
      return await once(system, user);
    } catch (e) {
      const status = (e as { status?: number }).status;
      const retryable = e instanceof LlmError &&
        (e.code === "timeout" || e.code === "network" || (e.code === "http" && (status === 429 || (status ?? 0) >= 500)));
      if (!retryable) throw e;
      await new Promise(r => setTimeout(r, opts.retryDelayMs ?? 500));
      return await once(system, user);
    }
  };
}
