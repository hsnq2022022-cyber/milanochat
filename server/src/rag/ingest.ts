/**
 * خط تغذية قاعدة المعرفة المتقدم:
 * يدعم: URL, Text, PDF, DOCX, TXT, Markdown, CSV, Excel
 * Chunking ذكي يحافظ على السياق
 * Metadata كاملة لكل chunk
 */
import * as cheerio from "cheerio";
import { db } from "../db.js";
import { embed, toPgVector } from "../llm.js";
import { encryptField } from "../crypto.js";

const MAX_CHARS = 40_000;

// ═══════════════════════════════════════════════════════════════════════════════
// استخراج النص من مصادر مختلفة
// ═══════════════════════════════════════════════════════════════════════════════

/** استخراج النص من صفحة ويب */
export async function extractFromUrl(url: string): Promise<{ text: string; title: string; metadata: any }> {
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`تعذر فتح الرابط (HTTP ${res.status})`);
  
  const type = res.headers.get("content-type") ?? "";
  const raw = await res.text();

  // نص عادي أو JSON
  if (type.includes("text/plain") || type.includes("json")) {
    return { 
      title: url, 
      text: raw.slice(0, MAX_CHARS),
      metadata: { source: "text", url }
    };
  }

  // HTML
  const $ = cheerio.load(raw);
  $("script,style,noscript,nav,footer,header,aside,iframe,svg,form").remove();
  
  const title = ($("title").first().text() || url).trim().slice(0, 200);
  const description = $("meta[name='description']").attr("content") || "";
  
  // استخراج المحتوى الرئيسي مع الحفاظ على الهيكل
  const mainContent = $("main").first() || $("article").first() || $("body");
  
  // استخراج العناوين والفقرات
  const sections: string[] = [];
  mainContent.find("h1, h2, h3, h4, p, li").each((_, el) => {
    const text = $(el).text().trim();
    if (text) {
      const tag = $(el).prop("tagName").toLowerCase();
      if (tag.startsWith("h")) {
        sections.push(`\n## ${text}\n`);
      } else {
        sections.push(text);
      }
    }
  });
  
  const text = sections.join("\n").replace(/\s+/g, " ").trim().slice(0, MAX_CHARS);
  
  return { 
    title, 
    text,
    metadata: { 
      source: "web", 
      url,
      description,
      headings: mainContent.find("h1, h2, h3").length,
      paragraphs: mainContent.find("p").length
    }
  };
}

