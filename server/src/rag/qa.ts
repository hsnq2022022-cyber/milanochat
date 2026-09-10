/**
 * نظام RAG المتقدم:
 * - Hybrid Retrieval (Vector + Full Text)
 * - دعم اللهجات العربية
 * - منع الهلوسة
 * - جودة إجابة عالية
 */

import { config } from "../config.js";
import { db } from "../db.js";
import { chatCompletion, embed, toPgVector } from "../llm.js";
import { extractFromUrl, smartChunkText } from "./ingest.js";

export type QAPair = {
  question: string;
  answer: string;
};

// ═══════════════════════════════════════════════════════════════════════════════
// إعدادات اللهجات
// ═══════════════════════════════════════════════════════════════════════════════

export type Dialect =
  | "arabic_fusha"
  | "arabic_iraqi"
  | "arabic_saudi"
  | "arabic_emirati"
  | "arabic_kuwaiti"
  | "arabic_qatari"
  | "arabic_bahraini"
  | "arabic_omani"
  | "arabic_gulf"
  | "english"
  | "auto_detect";

export type Formality = "formal" | "natural" | "casual";

const DIALECT_PROMPTS: Record<Dialect, string> = {
  arabic_fusha: "اكتب بالعربية الفصحى الواضحة",
  arabic_iraqi:
    "اكتب باللهجة العراقية الطبيعية، استخدم تعابير عراقية عند الحاجة بدون مبالغة",
  arabic_saudi:
    "اكتب باللهجة السعودية الطبيعية، استخدم تعابير سعودية عند الحاجة بدون مبالغة",
  arabic_emirati: "اكتب باللهجة الإماراتية الطبيعية",
  arabic_kuwaiti: "اكتب باللهجة الكويتية الطبيعية",
  arabic_qatari: "اكتب باللهجة القطرية الطبيعية",
  arabic_bahraini: "اكتب باللهجة البحرينية الطبيعية",
  arabic_omani: "اكتب باللهجة العمانية الطبيعية",
  arabic_gulf: "اكتب باللهجة الخليجية الطبيعية",
  english: "Write in clear, natural English",
  auto_detect: "اكتب بنفس لغة ولهجة سؤال العميل",
};

const FORMALITY_PROMPTS: Record<Formality, string> = {
  formal: "استخدم أسلوب رسمي ومهذب",
  natural: "استخدم أسلوب طبيعي وودي",
  casual: "استخدم أسلوب عفوي وغير رسمي",
};

/** الحصول على إعدادات اللهجة للـ tenant */
async function getDialectSettings(
  tenantId: string
): Promise<{ dialect: Dialect; formality: Formality }> {
  const { data, error } = await db
    .from("tenant_dialect_settings")
    .select("dialect, formality")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (error) {
    console.warn(
      "[RAG] dialect settings lookup failed:",
      error.message
    );
  }

  return {
    dialect: (data?.dialect as Dialect) || "arabic_saudi",
    formality: (data?.formality as Formality) || "natural",
  };
}

/** اكتشاف لغة ولهجة النص */
async function detectLanguageDialect(text: string): Promise<Dialect> {
  const iraqiWords = ["شكد", "هسة", "شلون", "مو", "وين", "أكو", "ماكو"];
  const saudiWords = ["وش", "الحين", "ليش", "طيب", "وين", "أبغى"];
  const emiratiWords = ["يشباب", "زين", "تدري"];

  let iraqiScore = 0;
  let saudiScore = 0;
  let emiratiScore = 0;

  for (const word of iraqiWords) {
    if (text.includes(word)) iraqiScore++;
  }

  for (const word of saudiWords) {
    if (text.includes(word)) saudiScore++;
  }

  for (const word of emiratiWords) {
    if (text.includes(word)) emiratiScore++;
  }

  if (iraqiScore > saudiScore && iraqiScore > emiratiScore) {
    return "arabic_iraqi";
  }

  if (saudiScore > iraqiScore && saudiScore > emiratiScore) {
    return "arabic_saudi";
  }

  if (emiratiScore > iraqiScore && emiratiScore > saudiScore) {
    return "arabic_emirati";
  }

  return "arabic_gulf";
}

// ═══════════════════════════════════════════════════════════════════════════════
// توليد أسئلة وأجوبة من URL
// ═══════════════════════════════════════════════════════════════════════════════

const QA_SYSTEM = [
  "أنت محلل محتوى لنشاط تجاري.",
  "أنشئ أسئلة وأجوبة اعتمادًا على المحتوى المرفق فقط.",
  "ممنوع اختراع أي معلومات غير موجودة في المحتوى.",
  "حافظ على الأرقام والأسعار وأسماء المنتجات والروابط كما هي.",
  'أعد JSON فقط بهذا الشكل: [{"question":"...","answer":"..."}]',
].join("\n");

