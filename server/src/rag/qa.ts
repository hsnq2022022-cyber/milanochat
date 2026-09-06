/**
 * Milano RAG / Knowledge Engine
 *
 * الوظائف:
 * 1) استخراج محتوى الموقع.
 * 2) توليد Q&A من الموقع.
 * 3) حفظ Q&A كمعرفة.
 * 4) البحث الدلالي باستخدام pgvector.
 * 5) توليد إجابة مقيدة بالمعلومات المسترجعة فقط.
 */

import { config } from "../config.js";
import { db } from "../db.js";
import {
  chatCompletion,
  embed,
  toPgVector,
} from "../llm.js";
import { extractFromUrl } from "./ingest.js";

export type QAPair = {
  question: string;
  answer: string;
};

const QA_SYSTEM = [
  "أنت محلل محتوى لنشاط تجاري.",
  "مهمتك توليد قائمة أسئلة وأجوبة تغطي ما قد يسأل عنه عميل حقيقي عبر واتساب.",

  "قواعد صارمة:",
  "1) الأسئلة بصيغة عميل حقيقي يسأل، قصيرة وبسيطة.",
  "2) الأجوبة من المحتوى المرفق فقط.",
  "3) ممنوع اختراع أي سعر أو موعد أو عنوان أو خدمة أو منتج.",
  "4) غطِّ ما توفر من الأسعار، أوقات العمل، الموقع، العنوان، الخدمات، المنتجات، التوصيل، الدفع، الاسترجاع والتواصل.",
  "5) أعد من 5 إلى 12 زوجاً حسب غنى المحتوى.",
  '6) أعد JSON فقط بهذا الشكل: [{"question":"...","answer":"..."}]',
].join("\n");

/**
 * جلب الصفحة + استخراج النص + توليد Q&A.
 */
export async function extractQAPairs(
  url: string
): Promise<{ pairs: QAPair[]; title: string }> {
  const { text, title } = await extractFromUrl(url);

  if (text.length < 40) {
    throw new Error(
      "تعذر استخراج محتوى كافٍ من الصفحة — تأكد من الرابط أو أدخلها يدوياً"
    );
  }

  const raw = await chatCompletion(
    QA_SYSTEM,
    `عنوان الصفحة: ${title}\n\nالمحتوى:\n${text.slice(
      0,
      9000
    )}`,
    {
      json: true,
      maxTokens: 2200,
    }
  );

  const cleaned = raw
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();

  const match = cleaned.match(/\[[\s\S]*\]/);

  if (!match) {
    throw new Error(
      "لم نتمكن من فهم النتيجة المولدة — أعد المحاولة"
    );
  }

  let list: unknown;

  try {
    list = JSON.parse(match[0]);
  } catch {
    throw new Error(
      "تعذر تحليل النتيجة المولدة — أعد المحاولة"
    );
  }

  const pairs = (Array.isArray(list) ? list : [])
    .filter(
      (p: any) =>
        p &&
        typeof p.question === "string" &&
        typeof p.answer === "string"
    )
    .map((p: any) => ({
      question: p.question.trim(),
      answer: p.answer.trim(),
    }))
    .filter(
      (p: QAPair) =>
        p.question.length > 0 &&
        p.answer.length > 0
    )
    .slice(0, 20);

  if (pairs.length === 0) {
    throw new Error(
      "لم نستخرج أسئلة وأجوبة مفيدة من المحتوى — جرّب رابطاً آخر أو أدخلها يدوياً"
    );
  }

  return {
    pairs,
    title,
  };
}

/**
 * الحفظ النهائي لـ Q&A.
 */
