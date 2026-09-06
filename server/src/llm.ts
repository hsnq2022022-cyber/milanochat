/**
 * qa.ts
 *
 * - توليد أسئلة وأجوبة من رابط الموقع
 * - حفظ Q&A في قاعدة المعرفة
 * - البحث الدلالي RAG عبر match_knowledge
 * - توليد إجابة مبنية على المعرفة فقط
 */

import { config } from "./config.js";
import { db } from "../db.js";
import { chatCompletion, embed, toPgVector } from "../llm.js";
import { extractFromUrl } from "./ingest.js";

export type QAPair = {
  question: string;
  answer: string;
};

const QA_SYSTEM = [
  "أنت محلل محتوى لنشاط تجاري. مهمتك توليد قائمة أسئلة وأجوبة تغطي ما قد يسأل عنه عميل حقيقي عبر واتساب.",
  "قواعد صارمة:",
  "1) الأسئلة بصيغة عميل حقيقي يسأل (قصيرة وبسيطة).",
  "2) الأجوبة من المحتوى المرفق فقط — لا تخترع أي سعر أو موعد أو معلومة غير موجودة فيه.",
  "3) غطِّ ما توفر من: الأسعار، أوقات العمل، الموقع والعنوان، الخدمات والمنتجات، التوصيل، طرق الدفع، الاسترجاع، التواصل.",
  "4) أعد من 5 إلى 12 زوجاً حسب غنى المحتوى.",
  '5) أعد مصفوفة JSON فقط بهذا الشكل: [{"question":"...","answer":"..."}] بدون أي نص خارجها.',
].join("\n");

