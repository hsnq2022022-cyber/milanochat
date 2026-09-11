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

/**
 * استدعاء Gemini للنصوص.
 */
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);

  let res: Response;

  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw new Error("[Gemini] انتهت مهلة طلب توليد الرد");
    }

    throw new Error(
      `[Gemini] فشل الاتصال: ${String(error?.message ?? error)}`
    );
  } finally {
    clearTimeout(timeout);
  }

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

  return text.trim();
}

/**
 * إنشاء embeddings باستخدام Gemini.
 *
 * قاعدة البيانات الحالية تستخدم 3072 dimensions.
 */
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

  // قاعدة البيانات الحالية لديك = vector بحجم 3072
  const dim = config.embed.dim || 3072;

  if (dim !== 3072) {
    throw new Error(
      `[Gemini Embeddings] GEMINI_EMBED_DIM يجب أن يكون 3072، والقيمة الحالية هي ${dim}`
    );
  }

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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);

    let res: Response;

    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          requests,
        }),
        signal: controller.signal,
      });
    } catch (error: any) {
      if (error?.name === "AbortError") {
        throw new Error(
          "[Gemini Embeddings] انتهت مهلة إنشاء embeddings"
        );
      }

      throw new Error(
        `[Gemini Embeddings] فشل الاتصال: ${String(
          error?.message ?? error
        )}`
      );
    } finally {
      clearTimeout(timeout);
    }

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

      if (values.length !== dim) {
        throw new Error(
          `[Gemini Embeddings] البُعد غير صحيح: Gemini أعاد ${values.length} بينما المطلوب ${dim}`
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

/**
 * تحويل vector إلى الصيغة التي يفهمها pgvector.
 */
export function toPgVector(v: number[]): string {
  if (!Array.isArray(v) || v.length === 0) {
    throw new Error(
      "[pgvector] لا يمكن تحويل embedding فارغ"
    );
  }

  if (v.length !== config.embed.dim) {
    throw new Error(
      `[pgvector] بُعد embedding غير صحيح: ${v.length} بدل ${config.embed.dim}`
    );
  }

  return `[${v.join(",")}]`;
}