export async function saveQAPairs(
  tenantId: string,
  pairs: QAPair[],
  sourceUrl: string | null
): Promise<{
  saved: number;
  sourceId: string;
}> {
  const valid = pairs
    .map((p) => ({
      question: p.question.trim(),
      answer: p.answer.trim(),
    }))
    .filter(
      (p) =>
        p.question.length > 0 &&
        p.answer.length > 0
    );

  if (valid.length === 0) {
    throw new Error("لا توجد أسئلة صالحة للحفظ");
  }

  const { data: source, error: srcErr } = await db
    .from("knowledge_sources")
    .insert({
      tenant_id: tenantId,
      kind: sourceUrl ? "url" : "text",
      url: sourceUrl,
      status: "pending",
      chunks_count: 0,
    })
    .select()
    .single();

  if (srcErr || !source) {
    throw new Error(
      "تعذر إنشاء سجل المصدر: " +
        (srcErr?.message ?? "unknown error")
    );
  }

  try {
    const texts = valid.map(
      (p) => `س: ${p.question}\nج: ${p.answer}`
    );

    const vectors = await embed(texts);

    if (vectors.length !== texts.length) {
      throw new Error(
        `[RAG] عدد embeddings (${vectors.length}) لا يطابق عدد النصوص (${texts.length})`
      );
    }

    const rows = texts.map((content, i) => ({
      tenant_id: tenantId,
      source_id: source.id,
      chunk_index: i,
      content,
      embedding: toPgVector(vectors[i]),
    }));

    const { error: insErr } = await db
      .from("knowledge_chunks")
      .insert(rows);

    if (insErr) {
      throw new Error(
        "تعذر حفظ الأسئلة والأجوبة: " +
          insErr.message
      );
    }

    await db
      .from("knowledge_sources")
      .update({
        status: "indexed",
        chunks_count: rows.length,
      })
      .eq("id", source.id);

    return {
      saved: valid.length,
      sourceId: source.id,
    };
  } catch (error) {
    await db
      .from("knowledge_sources")
      .update({
        status: "failed",
        error: String(
          (error as any)?.message ?? error
        ),
      })
      .eq("id", source.id);

    throw error;
  }
}

/* =========================================================
   Semantic Search / RAG
   ========================================================= */

export type SemanticMatch = {
  id: string;
  content: string;
  similarity: number;
};

/**
 * البحث الدلالي داخل معرفة tenant واحد فقط.
 */
export async function semanticSearch(
  tenantId: string,
  text: string,
  topK = config.ragTopK
): Promise<{
  matches: SemanticMatch[];
  best: number;
}> {
  if (!tenantId) {
    throw new Error("[RAG] tenantId مفقود");
  }

  if (!text.trim()) {
    return {
      matches: [],
      best: 0,
    };
  }

  console.log(
    `[RAG] semantic search tenant=${tenantId} text="${text.slice(
      0,
      80
    )}"`
  );

  /**
   * إنشاء embedding لسؤال العميل.
   */
  const vectors = await embed([text]);

  if (!vectors[0]) {
    throw new Error(
      "[RAG] لم يتم إنشاء embedding لسؤال العميل"
    );
  }

  console.log(
    `[RAG] query embedding dimension=${vectors[0].length}`
  );

  /**
   * استدعاء match_knowledge الموجود في Supabase.
   */
  const { data: hits, error } = await db.rpc(
    "match_knowledge",
    {
      p_tenant_id: tenantId,
      p_query: toPgVector(vectors[0]),
      p_limit: Math.max(
        1,
        Math.min(topK, 20)
      ),
      p_threshold: 0,
    }
  );

  if (error) {
    throw new Error(
      "[RAG] فشل البحث الدلالي match_knowledge: " +
        error.message
    );
  }

  const matches = (
    (hits ?? []) as {
      id: string;
      content: string;
      similarity: number;
    }[]
  )
    .filter(
      (h) =>
        h &&
        typeof h.content === "string" &&
        Number.isFinite(Number(h.similarity))
    )
    .map((h) => ({
      id: h.id,
      content: h.content,
      similarity:
        Math.round(
          Number(h.similarity) * 1000
        ) / 1000,
    }));

  const best =
    matches.length > 0
      ? matches[0].similarity
      : 0;

  console.log(
    `[RAG] matches=${matches.length} best=${best}`
  );

  return {
    matches,
    best,
  };
}

