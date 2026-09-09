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

export type QAPair = { question: string; answer: string };

// ═══════════════════════════════════════════════════════════════════════════════
// إعدادات اللهجات
// ═══════════════════════════════════════════════════════════════════════════════

export type Dialect = 
  | 'arabic_fusha'
  | 'arabic_iraqi'
  | 'arabic_saudi'
  | 'arabic_emirati'
  | 'arabic_kuwaiti'
  | 'arabic_qatari'
  | 'arabic_bahraini'
  | 'arabic_omani'
  | 'arabic_gulf'
  | 'english'
  | 'auto_detect';

export type Formality = 'formal' | 'natural' | 'casual';

const DIALECT_PROMPTS: Record<Dialect, string> = {
  arabic_fusha: "اكتب بالعربية الفصحى الواضحة",
  arabic_iraqi: "اكتب باللهجة العراقية الطبيعية، استخدم تعابير مثل 'شكد' بدل 'كم'، 'هسة' بدل 'الآن'",
  arabic_saudi: "اكتب باللهجة السعودية الطبيعية، استخدم تعابير مثل 'وش' بدل 'ما'، 'الحين' بدل 'الآن'",
  arabic_emirati: "اكتب باللهجة الإماراتية الطبيعية",
  arabic_kuwaiti: "اكتب باللهجة الكويتية الطبيعية",
  arabic_qatari: "اكتب باللهجة القطرية الطبيعية",
  arabic_bahraini: "اكتب باللهجة البحرينية الطبيعية",
  arabic_omani: "اكتب باللهجة العمانية الطبيعية",
  arabic_gulf: "اكتب باللهجة الخليجية الطبيعية",
  english: "Write in clear, natural English",
  auto_detect: "اكتب بنفس لغة ولهجة سؤال العميل"
};

const FORMALITY_PROMPTS: Record<Formality, string> = {
  formal: "استخدم أسلوب رسمي ومهذب",
  natural: "استخدم أسلوب طبيعي وودي",
  casual: "استخدم أسلوب عفوي وغير رسمي"
};

/** الحصول على إعدادات اللهجة للـ tenant */
async function getDialectSettings(tenantId: string): Promise<{ dialect: Dialect; formality: Formality }> {
  const { data } = await db
    .from("tenant_dialect_settings")
    .select("dialect, formality")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  
  return {
    dialect: (data?.dialect as Dialect) || 'arabic_saudi',
    formality: (data?.formality as Formality) || 'natural'
  };
}

/** اكتشاف لغة ولهجة النص */
async function detectLanguageDialect(text: string): Promise<Dialect> {
  // تحليل بسيط للكلمات الدالة
  const iraqiWords = ['شكد', 'هسة', 'شلون', 'مو'];
  const saudiWords = ['وش', 'الحين', 'ليش', 'طيب'];
  const emiratiWords = ['يشباب', 'زين', 'تدري'];
  
  let iraqiScore = 0, saudiScore = 0, emiratiScore = 0;
  
  for (const word of iraqiWords) {
    if (text.includes(word)) iraqiScore++;
  }
  for (const word of saudiWords) {
    if (text.includes(word)) saudiScore++;
  }
  for (const word of emiratiWords) {
    if (text.includes(word)) emiratiScore++;
  }
  
  if (iraqiScore > saudiScore && iraqiScore > emiratiScore) return 'arabic_iraqi';
  if (saudiScore > iraqiScore && saudiScore > emiratiScore) return 'arabic_saudi';
  if (emiratiScore > iraqiScore && emiratiScore > saudiScore) return 'arabic_emirati';
  
  // افتراضي: خليجي
  return 'arabic_gulf';
}

// ═══════════════════════════════════════════════════════════════════════════════
// توليد أسئلة وأجوبة من URL
// ═══════════════════════════════════════════════════════════════════════════════

const QA_SYSTEM = [
  "أنت محلل محتوى لنشاط تجاري. مهمتك توليد قائمة أسئلة وأجوبة تغطي ما قد يسأل عنه عميل حقيقي عبر واتساب.",
  "قواعد صارمة:",
  "1) الأسئلة بصيغة عميل حقيقي يسأل (قصيرة وبسيطة).",
  "2) الأجوبة من المحتوى المرفق فقط — لا تخترع أي سعر أو موعد أو معلومة غير موجودة فيه.",
  "3) غطِّ ما توفر من: الأسعار، أوقات العمل، الموقع والعنوان، الخدمات والمنتجات، التوصيل، طرق الدفع، الاسترجاع، التواصل.",
  "4) أعد من 5 إلى 12 زوجاً حسب غنى المحتوى.",
  '5) أعد مصفوفة JSON فقط بهذا الشكل: [{"question":"...","answer":"..."}] بدون أي نص خارجها.',
].join("\n");

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

/** حفظ أزواج Q&A */
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

