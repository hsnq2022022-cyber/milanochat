/**
 * الميزة 2: توليد أسئلة وأجوبة تلقائياً من رابط الموقع
 * جلب الصفحة (من السيرفر لتفادي CORS) → استخراج النص المفيد (cheerio) →
 * توليد أزواج Q&A عبر LLM → تُعرض على المالك للمراجعة قبل الحفظ النهائي.
 * عند الحفظ: كل زوج يصبح قطعة معرفة مستقلة بـ embedding مرتبطة بالعميل.
 */
import { config } from "../config.js";
import { db } from "../db.js";
import { chatCompletion, embed, toPgVector } from "../llm.js";
import { extractFromUrl } from "./ingest.js";

export type QAPair = { question: string; answer: string };

const QA_SYSTEM = [
  "أنت محلل محتوى لنشاط تجاري. مهمتك توليد قائمة أسئلة وأجوبة تغطي ما قد يسأل عنه عميل حقيقي عبر واتساب.",
  "قواعد صارمة:",
  "1) الأسئلة بصيغة عميل حقيقي يسأل (قصيرة وبسيطة).",
  "2) الأجوبة من المحتوى المرفق فقط — لا تخترع أي سعر أو موعد أو معلومة غير موجودة فيه.",
  "3) غطِّ ما توفر من: الأسعار، أوقات العمل، الموقع والعنوان، الخدمات والمنتجات، التوصيل، طرق الدفع، الاسترجاع، التواصل.",
  "4) أعد من 5 إلى 12 زوجاً حسب غنى المحتوى.",
  '5) أعد مصفوفة JSON فقط بهذا الشكل: [{"question":"...","answer":"..."}] بدون أي نص خارجها.',
].join("\n");

/** جلب الصفحة + استخراج النص + توليد أزواج Q&A */
export async function extractQAPairs(url: string): Promise<{ pairs: QAPair[]; title: string }> {
  const { text, title } = await extractFromUrl(url);
  if (text.length < 40) {
    throw new Error("تعذر استخراج محتوى كافٍ من الصفحة — تأكد من الرابط أو أدخلها يدوياً");
  }

  const raw = await chatCompletion(
    QA_SYSTEM,
    `عنوان الصفحة: ${title}\n\nالمحتوى:\n${text.slice(0, 9000)}`,
    { json: true, maxTokens: 2200 }
  );

  const cleaned = raw.replace(/```(?:json)?/g, "").trim();
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("لم نتمكن من فهم النتيجة المولدة — أعد المحاولة");

  let list: unknown;
  try {
    list = JSON.parse(match[0]);
  } catch {
    throw new Error("تعذر تحليل النتيجة المولدة — أعد المحاولة");
  }

  const pairs = (Array.isArray(list) ? list : [])
    .filter((p: any) => p && typeof p.question === "string" && typeof p.answer === "string")
    .map((p: any) => ({ question: p.question.trim(), answer: p.answer.trim() }))
    .filter((p: QAPair) => p.question.length > 0 && p.answer.length > 0)
    .slice(0, 20);

  if (pairs.length === 0) {
    throw new Error("لم نستخرج أسئلة وأجوبة مفيدة من المحتوى — جرّب رابطاً آخر أو أدخلها يدوياً");
  }
  return { pairs, title };
}

/**
 * الحفظ النهائي: الأزواج المراجَعة تصبح قاعدة المعرفة الفعلية.
 * كل زوج يُخزَّن كقطعة مستقلة (سؤال + جواب) مع متجه دلالي.
 */
export async function saveQAPairs(
  tenantId: string,
  pairs: QAPair[],
  sourceUrl: string | null
): Promise<{ saved: number; sourceId: string }> {
  const valid = pairs
    .map((p) => ({ question: p.question.trim(), answer: p.answer.trim() }))
    .filter((p) => p.question.length > 0 && p.answer.length > 0);
  if (valid.length === 0) throw new Error("لا توجد أسئلة صالحة للحفظ");

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
  if (srcErr || !source) throw new Error("تعذر إنشاء سجل المصدر: " + srcErr?.message);

  const texts = valid.map((p) => `س: ${p.question}\nج: ${p.answer}`);
  const vectors = await embed(texts);

  const rows = texts.map((content, i) => ({
    tenant_id: tenantId,
    source_id: source.id,
    chunk_index: i,
    content,
    embedding: toPgVector(vectors[i]),
  }));

  const { error: insErr } = await db.from("knowledge_chunks").insert(rows);
  if (insErr) throw new Error("تعذر حفظ الأسئلة والأجوبة: " + insErr.message);

  return { saved: valid.length, sourceId: source.id };
}

/* ═══════════ الميزة 3: الفهم الدلالي (RAG) — طبقة مشتركة ═══════════ */

export type SemanticMatch = { id: string; content: string; similarity: number };

/**
 * بحث دلالي بالتشابه (cosine) داخل قاعدة معرفة عميل واحد فقط.
 * p_threshold = 0 يسترجع النتائج مرتبة بدرجاتها الخام،
 * وحد الثقة (القابل للتعديل من env) يُطبَّق في طبقة التطبيق.
 */
export async function semanticSearch(
  tenantId: string,
  text: string,
  topK = config.ragTopK
): Promise<{ matches: SemanticMatch[]; best: number }> {
  const [qv] = await embed([text]);
  const { data: hits, error } = await db.rpc("match_knowledge", {
    p_tenant_id: tenantId,
    p_query: toPgVector(qv),
    p_limit: topK,
    p_threshold: 0,
  });
  if (error) throw new Error("فشل البحث الدلالي: " + error.message);
  const matches = ((hits ?? []) as { id: string; content: string; similarity: number }[]).map(
    (h) => ({ id: h.id, content: h.content, similarity: Math.round(h.similarity * 1000) / 1000 })
  );
  return { matches, best: matches[0]?.similarity ?? 0 };
}

/** توليد رد مُقيّد بالسياق المسترجع — لا معلومة خارجه إطلاقًا */
export async function generateGroundedAnswer(
  businessName: string,
  context: string,
  question: string
): Promise<{ answer: string; grounded: boolean }> {
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
    { json: true }
  );
  try {
    const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    return { answer: String(parsed.answer ?? "").trim(), grounded: Boolean(parsed.grounded) };
  } catch {
    return { answer: "", grounded: false };
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
 * المسار الدلالي الكامل: استرجاع ← فحص العتبة ← توليد مُقيّد.
 * دون حد الثقة: بدون استدعاء LLM وبدون إجابة (يُسجَّل السؤال عالقًا).
 */
export async function answerFromKnowledge(
  tenantId: string,
  businessName: string,
  text: string
): Promise<SemanticAnswerResult> {
  const { matches, best } = await semanticSearch(tenantId, text);
  const threshold = config.ragThreshold;

  if (matches.length === 0 || best < threshold) {
    return { confident: false, bestSimilarity: best, threshold, matches, answer: null };
  }

  const context = matches.map((m, i) => `[${i + 1}] ${m.content}`).join("\n");
  const { answer, grounded } = await generateGroundedAnswer(businessName, context, text);
  const confident = grounded && answer.length > 0;
  return { confident, bestSimilarity: best, threshold, matches, answer: confident ? answer : null };
}
