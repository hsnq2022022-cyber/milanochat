````ts
import { config } from "../config.js";
import { db } from "../db.js";
import { chatCompletion, embed, toPgVector } from "../llm.js";
import { extractFromUrl } from "./ingest.js";

export type QAPair = {
  question: string;
  answer: string;
};

const QA_SYSTEM = [
  "أنت محلل محتوى لنشاط تجاري.",
  "مهمتك توليد قائمة أسئلة وأجوبة تغطي ما قد يسأل عنه عميل حقيقي عبر واتساب.",
  "",
  "قواعد صارمة:",
  "1) الأسئلة بصيغة عميل حقيقي يسأل، قصيرة وبسيطة.",
  "2) الأجوبة من المحتوى المرفق فقط.",
  "3) ممنوع اختراع أي سعر أو موعد أو عنوان أو سياسة أو معلومة غير موجودة في المحتوى.",
  "4) غطِّ ما توفر من الأسعار، أوقات العمل، الموقع والعنوان، الخدمات والمنتجات، التوصيل، الدفع، الاسترجاع والتواصل.",
  "5) أعد من 5 إلى 12 زوجًا حسب غنى المحتوى.",
  '6) أعد JSON فقط بهذا الشكل: [{"question":"...","answer":"..."}]',
].join("\n");

/* =========================================================
   استخراج Q&A من رابط
   ========================================================= */

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

  const cleaned = raw
    .replace(/```json/gi, "")
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

/* =========================================================
   حفظ Q&A في قاعدة المعرفة
   ========================================================= */

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

/* =========================================================
   RAG - البحث الدلالي
   ========================================================= */

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
  console.log(
    `[RAG] semantic search tenant=${tenantId} text="${text}"`
  );

  const [qv] = await embed([text]);

  console.log(
    `[RAG] query embedding dimension=${qv.length}`
  );

  if (!qv || qv.length !== 3072) {
    throw new Error(
      `[RAG] embedding dimension غير صحيح: ${qv?.length ?? 0}`
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
    }));

  const best = matches[0]?.similarity ?? 0;

  console.log(
    `[RAG] matches=${matches.length} best=${best}`
  );

  /*
   * مهم جدًا للتشخيص:
   * نسجل محتوى النتائج التي اختارها البحث.
   *
   * لا نطبع كامل المحتوى حتى لا تصبح Logs ضخمة.
   */
  if (matches.length > 0) {
    console.log(
      "[RAG] retrieved chunks:",
      matches.map((m, i) => ({
        index: i + 1,
        similarity: m.similarity,
        content: m.content.slice(0, 700),
      }))
    );
  } else {
    console.log("[RAG] no chunks retrieved");
  }

  return {
    matches,
    best,
  };
}

/* =========================================================
   توليد إجابة مبنية على المعرفة
   ========================================================= */

export async function generateGroundedAnswer(
  businessName: string,
  context: string,
  question: string
): Promise<{
  answer: string;
  grounded: boolean;
}> {
  const system = [
    `أنت موظف خدمة عملاء لمشروع «${businessName}» يرد عبر واتساب.`,
    "",
    "أنت لا تملك أي معلومات عن المشروع خارج <context>.",
    "المعلومات الموجودة داخل <context> هي المصدر الوحيد المسموح لك باستخدامه.",
    "",
    "القواعد الإلزامية:",
    "1) أجب عن سؤال العميل باستخدام المعلومات الموجودة في <context> فقط.",
    "2) لا تستخدم معرفتك العامة ولا معلومات سابقة ولا تخمينات.",
    "3) إذا كانت الإجابة موجودة بشكل مباشر أو يمكن استخلاصها بوضوح من context، أجب عنها.",
    "4) إذا كانت المعلومات الموجودة في context غير كافية للإجابة، اجعل grounded=false.",
    "5) لا تجعل grounded=false لمجرد أن السؤال ليس مطابقًا حرفيًا للنص؛ استخدم المعنى والسياق.",
    "6) إذا كان السؤال عن شروط الشراء وكانت الشروط موجودة في context، يجب الإجابة عنها مباشرة.",
    "7) لا تضف أسعارًا أو شروطًا أو مواعيد أو سياسات غير موجودة في context.",
    "8) الرد قصير ومناسب لواتساب.",
    "9) استخدم العربية وبلهجة عراقية/عربية طبيعية ومهذبة.",
    "10) grounded=true فقط عندما تستطيع دعم الإجابة من context.",
    "",
    'أعد JSON صالحًا فقط بهذا الشكل: {"answer":"...","grounded":true}',
    'أو عند عدم توفر الإجابة: {"answer":"لا أملك معلومات مؤكدة عن ذلك من مصادر المعرفة.","grounded":false}',
  ].join("\n");

  const userPrompt = [
    "<context>",
    context,
    "</context>",
    "",
    "<customer_question>",
    question,
    "</customer_question>",
    "",
    "أجب الآن اعتمادًا على context فقط.",
  ].join("\n");

  console.log(
    `[RAG] generating grounded answer question="${question}"`
  );

  const raw = await chatCompletion(
    system,
    userPrompt,
    {
      json: true,
      maxTokens: 500,
    }
  );

  console.log(
    `[RAG] grounded raw response=${raw.slice(0, 1000)}`
  );

  /*
   * نحاول استخراج JSON حتى لو أعاد الموديل
   * مسافات أو تغليفًا غير ضروري.
   */
  const jsonMatch = raw.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    console.log(
      "[RAG] grounded JSON parsing failed: no JSON object"
    );

    return {
      answer: "",
      grounded: false,
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);

    const answer =
      typeof parsed.answer === "string"
        ? parsed.answer.trim()
        : "";

    /*
     * لا نعتمد على قيمة grounded وحدها.
     * يجب أن يكون هناك جواب فعلي أيضًا.
     */
    const grounded =
      parsed.grounded === true &&
      answer.length > 0;

    console.log(
      `[RAG] parsed grounded=${grounded} answer="${answer.slice(
        0,
        500
      )}"`
    );

    return {
      answer,
      grounded,
    };
  } catch (err) {
    console.log(
      "[RAG] grounded JSON parsing exception:",
      err
    );

    return {
      answer: "",
      grounded: false,
    };
  }
}

/* =========================================================
   الإجابة النهائية من قاعدة المعرفة
   ========================================================= */

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
  console.log(
    `[RAG] starting for tenant=${tenantId}`
  );

  const { matches, best } = await semanticSearch(
    tenantId,
    text
  );

  const threshold = config.ragThreshold;

  /*
   * لا نرسل سؤالًا إلى الـLLM إذا لم نجد
   * أي معرفة ذات صلة بدرجة كافية.
   */
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

  /*
   * نرسل فقط النتائج المسترجعة.
   *
   * إضافة أرقام للـchunks تساعد الموديل
   * على فصل المصادر عن بعضها.
   */
  const context = matches
    .map(
      (m, i) =>
        `[مصدر ${i + 1} | similarity=${m.similarity}]\n${m.content}`
    )
    .join("\n\n");

  console.log(
    `[RAG] context length=${context.length}`
  );

  const {
    answer,
    grounded,
  } = await generateGroundedAnswer(
    businessName,
    context,
    text
  );

  const confident =
    grounded &&
    answer.length > 0;

  console.log(
    `[RAG] grounded=${grounded} confident=${confident}`
  );

  return {
    confident,
    bestSimilarity: best,
    threshold,
    matches,
    answer: confident ? answer : null,
  };
}
````
