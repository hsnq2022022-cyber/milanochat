/**
 * خط تغذية قاعدة المعرفة المتقدم:
 * يدعم: URL, Text, PDF, DOCX, TXT, Markdown, CSV, Excel
 * Chunking ذكي يحافظ على السياق
 * Metadata كاملة لكل chunk
 * Multi-tenant: جميع عمليات الفهرسة مرتبطة بـ tenant_id
 */

import * as cheerio from "cheerio";
import { db } from "../db.js";
import { embed, toPgVector } from "../llm.js";
import { encryptField } from "../crypto.js";

const MAX_CHARS = 40_000;

// ═══════════════════════════════════════════════════════════════════════════════
// استخراج النص من المصادر
// ═══════════════════════════════════════════════════════════════════════════════

/** استخراج النص من صفحة ويب مع مهلة لمنع تعليق عملية الفهرسة */
export async function extractFromUrl(
  url: string
): Promise<{ text: string; title: string; metadata: any }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  let res: Response;

  try {
    res = await fetch(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
      },
      redirect: "follow",
      signal: controller.signal,
    });
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw new Error("انتهت مهلة تحميل الموقع بعد 30 ثانية");
    }

    throw new Error(`تعذر تحميل الموقع: ${error?.message ?? error}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new Error(`تعذر فتح الرابط (HTTP ${res.status})`);
  }

  const type = res.headers.get("content-type") ?? "";
  const raw = await res.text();

  // نص عادي أو JSON
  if (type.includes("text/plain") || type.includes("json")) {
    return {
      title: url,
      text: raw.slice(0, MAX_CHARS),
      metadata: {
        source: "text",
        url,
      },
    };
  }

  // HTML
  const $ = cheerio.load(raw);

  // إزالة العناصر التي لا تمثل معرفة مفيدة للـ Agent
  $(
    "script,style,noscript,nav,footer,header,aside,iframe,svg,form"
  ).remove();

  const title = ($("title").first().text() || url).trim().slice(0, 200);
  const description = $("meta[name='description']").attr("content") || "";

  const main = $("main").first();
  const article = $("article").first();
  const root = main.length ? main : article.length ? article : $("body");

  // نحافظ على العناوين حتى يستطيع الـ chunking معرفة الأقسام.
  const sections: string[] = [];

  root.find("h1,h2,h3,h4,p,li").each((_, el) => {
    const value = $(el).text().replace(/\s+/g, " ").trim();
    if (!value) return;

    const tag = String($(el).prop("tagName") || "").toLowerCase();

    if (tag.startsWith("h")) {
      sections.push(`\n## ${value}\n`);
    } else {
      sections.push(value);
    }
  });

  // إذا لم نجد العناصر السابقة، استخدم النص العام للصفحة كخطة احتياطية.
  const fallback = root.text().replace(/\s+/g, " ").trim();
  const text = (sections.length ? sections.join("\n") : fallback)
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_CHARS);

  return {
    title,
    text,
    metadata: {
      source: "web",
      url,
      description,
      headings: root.find("h1,h2,h3").length,
      paragraphs: root.find("p").length,
    },
  };
}

