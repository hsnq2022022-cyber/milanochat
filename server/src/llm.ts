/**
 * طبقة LLM قابلة للتبديل:
 *  - openai: أي مزوّد متوافق مع OpenAI Chat Completions (OpenAI, Azure, Groq, موديلات محلية)
 *  - anthropic: Anthropic Messages API
 * التبديل يتم بالكامل من متغيرات البيئة بدون تغيير كود.
 */
import { config } from "./config.js";

export async function chatCompletion(
  system: string,
  user: string,
  opts: { json?: boolean; maxTokens?: number } = {}
): Promise<string> {
  const { provider, apiKey, baseUrl, model } = config.llm;

  if (provider === "anthropic") {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: opts.maxTokens ?? 400,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) throw new Error(`[llm] Anthropic ${res.status}: ${await res.text()}`);
    const data: any = await res.json();
    return data?.content?.[0]?.text ?? "";
  }

  // openai-compatible
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      max_tokens: opts.maxTokens ?? 400,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`[llm] OpenAI-compatible ${res.status}: ${await res.text()}`);
  const data: any = await res.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

/** embeddings متوافقة مع OpenAI — تُرسل على دفعات */
export async function embed(texts: string[]): Promise<number[][]> {
  const { apiKey, baseUrl, model } = config.embed;
  const out: number[][] = [];
  const BATCH = 32;
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input: batch }),
    });
    if (!res.ok) throw new Error(`[embed] ${res.status}: ${await res.text()}`);
    const data: any = await res.json();
    const sorted = (data.data ?? []).sort((a: any, b: any) => a.index - b.index);
    out.push(...sorted.map((d: any) => d.embedding as number[]));
  }
  if (out.length !== texts.length) throw new Error("[embed] عدد النتائج لا يطابق المدخلات");
  return out;
}

/** تحويل مصفوفة إلى صيغة pgvector النصية: [0.1,0.2,...] */
export function toPgVector(v: number[]): string {
  return `[${v.join(",")}]`;
}