/* ═══════════════════════════════════════════════════════════════
   الميزة 2: توليد Q&A من الموقع
   ═══════════════════════════════════════════════════════════════ */

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
    `عنوان الصفحة: ${title}\n\nالمحتوى:\n${text.slice(0, 9000)}`,
    {
      json: true,
      maxTokens: 2200,
    }
  );

  const cleaned = raw.replace(/```(?:json)?/g, "").trim();

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

/* ═══════════════════════════════════════════════════════════════
   حفظ Q&A في قاعدة المعرفة
   ═══════════════════════════════════════════════════════════════ */

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

  const rows = texts.map((content, i) => {
    const vector = vectors[i];

    if (!vector || vector.length === 0) {
      throw new Error(
        `[RAG] embedding فارغ للقطعة رقم ${i}`
      );
    }

    return {
      tenant_id: tenantId,
      source_id: source.id,
      chunk_index: i,
      content,
      embedding: toPgVector(vector),
    };
  });

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

/* ═══════════════════════════════════════════════════════════════
   الميزة 3: البحث الدلالي RAG
   ═══════════════════════════════════════════════════════════════ */

export type SemanticMatch = {
  id: string;
  content: string;
  similarity: number;
};

export async function semanticSearch(
  tenantId: string,
  text: string,
  topK = config.ragTopK
): Promise<{
  matches: SemanticMatch[];
  best: number;
}> {
  console.log("========================================");
  console.log("[RAG] semanticSearch START");
  console.log("[RAG] tenantId:", tenantId);
  console.log("[RAG] question:", text);
  console.log("[RAG] topK:", topK);
  console.log("========================================");

  /* ---------------------------------------
     1. إنشاء embedding لسؤال العميل
     --------------------------------------- */

  console.log("[RAG] generating query embedding...");

  const [qv] = await embed([text]);

  if (!qv) {
    throw new Error(
      "[RAG] لم يتم إنشاء query embedding"
    );
  }

  console.log(
    "[RAG] query embedding dimensions:",
    qv.length
  );

  /* ---------------------------------------
     2. التأكد من البعد المتوقع
     --------------------------------------- */

  const expectedDim = Number(
    config.embed.dim ?? 3072
  );

  console.log(
    "[RAG] configured embedding dimensions:",
    expectedDim
  );

  if (qv.length !== expectedDim) {
    throw new Error(
      `[RAG] أبعاد query embedding غير صحيحة: ${qv.length}. المتوقع: ${expectedDim}`
    );
  }

  /* ---------------------------------------
     3. تحويل embedding إلى pgvector
     --------------------------------------- */

  const pgVector = toPgVector(qv);

  console.log(
    "[RAG] pgvector created successfully"
  );

  /* ---------------------------------------
     4. استدعاء match_knowledge
     --------------------------------------- */

  const threshold = config.ragThreshold;

  console.log("[RAG] calling match_knowledge...");
  console.log("[RAG] threshold:", threshold);
  console.log("[RAG] limit:", topK);

  const { data: hits, error } = await db.rpc(
    "match_knowledge",
    {
      p_tenant_id: tenantId,
      p_query: pgVector,
      p_limit: topK,
      p_threshold: 0,
    }
  );

  /* ---------------------------------------
     5. فحص نتيجة RPC
     --------------------------------------- */

  if (error) {
    console.error(
      "[RAG] match_knowledge ERROR:",
      error
    );

    throw new Error(
      "فشل البحث الدلالي: " +
        error.message
    );
  }

  console.log(
    "[RAG] match_knowledge returned:",
    hits?.length ?? 0,
    "rows"
  );

  if (hits && hits.length > 0) {
    console.log(
      "[RAG] similarities:",
      hits.map((h: any) => h.similarity)
    );
  }

  /* ---------------------------------------
     6. تجهيز النتائج
     --------------------------------------- */

  const matches = (
    (hits ?? []) as {
      id: string;
      content: string;
      similarity: number;
    }[]
  ).map((h) => ({
    id: h.id,
    content: h.content,
    similarity:
      Math.round(
        Number(h.similarity) * 1000
      ) / 1000,
  }));

  const best =
    matches[0]?.similarity ?? 0;

  console.log("[RAG] best similarity:", best);
  console.log("[RAG] threshold:", threshold);
  console.log(
    "[RAG] confident candidate:",
    best >= threshold
  );

  console.log("========================================");
  console.log("[RAG] semanticSearch END");
  console.log("========================================");

  return {
    matches,
    best,
  };
}

/* ═══════════════════════════════════════════════════════════════
   توليد إجابة مبنية على المعرفة
   ═══════════════════════════════════════════════════════════════ */

export async function generateGroundedAnswer(
  businessName: string,
  context: string,
  question: string
): Promise<{
  answer: string;
  grounded: boolean;
}> {
  console.log("[RAG] generating grounded answer...");
  console.log(
    "[RAG] context length:",
    context.length
  );

  const system = [
    `أنت موظف خدمة عملاء لمشروع «${businessName}» يرد عبر واتساب.`,
    "التعليمات الصارمة:",
    "أجب بناءً على السياق المرفق فقط، وبنفس لهجة وأسلوب المحتوى المتوفر.",
    "إذا لم تجد إجابة كافية في السياق، قل صراحة إنك غير متأكد ولا تختلق معلومة.",
    "ممنوع التخمين: لا أسعار ولا مواعيد ولا عناوين غير موجودة نصًا في السياق.",
    "الرد قصير (جملتان بحد أقصى) بلهجة سعودية مهذبة.",
    'أعد JSON فقط: {"answer":"...","grounded":true|false}',
  ].join("\n");

  const raw = await chatCompletion(
    system,
    `<context>\n${context}\n</context>\n\nسؤال العميل:\n${question}`,
    {
      json: true,
    }
  );

  console.log(
    "[RAG] Gemini answer received"
  );

  try {
    const jsonMatch =
      raw.match(/\{[\s\S]*\}/);

    const parsed = JSON.parse(
      jsonMatch?.[0] ?? "{}"
    );

    const answer = String(
      parsed.answer ?? ""
    ).trim();

    const grounded =
      Boolean(parsed.grounded);

    console.log(
      "[RAG] grounded:",
      grounded
    );

    console.log(
      "[RAG] answer length:",
      answer.length
    );

    return {
      answer,
      grounded,
    };
  } catch (error) {
    console.error(
      "[RAG] failed to parse grounded answer:",
      error
    );

    return {
      answer: "",
      grounded: false,
    };
  }
}

/* ═══════════════════════════════════════════════════════════════
   الإجابة النهائية من قاعدة المعرفة
   ═══════════════════════════════════════════════════════════════ */

export type SemanticAnswerResult = {
  confident: boolean;
  bestSimilarity: number;
  threshold: number;
  matches: SemanticMatch[];
  answer: string | null;
};

export async function answerFromKnowledge(
  tenantId: string,
  businessName: string,
  text: string
): Promise<SemanticAnswerResult> {
  console.log("########################################");
  console.log("[RAG] answerFromKnowledge START");
  console.log("[RAG] tenant:", tenantId);
  console.log("[RAG] business:", businessName);
  console.log("[RAG] question:", text);
  console.log("########################################");

  /* ---------------------------------------
     البحث في قاعدة المعرفة
     --------------------------------------- */

  const { matches, best } =
    await semanticSearch(
      tenantId,
      text
    );

  const threshold =
    config.ragThreshold;

  console.log(
    "[RAG] search completed. matches:",
    matches.length
  );

  console.log(
    "[RAG] best similarity:",
    best
  );

  console.log(
    "[RAG] required threshold:",
    threshold
  );

  /* ---------------------------------------
     لا توجد مطابقة قوية
     --------------------------------------- */

  if (
    matches.length === 0 ||
    best < threshold
  ) {
    console.log(
      "[RAG] NO CONFIDENT MATCH"
    );

    console.log(
      "[RAG] answerFromKnowledge END"
    );

    return {
      confident: false,
      bestSimilarity: best,
      threshold,
      matches,
      answer: null,
    };
  }

  /* ---------------------------------------
     بناء السياق من أفضل النتائج
     --------------------------------------- */

  const context = matches
    .map(
      (m, i) =>
        `[${i + 1}] ${m.content}`
    )
    .join("\n");

  console.log(
    "[RAG] context prepared"
  );

  console.log(
    "[RAG] sending context to Gemini..."
  );

  /* ---------------------------------------
     توليد الإجابة
     --------------------------------------- */

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
    grounded &&
    answer.length > 0;

  console.log(
    "[RAG] grounded:",
    grounded
  );

  console.log(
    "[RAG] answer exists:",
    answer.length > 0
  );

  console.log(
    "[RAG] FINAL confident:",
    confident
  );

  console.log(
    "[RAG] answerFromKnowledge END"
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