export async function extractQAPairs(
  url: string
): Promise<{ pairs: QAPair[]; title: string }> {
  const { text, title } = await extractFromUrl(url);

  if (text.length < 40) {
    throw new Error("تعذر استخراج محتوى كافٍ من الصفحة");
  }

  const raw = await chatCompletion(
    QA_SYSTEM,
    `عنوان الصفحة: ${title}\n\nالمحتوى:\n${text.slice(0, 9000)}`,
    {
      json: true,
      maxTokens: 2200,
    }
  );

  const cleaned = raw
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const match = cleaned.match(/\[[\s\S]*\]/);

  if (!match) {
    throw new Error("لم نتمكن من فهم النتيجة المولدة");
  }

  let list: unknown;

  try {
    list = JSON.parse(match[0]);
  } catch {
    throw new Error("تعذر تحليل النتيجة المولدة");
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
    throw new Error("لم نستخرج أسئلة وأجوبة مفيدة من المحتوى");
  }

  return {
    pairs,
    title,
  };
}

export async function saveQAPairs(
  tenantId: string,
  pairs: QAPair[],
  sourceUrl: string | null
): Promise<{ saved: number; sourceId: string }> {
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
      status: "indexed",
      chunks_count: valid.length,
    })
    .select()
    .single();

  if (srcErr || !source) {
    throw new Error(
      "تعذر إنشاء سجل المصدر: " +
        (srcErr?.message ?? "خطأ غير معروف")
    );
  }

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

  return {
    saved: valid.length,
    sourceId: source.id,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Hybrid Search (Vector + Full Text)
// ═══════════════════════════════════════════════════════════════════════════════

export type SemanticMatch = {
  id: string;
  content: string;
  similarity: number;
  source_type?: string;
};

/**
 * البحث الدلالي باستخدام match_knowledge.
 *
 * هذا هو fallback الأساسي إذا لم تكن دالة البحث الهجين
 * موجودة أو فشلت.
 */
export async function semanticSearch(
  tenantId: string,
  text: string,
  topK = config.ragTopK
): Promise<{
  matches: SemanticMatch[];
  best: number;
}> {
  console.log(
    `[RAG] semantic search tenant=${tenantId} text="${text}"`
  );

  const [qv] = await embed([text]);

  if (!qv) {
    throw new Error("[RAG] فشل إنشاء embedding");
  }

  console.log(
    `[RAG] query embedding dimension=${qv.length}`
  );

  if (qv.length !== 3072) {
    throw new Error(
      `[RAG] embedding dimension غير صحيح: ${qv.length}`
    );
  }

  const { data: hits, error } = await db.rpc(
    "match_knowledge",
    {
      p_tenant_id: tenantId,
      p_query: toPgVector(qv),
      p_limit: topK,
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
        typeof h.similarity === "number"
    )
    .map((h) => ({
      id: h.id,
      content: h.content,
      similarity:
        Math.round(h.similarity * 1000) / 1000,
      source_type: "vector",
    }));

  const best = matches[0]?.similarity ?? 0;

  console.log(
    `[RAG] semantic matches=${matches.length} best=${best}`
  );

  for (let i = 0; i < matches.length; i++) {
    console.log(
      `[RAG] chunk ${i + 1} similarity=${matches[i].similarity} content="${matches[i].content.slice(0, 700)}"`
    );
  }

  return {
    matches,
    best,
  };
}

/** بحث هجين يجمع بين Vector و Full Text */
export async function hybridSearch(
  tenantId: string,
  text: string,
  topK = config.ragTopK
): Promise<{
  matches: SemanticMatch[];
  best: number;
}> {
  console.log(
    `[RAG] hybrid search tenant=${tenantId} text="${text}"`
  );

  const [qv] = await embed([text]);

  if (!qv) {
    throw new Error("[RAG] فشل إنشاء embedding");
  }

  console.log(
    `[RAG] query embedding dimension=${qv.length}`
  );

  if (qv.length !== 3072) {
    throw new Error(
      `[RAG] embedding dimension غير صحيح: ${qv.length}`
    );
  }

  const { data: hits, error } = await db.rpc(
    "hybrid_search_knowledge",
    {
      p_tenant_id: tenantId,
      p_query: toPgVector(qv),
      p_text_query: text,
      p_limit: topK,
      p_threshold: 0,
    }
  );

  if (error) {
    console.warn(
      "[RAG] Hybrid search failed, falling back to semantic search:",
      error.message
    );

    return semanticSearch(tenantId, text, topK);
  }

  const matches = ((hits ?? []) as any[])
    .filter(
      (h) =>
        h &&
        typeof h.content === "string" &&
        typeof h.similarity === "number"
    )
    .map((h) => ({
      id: h.id,
      content: h.content,
      similarity:
        Math.round(h.similarity * 1000) / 1000,
      source_type: h.source_type || "hybrid",
    }));

  const best = matches[0]?.similarity ?? 0;

  console.log(
    `[RAG] hybrid matches=${matches.length} best=${best}`
  );

  for (let i = 0; i < matches.length; i++) {
    console.log(
      `[RAG] hybrid chunk ${i + 1} similarity=${matches[i].similarity} content="${matches[i].content.slice(0, 700)}"`
    );
  }

  return {
    matches,
    best,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// توليد إجابة مع دعم اللهجات
// ═══════════════════════════════════════════════════════════════════════════════

/** توليد رد مُقيّد بالسياق مع دعم اللهجات */
export async function generateGroundedAnswer(
  tenantId: string,
  businessName: string,
  context: string,
  question: string,
  conversationHistory?: string
): Promise<{ answer: string; grounded: boolean }> {
  const { dialect, formality } =
    await getDialectSettings(tenantId);

  let effectiveDialect = dialect;

  if (dialect === "auto_detect") {
    effectiveDialect =
      await detectLanguageDialect(question);
  }

  const dialectPrompt =
    DIALECT_PROMPTS[effectiveDialect] ||
    DIALECT_PROMPTS.arabic_fusha;

  const formalityPrompt =
    FORMALITY_PROMPTS[formality] ||
    FORMALITY_PROMPTS.natural;

  const system = [
    `أنت موظف خدمة عملاء ذكي لمشروع «${businessName}» يرد عبر واتساب.`,
    "",
    "## الأولوية القصوى: دقة المعلومات",
    "1) أجب بناءً على السياق المرفق فقط.",
    "2) ممنوع الاختراع أو التخمين إطلاقاً.",
    "3) إذا لم تجد الإجابة في السياق، اجعل grounded=false ولا تخترع إجابة.",
    "4) لا تذكر أسعار أو مواعيد أو معلومات غير موجودة في السياق.",
    "5) حافظ على الأرقام والأسعار وأسماء المنتجات والروابط كما وردت في السياق.",
    "6) لا تغيّر معنى المعلومة عند تحويلها إلى اللهجة المطلوبة.",
    "",
    "## أسلوب الرد:",
    `- ${dialectPrompt}`,
    `- ${formalityPrompt}`,
    "- استخدم اللهجة بصورة طبيعية وغير مبالغ فيها.",
    "- لا تجعل تغيير اللهجة يغيّر الحقائق أو الأرقام.",
    "",
    "## جودة الإجابة:",
    "- قصيرة ومباشرة ومناسبة لواتساب.",
    "- طبيعية وغير روبوتية.",
    "- لا تعيد السؤال.",
    "- لا تكرر نفس المعلومة.",
    "",
    'أعد JSON فقط: {"answer":"...","grounded":true|false}',
  ].join("\n");

  let userPrompt =
    `<context>\n${context}\n</context>\n\n` +
    `سؤال العميل:\n${question}`;

  if (conversationHistory?.trim()) {
    userPrompt =
      `<conversation_history>\n${conversationHistory}\n</conversation_history>\n\n` +
      userPrompt;
  }

  console.log(
    `[RAG] generating grounded answer question="${question}"`
  );

  const raw = await chatCompletion(
    system,
    userPrompt,
    {
      json: true,
      maxTokens: 600,
    }
  );

  console.log(
    `[RAG] grounded raw response=${raw.slice(0, 1500)}`
  );

  try {
    const match = raw.match(/\{[\s\S]*\}/);

    if (!match) {
      console.log("[RAG] no JSON object returned");

      return {
        answer: "",
        grounded: false,
      };
    }

    const parsed = JSON.parse(match[0]);

    const answer =
      typeof parsed.answer === "string"
        ? parsed.answer.trim()
        : "";

    const grounded =
      parsed.grounded === true &&
      answer.length > 0;

    console.log(
      `[RAG] parsed grounded=${grounded} answer="${answer.slice(0, 700)}"`
    );

    return {
      answer,
      grounded,
    };
  } catch (error) {
    console.log(
      "[RAG] JSON parsing failed:",
      error
    );

    return {
      answer: "",
      grounded: false,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// المسار الكامل للإجابة
// ═══════════════════════════════════════════════════════════════════════════════

export type SemanticAnswerResult = {
  confident: boolean;
  bestSimilarity: number;
  threshold: number;
  matches: SemanticMatch[];
  answer: string | null;
};

/** المسار الكامل: بحث هجين ← فحص العتبة ← توليد مُقيّد باللهجة */
export async function answerFromKnowledge(
  tenantId: string,
  businessName: string,
  text: string,
  conversationHistory?: string
): Promise<SemanticAnswerResult> {
  const { matches, best } =
    await hybridSearch(
      tenantId,
      text
    );

  const threshold =
    config.ragThreshold;

  console.log(
    `[RAG] threshold=${threshold} best=${best}`
  );

  if (
    matches.length === 0 ||
    best < threshold
  ) {
    console.log(
      `[RAG] below threshold best=${best} threshold=${threshold}`
    );

    return {
      confident: false,
      bestSimilarity: best,
      threshold,
      matches,
      answer: null,
    };
  }

  const context = matches
    .map(
      (m, i) =>
        `[المعلومة ${i + 1}]\n${m.content}`
    )
    .join("\n\n");

  console.log(
    `[RAG] context length=${context.length}`
  );

  const result =
    await generateGroundedAnswer(
      tenantId,
      businessName,
      context,
      text,
      conversationHistory
    );

  const confident =
    result.grounded &&
    result.answer.length > 0;

  console.log(
    `[RAG] grounded=${result.grounded} confident=${confident}`
  );

  return {
    confident,
    bestSimilarity: best,
    threshold,
    matches,
    answer: confident
      ? result.answer
      : null,
  };
}
