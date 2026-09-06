import { config } from "./config.js";

const GEMINI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta";

function requireGeminiKey(): string {
  const key = config.llm.apiKey || config.embed.apiKey;

  if (!key) {
    throw new Error(
      "[Gemini] GEMINI_API_KEY غير موجود في متغيرات البيئة"
    );
  }

  return key;
}

export async function chatCompletion(
  system: string,
  user: string,
  opts: {
    json?: boolean;
    maxTokens?: number;
  } = {}
): Promise<string> {
  const apiKey = requireGeminiKey();
  const model = config.llm.model;

  const url =
    `${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:generateContent` +
    `?key=${encodeURIComponent(apiKey)}`;

  const generationConfig: Record<string, unknown> = {
    temperature: 0.3,
    maxOutputTokens: opts.maxTokens ?? 400,
  };

  if (opts.json) {
    generationConfig.responseMimeType = "application/json";
  }

  const body = {
    systemInstruction: {
      parts: [
        {
          text: system,
        },
      ],
    },

    contents: [
      {
        role: "user",
        parts: [
          {
            text: user,
          },
        ],
      },
    ],

    generationConfig,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const raw = await res.text();

  if (!res.ok) {
    throw new Error(`[Gemini] ${res.status}: ${raw}`);
  }

  let data: any;

  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`[Gemini] استجابة غير صالحة: ${raw}`);
  }

  const text =
    data?.candidates?.[0]?.content?.parts
      ?.map((part: any) => part?.text ?? "")
      .join("") ?? "";

  if (!text) {
    const finishReason =
      data?.candidates?.[0]?.finishReason ?? "UNKNOWN";

    throw new Error(
      `[Gemini] لم يتم إرجاع نص. finishReason=${finishReason}`
    );
  }

  return text;
}

export async function embed(
  texts: string[]
): Promise<number[][]> {
  if (!texts.length) {
    return [];
  }

  const apiKey = config.embed.apiKey;

  if (!apiKey) {
    throw new Error(
      "[Gemini Embeddings] GEMINI_API_KEY غير موجود"
    );
  }

  const model = config.embed.model;
  const dim = config.embed.dim;
  const BATCH = 32;

  const out: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);

    const url =
      `${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:batchEmbedContents` +
      `?key=${encodeURIComponent(apiKey)}`;

    const requests = batch.map((text) => ({
      model: `models/${model}`,

      content: {
        parts: [
          {
            text,
          },
        ],
      },

      embedContentConfig: {
        outputDimensionality: dim,
      },
    }));

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        requests,
      }),
    });

    const raw = await res.text();

    if (!res.ok) {
      throw new Error(
        `[Gemini Embeddings] ${res.status}: ${raw}`
      );
    }

    let data: any;

    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(
        `[Gemini Embeddings] استجابة غير صالحة: ${raw}`
      );
    }

    const embeddings = data?.embeddings ?? [];

    if (embeddings.length !== batch.length) {
      throw new Error(
        `[Gemini Embeddings] عدد النتائج (${embeddings.length}) لا يطابق عدد المدخلات (${batch.length})`
      );
    }

    for (const item of embeddings) {
      const values = item?.values;

      if (!Array.isArray(values) || values.length === 0) {
        throw new Error(
          "[Gemini Embeddings] تم استلام embedding فارغ أو غير صالح"
        );
      }

      out.push(values as number[]);
    }
  }

  if (out.length !== texts.length) {
    throw new Error(
      `[Gemini Embeddings] عدد النتائج النهائي (${out.length}) لا يطابق المدخلات (${texts.length})`
    );
  }

  return out;
}

export function toPgVector(v: number[]): string {
  if (!Array.isArray(v) || v.length === 0) {
    throw new Error(
      "[pgvector] لا يمكن تحويل embedding فارغ"
    );
  }

  return `[${v.join(",")}]`;
}