// ═══════════════════════════════════════════════════════════════════════════════
// Hybrid Search (Vector + Full Text)
// ═══════════════════════════════════════════════════════════════════════════════

export type SemanticMatch = { 
  id: string; 
  content: string; 
  similarity: number;
  source_type: string;
};

/** بحث هجين يجمع بين Vector و Full Text */
export async function hybridSearch(
  tenantId: string,
  text: string,
  topK = config.ragTopK
): Promise<{ matches: SemanticMatch[]; best: number }> {
  const [qv] = await embed([text]);
  
  // استخدام الدالة الجديدة للبحث الهجين
  const { data: hits, error } = await db.rpc("hybrid_search_knowledge", {
    p_tenant_id: tenantId,
    p_query: toPgVector(qv),
    p_text_query: text,
    p_limit: topK,
    p_threshold: 0,
  });
  
  if (error) {
    // Fallback إلى البحث الدلالي العادي
    console.warn("Hybrid search failed, falling back to semantic search:", error.message);
    const { data: semanticHits } = await db.rpc("match_knowledge", {
      p_tenant_id: tenantId,
      p_query: toPgVector(qv),
      p_limit: topK,
      p_threshold: 0,
    });
    
    const matches = ((semanticHits ?? []) as any[]).map(h => ({
      id: h.id,
      content: h.content,
      similarity: Math.round(h.similarity * 1000) / 1000,
      source_type: 'vector'
    }));
    
    return { matches, best: matches[0]?.similarity ?? 0 };
  }
  
  const matches = ((hits ?? []) as any[]).map(h => ({
    id: h.id,
    content: h.content,
    similarity: Math.round(h.similarity * 1000) / 1000,
    source_type: h.source_type || 'hybrid'
  }));
  
  return { matches, best: matches[0]?.similarity ?? 0 };
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
  // الحصول على إعدادات اللهجة
  const { dialect, formality } = await getDialectSettings(tenantId);
  
  // اكتشاف اللهجة تلقائياً إذا لزم الأمر
  let effectiveDialect = dialect;
  if (dialect === 'auto_detect') {
    effectiveDialect = await detectLanguageDialect(question);
  }
  
  const dialectPrompt = DIALECT_PROMPTS[effectiveDialect];
  const formalityPrompt = FORMALITY_PROMPTS[formality];
  
  const system = [
    `أنت موظف خدمة عملاء ذكي لمشروع «${businessName}» يرد عبر واتساب.`,
    "",
    "## التعليمات الصارمة (لا يمكن كسرها):",
    "1) أجب بناءً على السياق المرفق فقط.",
    "2) ممنوع الاختراع أو التخمين إطلاقاً.",
    "3) إذا لم تجد الإجابة في السياق، قل صراحة: 'ما عندي معلومات مؤكدة عن هذا الموضوع'.",
    "4) لا تذكر أسعار أو مواعيد أو معلومات غير موجودة في السياق.",
    "5) إذا كان السؤال خارج نطاق السياق، اعتذر بلباقة.",
    "",
    `## أسلوب الرد:`,
    `- ${dialectPrompt}`,
    `- ${formalityPrompt}`,
    "",
    "## جودة الإجابة:",
    "- قصيرة ومباشرة (جملتان بحد أقصى)",
    "- طبيعية وغير روبوتية",
    "- لا تعيد السؤال",
    "- لا تكرر نفس المعلومة",
    "",
    'أعد JSON فقط: {"answer":"...","grounded":true|false}',
  ].join("\n");

  let userPrompt = `<context>\n${context}\n</context>\n\nسؤال العميل:\n${question}`;
  
  if (conversationHistory) {
    userPrompt = `<conversation_history>\n${conversationHistory}\n</conversation_history>\n\n${userPrompt}`;
  }

  const raw = await chatCompletion(
    system,
    userPrompt,
    { json: true }
  );
  
  try {
    const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    return { 
      answer: String(parsed.answer ?? "").trim(), 
      grounded: Boolean(parsed.grounded) 
    };
  } catch {
    return { answer: "", grounded: false };
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
  // بحث هجين
  const { matches, best } = await hybridSearch(tenantId, text);
  const threshold = config.ragThreshold;

  if (matches.length === 0 || best < threshold) {
    return { confident: false, bestSimilarity: best, threshold, matches, answer: null };
  }

  // بناء السياق
  const context = matches.map((m, i) => `[${i + 1}] ${m.content}`).join("\n");
  
  // توليد إجابة مع دعم اللهجة
  const { answer, grounded } = await generateGroundedAnswer(
    tenantId, 
    businessName, 
    context, 
    text,
    conversationHistory
  );
  
  const confident = grounded && answer.length > 0;
  return { 
    confident, 
    bestSimilarity: best, 
    threshold, 
    matches, 
    answer: confident ? answer : null 
  };
}
