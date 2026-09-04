/**
 * الميزة 2: توليد أسئلة وأجوبة تلقائياً من رابط الموقع
 * جلب الصفحة (من السيرفر لتفادي CORS) → استخراج النص المفيد (cheerio) →
 * توليد أزواج Q&A عبر LLM → تُعرض على المالك للمراجعة قبل الحفظ النهائي.
 * عند الحفظ: كل زوج يصبح قطعة معرفة مستقلة بـ embedding مرتبطة بالعميل.
 */
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
