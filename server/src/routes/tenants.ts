/**
 * مسارات العميل العام (مرحلة الإعداد قبل الدفع):
 * إنشاء حساب عميل، فهرسة مصدر المعرفة، ربط واتساب + QR حقيقي.
 */
import { Router } from "express";
import { db } from "../db.js";
import { encryptField } from "../crypto.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { ingestSource } from "../rag/ingest.js";
import { answerFromKnowledge, extractQAPairs, saveQAPairs } from "../rag/qa.js";

export const tenantsRouter = Router();

const createLimiter = rateLimit({ windowMs: 60_000, max: 10 });

/** إنشاء عميل جديد (غير مفعل حتى يؤكد الـ webhook الدفع) */
tenantsRouter.post("/", createLimiter, async (req, res) => {
  const { businessName, sourceType, sourceUrl, phoneE164 } = req.body ?? {};
  if (!businessName?.trim() || !["gmaps", "website", "manual"].includes(sourceType)) {
    return res.status(400).json({ error: "بيانات ناقصة" });
  }
  // الرقم يصل بصيغة E.164 كاملة (+964...) — يُخزَّن مشفرًا
  const phone = typeof phoneE164 === "string" && /^\+\d{7,15}$/.test(phoneE164) ? phoneE164 : null;
  const { data, error } = await db
    .from("tenants")
    .insert({
      business_name: businessName.trim().slice(0, 120),
      source_type: sourceType,
      source_url: sourceUrl ?? null,
      business_phone_encrypted: phone ? encryptField(phone) : null,
      credits_remaining: 0,
      is_active: false,
    })
    .select("id, claim_token")
    .single();
  if (error || !data) return res.status(500).json({ error: error?.message ?? "خطأ" });

  res.json({
    tenantId: data.id,
    // يحتفظ به العميل ليضمّ الحساب للوحة التحكم بعد التسجيل
    claimToken: data.claim_token,
  });
});

/** فهرسة مصدر المعرفة: رابط أو نص يدوي */
tenantsRouter.post(
  "/:id/knowledge",
  rateLimit({ windowMs: 60_000, max: 8 }),
  async (req, res) => {
    const { id } = req.params;
    const { url, text } = req.body ?? {};
    try {
      const result =
        url?.trim() && /^https?:\/\//.test(url.trim())
          ? await ingestSource(id, { kind: "url", url: url.trim() })
          : await ingestSource(id, { kind: "text", text: String(text ?? "") });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "خطأ في الفهرسة" });
    }
  }
);

/** الميزة 2: توليد أسئلة وأجوبة من الرابط (الجلب والتوليد في الخادم) */
tenantsRouter.post(
  "/:id/qa/extract",
  rateLimit({ windowMs: 60_000, max: 6 }),
  async (req, res) => {
    const { url } = req.body ?? {};
    if (typeof url !== "string" || !/^https?:\/\/\S+\.\S+/.test(url.trim())) {
      return res.status(400).json({ error: "الرابط غير صالح" });
    }
    try {
      const { pairs, title } = await extractQAPairs(url.trim());
      res.json({ pairs, title });
    } catch (e: any) {
      res.status(502).json({ error: e?.message ?? "تعذر استخراج الأسئلة والأجوبة" });
    }
  }
);

/** الميزة 2: الحفظ النهائي للأزواج المراجَعة كقاعدة معرفة فعلية */
tenantsRouter.post(
  "/:id/qa/save",
  rateLimit({ windowMs: 60_000, max: 10 }),
  async (req, res) => {
    const { pairs, sourceUrl } = req.body ?? {};
    if (!Array.isArray(pairs) || pairs.length === 0) {
      return res.status(400).json({ error: "القائمة فارغة" });
    }
    try {
      const result = await saveQAPairs(req.params.id, pairs, sourceUrl ?? null);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "تعذر الحفظ" });
    }
  }
);

/**
 * الميزة 3: مختبر الفهم الدلالي —
 * يمر بنفس مسار محرك الرد (استرجاع + عتبة + توليد) ويعيد النتائج للتجربة
 * دون إرسال أي رسالة واتساب.
 */
tenantsRouter.post(
  "/:id/qa/test",
  rateLimit({ windowMs: 60_000, max: 20 }),
  async (req, res) => {
    const { text } = req.body ?? {};
    if (typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "اكتب صياغة لتجربتها" });
    }
    const {  tenant } = await db
      .from("tenants")
      .select("business_name")
      .eq("id", req.params.id)
      .maybeSingle();
    try {
      const result = await answerFromKnowledge(
        req.params.id,
        tenant?.business_name ?? "المشروع",
        text.trim()
      );
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "تعذر الاختبار" });
    }
  }
);

/* ربط واتساب انتقل إلى /api/whatsapp (جلسات حقيقية + SSE + صلاحيات) — انظر routes/whatsapp.ts */
