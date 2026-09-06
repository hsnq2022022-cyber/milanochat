/**
 * خط تغذية قاعدة المعرفة:
 * مصدر (رابط أو نص يدوي) → استخراج نص → تقطيع → embeddings → تخزين معزول لكل عميل
 */

import * as cheerio from "cheerio";
import { db } from "../db.js";
import { embed, toPgVector } from "../llm.js";
import { encryptField } from "../crypto.js";

const MAX_CHARS = 40_000;

/** استخراج النص المفيد من صفحة ويب */
export async function extractFromUrl(
  url: string
): Promise<{ text: string; title: string }> {

  // منع بقاء طلب الموقع معلقًا إلى أجل غير محدد
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, 30_000);

  let res: Response;

  try {
    res = await fetch(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: controller.signal,
    });
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw new Error("انتهت مهلة تحميل الموقع بعد 30 ثانية");
    }

    throw new Error(
      `تعذر تحميل الموقع: ${error?.message ?? error}`
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new Error(`تعذر فتح الرابط (HTTP ${res.status})`);
  }

  const type = res.headers.get("content-type") ?? "";
  const raw = await res.text();

  if (type.includes("text/plain") || type.includes("json")) {
    return {
      title: url,
      text: raw.slice(0, MAX_CHARS),
    };
  }

  const $ = cheerio.load(raw);

  // إزالة العناصر غير المفيدة للمعرفة
  $(
    "script,style,noscript,nav,footer,header,aside,iframe,svg,form"
  ).remove();

  const title = (
    $("title").first().text() || url
  )
    .trim()
    .slice(0, 200);

  const root =
    $("main").first().text() ||
    $("article").first().text() ||
    $("body").text();

  const text = root
    .replace(/\s+/g, " ")
    .replace(/\s*([،؛:.,!?])\s*/g, "$1 ")
    .trim()
    .slice(0, MAX_CHARS);

  return {
    title,
    text,
  };
}

/** تقطيع نص طويل إلى قطع متراكبة مناسبة للـ RAG */
export function chunkText(
  text: string,
  size = 700,
  overlap = 120
): string[] {

  const parts = text
    .split(/\n{2,}|\s{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let buf = "";

  const push = () => {
    if (buf.trim().length > 30) {
      chunks.push(buf.trim());
    }

    buf = "";
  };

  for (const part of parts) {
    if ((buf + " " + part).length > size) {
      push();

      // تراكب: نحتفظ بآخر جزء من القطعة السابقة
      buf = (buf.slice(-overlap) + " " + part).trim();
    } else {
      buf = (buf + "\n" + part).trim();
    }
  }

  push();

  // قطعة أطول من الحد نقسمها جزافًا
  const final: string[] = [];

  for (const c of chunks) {
    if (c.length <= size + 300) {
      final.push(c);
    } else {
      for (
        let i = 0;
        i < c.length;
        i += size - overlap
      ) {
        final.push(c.slice(i, i + size));
      }
    }
  }

  return final;
}

export type IngestInput =
  | { kind: "url"; url: string }
  | { kind: "text"; text: string };

export type IngestResult = {
  sourceId: string;
  status: "indexed" | "failed";
  chunks: number;
  error?: string;
  title?: string;
};

/** فهرسة مصدر كامل لعميل محدد (multi-tenant: كل شيء مربوط بـ tenant_id) */
export async function ingestSource(
  tenantId: string,
  input: IngestInput
): Promise<IngestResult> {

  const { data: source, error: srcErr } = await db
    .from("knowledge_sources")
    .insert({
      tenant_id: tenantId,
      kind: input.kind,
      url: input.kind === "url" ? input.url : null,
      raw_text_encrypted:
        input.kind === "text"
          ? encryptField(input.text)
          : null,
      status: "pending",
    })
    .select()
    .single();

  if (srcErr || !source) {
    throw new Error(
      "تعذر إنشاء سجل المصدر: " +
        (srcErr?.message ?? "خطأ غير معروف")
    );
  }

  try {
    let raw = "";
    let title = "نص يدوي";

    if (input.kind === "url") {
      const ex = await extractFromUrl(input.url);

      raw = ex.text;
      title = ex.title;
    } else {
      raw = input.text.trim();
    }

    if (raw.length < 40) {
      await db
        .from("knowledge_sources")
        .update({
          status: "failed",
          error: "المحتوى المستخرج غير كافٍ",
        })
        .eq("id", source.id);

      return {
        sourceId: source.id,
        status: "failed",
        chunks: 0,
        error: "المحتوى المستخرج غير كافٍ",
      };
    }

    const chunks = chunkText(raw);

    const vectors = await embed(chunks);

    const rows = chunks.map((content, i) => ({
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
      throw new Error(insErr.message);
    }

    await db
      .from("knowledge_sources")
      .update({
        status: "indexed",
        chunks_count: chunks.length,
      })
      .eq("id", source.id);

    return {
      sourceId: source.id,
      status: "indexed",
      chunks: chunks.length,
      title,
    };

  } catch (e: any) {

    const msg = String(e?.message ?? e);

    await db
      .from("knowledge_sources")
      .update({
        status: "failed",
        error: msg,
      })
      .eq("id", source.id);

    return {
      sourceId: source.id,
      status: "failed",
      chunks: 0,
      error: msg,
    };
  }
}

/** إضافة قطعة معرفة واحدة (تُستخدم عند حل سؤال عالق من اللوحة) */
export async function addKnowledgeSnippet(
  tenantId: string,
  content: string
): Promise<void> {

  const [vector] = await embed([content]);

  const { error } = await db
    .from("knowledge_chunks")
    .insert({
      tenant_id: tenantId,
      source_id: null,
      chunk_index: 0,
      content,
      embedding: toPgVector(vector),
    });

  if (error) {
    throw new Error(error.message);
  }
}
