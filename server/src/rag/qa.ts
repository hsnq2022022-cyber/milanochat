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
"مهمتك توليد أسئلة وأجوبة اعتمادًا على المحتوى المرفق فقط.",
"",
"القواعد:",
"1) الأسئلة قصيرة وطبيعية مثل أسئلة العملاء الحقيقية.",
"2) الإجابات يجب أن تكون مبنية على المحتوى المرفق فقط.",
"3) ممنوع اختراع أي سعر أو موعد أو عنوان أو شرط أو سياسة.",
"4) غطِّ الأسعار والخدمات والمنتجات والتوصيل والدفع والاسترجاع والشروط وأوقات العمل والتواصل إذا كانت موجودة.",
"5) أعد من 5 إلى 12 زوجًا حسب كمية المعلومات.",
'6) أعد JSON فقط بهذا الشكل: [{"question":"...","answer":"..."}]',
].join("\n");

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
.replace(/`json/gi, "")
    .replace(/`/g, "")
.trim();

const match = cleaned.match(/\([\s\S]*\)/);

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

if (!qv) {
throw new Error(
"[RAG] فشل إنشاء query embedding"
);
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
}));

const best = matches[0]?.similarity ?? 0;

console.log(
`[RAG] matches=${matches.length} best=${best}`
);

if (matches.length > 0) {
console.log(
"[RAG] retrieved chunks:",
matches.map((m, i) => ({
index: i + 1,
similarity: m.similarity,
content: m.content.slice(0, 1000),
}))
);
} else {
console.log(
"[RAG] no chunks retrieved"
);
}

return {
matches,
best,
};
}

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
"IMPORTANT: المصدر الوحيد للمعلومات هو النص الموجود داخل <context>.",
"لا تستخدم أي معرفة خارجية عن المشروع.",
"",
"قواعد الإجابة:",
"1) اقرأ جميع أجزاء context قبل الإجابة.",
"2) ابحث عن المعلومة المطلوبة حتى لو كانت مكتوبة بصياغة مختلفة عن سؤال العميل.",
"3) إذا كانت الإجابة موجودة في context بشكل مباشر أو يمكن استنتاجها بوضوح من context، يجب أن تجيب عنها.",
"4) لا تقل إنك لا تعرف إذا كانت الإجابة موجودة بوضوح في context.",
"5) إذا كان السؤال عن شروط شراء الحسابات، ابحث تحديدًا عن شروط الشراء والحسابات والدفع والتفعيل والضمان والاسترجاع إذا كانت موجودة.",
"6) لا تخترع أي معلومة غير موجودة في context.",
"7) لا تستخدم معلومات عامة من الإنترنت أو من معرفتك السابقة.",
"8) إذا كانت المعلومات غير موجودة فعلًا، عندها فقط استخدم grounded=false.",
"9) الرد قصير ومناسب لواتساب.",
"10) أجب بالعربية وبأسلوب طبيعي ومهذب.",
"",
"إذا كانت الإجابة مدعومة من context:",
'{"answer":"الإجابة المستندة إلى المصدر","grounded":true}',
"",
"إذا لم تكن الإجابة موجودة في context:",
'{"answer":"لا أملك معلومات مؤكدة عن ذلك من مصادر المعرفة.","grounded":false}',
"",
"أعد JSON فقط ولا تكتب أي شيء خارج JSON.",
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
"حلل context أولاً ثم أجب عن سؤال العميل.",
].join("\n");

console.log(
`[RAG] generating grounded answer question="${question}"`
);

console.log(
`[RAG] context length=${context.length}`
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

const jsonMatch = raw.match(/{[\s\S]*}/);

if (!jsonMatch) {
console.log(
"[RAG] grounded JSON parsing failed: no JSON object"
);

```
return {
  answer: "",
  grounded: false,
};
```

}

try {
const parsed = JSON.parse(
jsonMatch[0]
);

```
const answer =
  typeof parsed.answer === "string"
    ? parsed.answer.trim()
    : "";

const grounded =
  parsed.grounded === true &&
  answer.length > 0;

console.log(
  `[RAG] parsed grounded=${grounded} answer="${answer.slice(
    0,
    700
  )}"`
);

return {
  answer,
  grounded,
};
```

} catch (error) {
console.log(
"[RAG] grounded JSON parsing exception:",
error
);

```
return {
  answer: "",
  grounded: false,
};
```

}
}

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

const {
matches,
best,
} = await semanticSearch(
tenantId,
text
);

const threshold = config.ragThreshold;

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

```
return {
  confident: false,
  bestSimilarity: best,
  threshold,
  matches,
  answer: null,
};
```

}

const context = matches
.map(
(m, i) =>
`[مصدر ${i + 1} | درجة الصلة ${m.similarity}]\n${m.content}`
)
.join("\n\n");

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

if (!confident) {
console.log(
"[RAG] model did not produce a grounded answer"
);
}

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