/**
 * توليد جواب مقيد بالسياق.
 *
 * النموذج ممنوع من استخدام معلومات خارج context.
 */
export async function generateGroundedAnswer(
  businessName: string,
  context: string,
  question: string
): Promise<{
  answer: string;
  grounded: boolean;
}> {
  if (!context.trim()) {
    return {
      answer: "",
      grounded: false,
    };
  }

  const system = [
    `أنت موظف خدمة عملاء لمشروع «${businessName}» يرد عبر واتساب.`,

    "التعليمات الصارمة:",
    "1) استخدم المعلومات الموجودة داخل <context> فقط.",
    "2) لا تستخدم معرفتك العامة أو أي معلومات خارج السياق.",
    "3) ممنوع اختلاق الأسعار أو المنتجات أو المواعيد أو العناوين أو الخدمات.",
    "4) إذا كان السياق لا يحتوي إجابة مؤكدة، اجعل grounded=false.",
    "5) إذا وجدت الإجابة في السياق، أجب عنها مباشرة.",
    "6) الرد قصير ومناسب لرسالة واتساب.",
    "7) استخدم العربية ولهجة عراقية/عربية طبيعية ومهذبة.",
    '8) أعد JSON فقط: {"answer":"...","grounded":true|false}',
  ].join("\n");

  const raw = await chatCompletion(
    system,
    `<context>
${context}
</context>

سؤال العميل:
${question}`,
    {
      json: true,
      maxTokens: 400,
    }
  );

  try {
    const jsonMatch = raw.match(
      /\{[\s\S]*\}/
    );

    if (!jsonMatch) {
      return {
        answer: "",
        grounded: false,
      };
    }

    const parsed = JSON.parse(
      jsonMatch[0]
    );

    const answer = String(
      parsed?.answer ?? ""
    ).trim();

    const grounded =
      parsed?.grounded === true;

    if (!answer || !grounded) {
      return {
        answer: "",
        grounded: false,
      };
    }

    return {
      answer,
      grounded: true,
    };
  } catch (error) {
    console.error(
      "[RAG] فشل تحليل جواب Gemini:",
      error
    );

    return {
      answer: "",
      grounded: false,
    };
  }
}

export type SemanticAnswerResult = {
  confident: boolean;
  bestSimilarity: number;
  threshold: number;
  matches: SemanticMatch[];
  answer: string | null;
};

/**
 * المسار الكامل:
 *
 * سؤال العميل
 * ↓
 * embedding
 * ↓
 * match_knowledge
 * ↓
 * similarity threshold
 * ↓
 * Gemini grounded answer
 */
export async function answerFromKnowledge(
  tenantId: string,
  businessName: string,
  text: string
): Promise<SemanticAnswerResult> {
  const threshold = config.ragThreshold;

  const { matches, best } =
    await semanticSearch(
      tenantId,
      text,
      config.ragTopK
    );

  /**
   * لا توجد معرفة مناسبة.
   */
  if (
    matches.length === 0 ||
    best < threshold
  ) {
    console.log(
      `[RAG] below threshold: best=${best} threshold=${threshold}`
    );

    return {
      confident: false,
      bestSimilarity: best,
      threshold,
      matches,
      answer: null,
    };
  }

  /**
   * إرسال أفضل النتائج فقط إلى Gemini.
   */
  const context = matches
    .map(
      (m, i) =>
        `[${i + 1}] ${m.content}`
    )
    .join("\n");

  const {
    answer,
    grounded,
  } =
    await generateGroundedAnswer(
      businessName,
      context,
      text
    );

  const confident =
    grounded && answer.length > 0;

  console.log(
    `[RAG] grounded=${grounded} confident=${confident}`
  );

  return {
    confident,
    bestSimilarity: best,
    threshold,
    matches,
    answer: confident
      ? answer
      : null,
  };
}