/** استخراج النص من TXT / Markdown / النصوص اليدوية */
export function extractFromText(
  content: string
): { text: string; metadata: any } {
  const text = String(content ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_CHARS);

  const headings = (content.match(/^#{1,6}\s.+$/gm) || []).length;

  return {
    text,
    metadata: {
      source: "text",
      length: text.length,
      headings,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Chunking ذكي يحافظ على السياق
// ═══════════════════════════════════════════════════════════════════════════════

export interface Chunk {
  content: string;
  metadata: {
    title?: string;
    section?: string;
    page?: number;
    index: number;
    source_type: string;
    [key: string]: any;
  };
}

/**
 * تقسيم ذكي يحافظ على العناوين والفقرات، مع overlap لمنع فقدان السياق.
 */
export function smartChunkText(
  text: string,
  sourceType: string,
  options: {
    maxSize?: number;
    overlap?: number;
    preserveHeadings?: boolean;
  } = {}
): Chunk[] {
  const {
    maxSize = 800,
    overlap = 150,
    preserveHeadings = true,
  } = options;

  const chunks: Chunk[] = [];
  const normalized = String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

  if (!normalized) return chunks;

  // إذا كانت العناوين موجودة، نفصل عندها مع إبقاء العنوان مع محتواه.
  const sections = preserveHeadings
    ? normalized.split(/\n(?=##\s+)/)
    : [normalized];

  let chunkIndex = 0;
  let currentSection = "";

  const pushChunk = (content: string, section: string) => {
    const clean = content.trim();
    if (clean.length <= 30) return;

    chunks.push({
      content: clean,
      metadata: {
        title: section || undefined,
        section: section || undefined,
        index: chunkIndex++,
        source_type: sourceType,
      },
    });
  };

  for (const rawSection of sections) {
    const section = rawSection.trim();
    if (!section) continue;

    const titleMatch = section.match(/^##\s+(.+)$/m);
    if (titleMatch) {
      currentSection = titleMatch[1].trim();
    }

    const paragraphs = section
      .split(/\n\s*\n+/)
      .map((p) => p.trim())
      .filter(Boolean);

    let currentChunk = "";

    for (const paragraph of paragraphs) {
      if (paragraph.length > maxSize) {
        const pieces = splitLongParagraph(paragraph, maxSize, overlap);

        for (const piece of pieces) {
          if (currentChunk.length + piece.length + 1 > maxSize) {
            pushChunk(currentChunk, currentSection);
            currentChunk = currentChunk.slice(-overlap).trim();
          }

          currentChunk = `${currentChunk}\n${piece}`.trim();
        }

        continue;
      }

      if (
        currentChunk &&
        currentChunk.length + paragraph.length + 1 > maxSize
      ) {
        pushChunk(currentChunk, currentSection);
        currentChunk = currentChunk.slice(-overlap).trim();
      }

      currentChunk = `${currentChunk}\n${paragraph}`.trim();
    }

    if (currentChunk) {
      pushChunk(currentChunk, currentSection);
    }
  }

  return chunks;
}

/** تقسيم فقرة طويلة على حدود الجمل قدر الإمكان */
function splitLongParagraph(
  text: string,
  maxSize: number,
  overlap: number
): string[] {
  const result: string[] = [];

  // يدعم علامات الترقيم العربية والإنجليزية.
  const sentences =
    text.match(/[^.!?؟!؛]+[.!?؟!؛]+|[^.!?؟!؛]+$/g) || [text];

  let current = "";

  for (const sentence of sentences) {
    const clean = sentence.trim();
    if (!clean) continue;

    if (current && current.length + clean.length + 1 > maxSize) {
      result.push(current.trim());
      current = current.slice(-overlap).trim();
    }

    current = `${current} ${clean}`.trim();
  }

  if (current) result.push(current.trim());

  // حماية إضافية إذا كانت هناك كلمة/سلسلة أطول من الحد.
  const final: string[] = [];

  for (const piece of result) {
    if (piece.length <= maxSize) {
      final.push(piece);
      continue;
    }

    const step = Math.max(1, maxSize - overlap);
    for (let i = 0; i < piece.length; i += step) {
      final.push(piece.slice(i, i + maxSize));
    }
  }

  return final;
}

/**
 * دالة chunking عامة للحفاظ على التوافق مع أي كود قد يستدعيها مباشرة.
 */
export function chunkText(
  text: string,
  size = 700,
  overlap = 120
): string[] {
  return smartChunkText(text, "text", {
    maxSize: size,
    overlap,
    preserveHeadings: true,
  }).map((chunk) => chunk.content);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Ingest المصادر
// ═══════════════════════════════════════════════════════════════════════════════

export type IngestInput =
  | { kind: "url"; url: string }
  | { kind: "text"; text: string; name?: string }
  | { kind: "file"; content: string; name: string; fileType: string };

export type IngestResult = {
  sourceId: string;
  status: "indexed" | "failed";
  chunks: number;
  error?: string;
  title?: string;
  metadata?: any;
};

/** فهرسة مصدر كامل لعميل محدد */
export async function ingestSource(
  tenantId: string,
  input: IngestInput
): Promise<IngestResult> {
  if (!tenantId) {
    throw new Error("tenantId مطلوب لفهرسة مصدر المعرفة");
  }

  // إنشاء سجل المصدر أولًا حتى نستطيع تتبع حالة العملية حتى عند الفشل.
  const { data: source, error: srcErr } = await db
    .from("knowledge_sources")
    .insert({
      tenant_id: tenantId,
      kind: input.kind === "url" ? "url" : "text",
      url: input.kind === "url" ? input.url : null,
      name:
        input.kind === "text"
          ? input.name
          : input.kind === "file"
            ? input.name
            : null,
      file_type: input.kind === "file" ? input.fileType : null,
      raw_text_encrypted:
        input.kind === "text" ? encryptField(input.text) : null,
      status: "pending",
      metadata: {},
    })
    .select()
    .single();

  if (srcErr || !source) {
    throw new Error(
      "تعذر إنشاء سجل المصدر: " + (srcErr?.message ?? "خطأ غير معروف")
    );
  }

  try {
    let text = "";
    let title = "نص يدوي";
    let metadata: any = {};

    if (input.kind === "url") {
      const extracted = await extractFromUrl(input.url);
      text = extracted.text;
      title = extracted.title;
      metadata = extracted.metadata;
    } else if (input.kind === "text") {
      const extracted = extractFromText(input.text);
      text = extracted.text;
      title = input.name || "نص يدوي";
      metadata = {
        ...extracted.metadata,
        name: input.name || "نص يدوي",
      };
    } else {
      // ملفات PDF/DOCX/CSV/Excel يفترض أن تصل إلى هذه الطبقة بعد استخراج
      // محتواها النصي في طبقة رفع/Parsing الملفات.
      const extracted = extractFromText(input.content);
      text = extracted.text;
      title = input.name;
      metadata = {
        ...extracted.metadata,
        file_type: input.fileType,
        name: input.name,
      };
    }

    if (text.length < 40) {
      const errorMessage = "المحتوى المستخرج غير كافٍ";

      await db
        .from("knowledge_sources")
        .update({
          status: "failed",
          error: errorMessage,
        })
        .eq("id", source.id)
        .eq("tenant_id", tenantId);

      return {
        sourceId: source.id,
        status: "failed",
        chunks: 0,
        error: errorMessage,
      };
    }

    const chunks = smartChunkText(text, input.kind, {
      maxSize: 800,
      overlap: 150,
      preserveHeadings: true,
    });

    if (chunks.length === 0) {
      throw new Error("تعذر إنشاء أجزاء معرفة صالحة من المصدر");
    }

    // توليد embeddings دفعة واحدة للحفاظ على الاتساق وتقليل عدد الطلبات.
    const texts = chunks.map((chunk) => chunk.content);
    const vectors = await embed(texts);

    if (!vectors || vectors.length !== chunks.length) {
      throw new Error("عدد embeddings لا يطابق عدد chunks");
    }

    const rows = chunks.map((chunk, index) => ({
      tenant_id: tenantId,
      source_id: source.id,
      chunk_index: index,
      content: chunk.content,
      embedding: toPgVector(vectors[index]),
      metadata: {
        ...chunk.metadata,
        source_id: source.id,
        source_title: title,
        source_name: metadata?.name || title,
        source_url: input.kind === "url" ? input.url : undefined,
        file_type: input.kind === "file" ? input.fileType : undefined,
      },
      title: chunk.metadata.title || title,
      section: chunk.metadata.section || null,
    }));

    const { error: insErr } = await db
      .from("knowledge_chunks")
      .insert(rows);

    if (insErr) {
      throw new Error(insErr.message);
    }

    const indexedMetadata = {
      ...metadata,
      title,
      source_type: input.kind,
      chunks_count: chunks.length,
    };

    const { error: sourceUpdateError } = await db
      .from("knowledge_sources")
      .update({
        status: "indexed",
        chunks_count: chunks.length,
        metadata: indexedMetadata,
        last_synced_at: new Date().toISOString(),
      })
      .eq("id", source.id)
      .eq("tenant_id", tenantId);

    if (sourceUpdateError) {
      throw new Error(
        "تم إنشاء chunks لكن تعذر تحديث حالة المصدر: " +
          sourceUpdateError.message
      );
    }

    return {
      sourceId: source.id,
      status: "indexed",
      chunks: chunks.length,
      title,
      metadata: indexedMetadata,
    };
  } catch (error: any) {
    const message = String(error?.message ?? error);

    await db
      .from("knowledge_sources")
      .update({
        status: "failed",
        error: message,
      })
      .eq("id", source.id)
      .eq("tenant_id", tenantId);

    return {
      sourceId: source.id,
      status: "failed",
      chunks: 0,
      error: message,
    };
  }
}

/** إضافة قطعة معرفة واحدة، مثل المعرفة التي يضيفها المستخدم يدويًا */
export async function addKnowledgeSnippet(
  tenantId: string,
  content: string,
  metadata?: any
): Promise<void> {
  const cleanContent = String(content ?? "").trim();

  if (cleanContent.length < 2) {
    throw new Error("محتوى المعرفة مطلوب");
  }

  const [vector] = await embed([cleanContent]);

  if (!vector) {
    throw new Error("تعذر إنشاء embedding للمعرفة");
  }

  const { error } = await db.from("knowledge_chunks").insert({
    tenant_id: tenantId,
    source_id: null,
    chunk_index: 0,
    content: cleanContent,
    embedding: toPgVector(vector),
    metadata: metadata || {},
  });

  if (error) {
    throw new Error(error.message);
  }
}