/** استخراج النص من ملف نصي (TXT, Markdown) */
export function extractFromText(content: string): { text: string; metadata: any } {
  // تنظيف النص
  const text = content
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_CHARS);
  
  // استخراج العناوين من Markdown
  const headings = (content.match(/^#+\s.+$/gm) || []).length;
  
  return {
    text,
    metadata: {
      source: "text",
      length: text.length,
      headings
    }
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
  };
}

/** تقسيم ذكي يحافظ على العناوين والأقسام */
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
    preserveHeadings = true
  } = options;

  const chunks: Chunk[] = [];
  
  // تقسيم النص إلى أقسام بناءً على العناوين
  const sections = text.split(/\n(?=##\s)/);
  
  let currentSection = "";
  let sectionTitle = "";
  let chunkIndex = 0;
  
  for (const section of sections) {
    // استخراج عنوان القسم
    const titleMatch = section.match(/^##\s+(.+)$/m);
    if (titleMatch) {
      sectionTitle = titleMatch[1].trim();
    }
    
    // تقسيم القسم إلى فقرات
    const paragraphs = section.split(/\n\n+/).filter(p => p.trim().length > 0);
    
    let currentChunk = "";
    
    for (const para of paragraphs) {
      // إذا كانت الفقرة طويلة جداً، قسمها
      if (para.length > maxSize) {
        const subChunks = splitLongParagraph(para, maxSize, overlap);
        for (const subChunk of subChunks) {
          if (currentChunk.length + subChunk.length > maxSize) {
            if (currentChunk.length > 0) {
              chunks.push({
                content: currentChunk.trim(),
                metadata: {
                  title: sectionTitle,
                  section: currentSection || sectionTitle,
                  index: chunkIndex++,
                  source_type: sourceType
                }
              });
              // تراكب: احتفظ بآخر جزء
              currentChunk = currentChunk.slice(-overlap);
            }
          }
          currentChunk += subChunk + "\n";
        }
      } else {
        // إذا تجاوزت الفقرة الحد، احفظ chunk الحالي وابدأ جديد
        if (currentChunk.length + para.length > maxSize) {
          if (currentChunk.length > 0) {
            chunks.push({
              content: currentChunk.trim(),
              metadata: {
                title: sectionTitle,
                section: currentSection || sectionTitle,
                index: chunkIndex++,
                source_type: sourceType
              }
            });
            // تراكب
            currentChunk = currentChunk.slice(-overlap);
          }
        }
        currentChunk += para + "\n";
      }
    }
    
    // حفظ آخر chunk من القسم
    if (currentChunk.length > 0) {
      chunks.push({
        content: currentChunk.trim(),
        metadata: {
          title: sectionTitle,
          section: currentSection || sectionTitle,
          index: chunkIndex++,
          source_type: sourceType
        }
      });
    }
    
    currentSection = sectionTitle;
  }
  
  return chunks.filter(c => c.content.length > 30); // تجاهل chunks فارغة
}

/** تقسيم فقرة طويلة إلى أجزاء */
function splitLongParagraph(text: string, maxSize: number, overlap: number): string[] {
  const chunks: string[] = [];
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  
  let current = "";
  for (const sentence of sentences) {
    if (current.length + sentence.length > maxSize) {
      if (current.length > 0) {
        chunks.push(current.trim());
        current = current.slice(-overlap);
      }
    }
    current += sentence;
  }
  
  if (current.length > 0) {
    chunks.push(current.trim());
  }
  
  return chunks;
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
export async function ingestSource(tenantId: string, input: IngestInput): Promise<IngestResult> {
  // إنشاء سجل المصدر
  const { data: source, error: srcErr } = await db
    .from("knowledge_sources")
    .insert({
      tenant_id: tenantId,
      kind: input.kind === "url" ? "url" : "text",
      url: input.kind === "url" ? input.url : null,
      name: input.kind === "text" ? input.name : (input.kind === "file" ? input.name : null),
      file_type: input.kind === "file" ? input.fileType : null,
      raw_text_encrypted: input.kind === "text" ? encryptField(input.text) : null,
      status: "pending",
      metadata: {},
    })
    .select()
    .single();
  
  if (srcErr || !source) throw new Error("تعذر إنشاء سجل المصدر: " + srcErr?.message);

  try {
    let text = "";
    let title = "";
    let metadata: any = {};

    // استخراج النص حسب نوع المصدر
    if (input.kind === "url") {
      const extracted = await extractFromUrl(input.url);
      text = extracted.text;
      title = extracted.title;
      metadata = extracted.metadata;
    } else if (input.kind === "text") {
      const extracted = extractFromText(input.text);
      text = extracted.text;
      title = input.name || "نص يدوي";
      metadata = extracted.metadata;
    } else if (input.kind === "file") {
      const extracted = extractFromText(input.content);
      text = extracted.text;
      title = input.name;
      metadata = { ...extracted.metadata, file_type: input.fileType };
    }

    if (text.length < 40) {
      await db.from("knowledge_sources").update({ 
        status: "failed", 
        error: "المحتوى المستخرج غير كافٍ" 
      }).eq("id", source.id);
      
      return { 
        sourceId: source.id, 
        status: "failed", 
        chunks: 0, 
        error: "المحتوى المستخرج غير كافٍ" 
      };
    }

    // تقسيم ذكي
    const chunks = smartChunkText(text, input.kind, {
      maxSize: 800,
      overlap: 150,
      preserveHeadings: true
    });

    // توليد embeddings
    const texts = chunks.map(c => c.content);
    const vectors = await embed(texts);

    // حفظ chunks مع metadata
    const rows = chunks.map((chunk, i) => ({
      tenant_id: tenantId,
      source_id: source.id,
      chunk_index: i,
      content: chunk.content,
      embedding: toPgVector(vectors[i]),
      metadata: chunk.metadata,
      title: chunk.metadata.title,
      section: chunk.metadata.section,
    }));

    const { error: insErr } = await db.from("knowledge_chunks").insert(rows);
    if (insErr) throw new Error(insErr.message);

    // تحديث حالة المصدر
    await db
      .from("knowledge_sources")
      .update({ 
        status: "indexed", 
        chunks_count: chunks.length,
        metadata,
        last_synced_at: new Date().toISOString()
      })
      .eq("id", source.id);

    return { 
      sourceId: source.id, 
      status: "indexed", 
      chunks: chunks.length, 
      title,
      metadata 
    };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    await db.from("knowledge_sources").update({ 
      status: "failed", 
      error: msg 
    }).eq("id", source.id);
    
    return { 
      sourceId: source.id, 
      status: "failed", 
      chunks: 0, 
      error: msg 
    };
  }
}

/** إضافة قطعة معرفة واحدة */
export async function addKnowledgeSnippet(
  tenantId: string, 
  content: string,
  metadata?: any
): Promise<void> {
  const [vector] = await embed([content]);
  const { error } = await db.from("knowledge_chunks").insert({
    tenant_id: tenantId,
    source_id: null,
    chunk_index: 0,
    content,
    embedding: toPgVector(vector),
    metadata: metadata || {},
  });
  if (error) throw new Error(error.message);
}
