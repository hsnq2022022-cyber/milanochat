/**
 * مسارات العميل العام (مرحلة الإعداد قبل الدفع):
 * إنشاء حساب عميل، فهرسة مصدر المعرفة، ربط واتساب + QR حقيقي.
 */
import { Router } from "express";
import QRCode from "qrcode";
import { db } from "../db.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { ingestSource } from "../rag/ingest.js";
import {
  getSession,
  startSession,
  stopSession,
  waStatus,
} from "../wa/sessionManager.js";

export const tenantsRouter = Router();

const createLimiter = rateLimit({ windowMs: 60_000, max: 10 });
const qrLimiter = rateLimit({ windowMs: 1_000, max: 2 });

/** إنشاء عميل جديد (غير مفعل حتى يؤكد الـ webhook الدفع) */
tenantsRouter.post("/", createLimiter, async (req, res) => {
  const { businessName, sourceType, sourceUrl } = req.body ?? {};
  if (!businessName?.trim() || !["gmaps", "website", "manual"].includes(sourceType)) {
    return res.status(400).json({ error: "بيانات ناقصة" });
  }
  const { data, error } = await db
    .from("tenants")
    .insert({
      business_name: businessName.trim().slice(0, 120),
      source_type: sourceType,
      source_url: sourceUrl ?? null,
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

/** بدء جلسة واتساب (يولد QR عبر الأجهزة المرتبطة) */
tenantsRouter.post(
  "/:id/wa/connect",
  rateLimit({ windowMs: 60_000, max: 6 }),
  async (req, res) => {
    try {
      const status = await startSession(req.params.id);
      res.json({ status });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "تعذر بدء الجلسة" });
    }
  }
);

/**
 * حالة الجلسة + QR كصورة PNG (data URL).
 * الواجهة تستطلع هذا المسار كل ثانيتين أثناء الربط.
 */
tenantsRouter.get("/:id/wa/qr", qrLimiter, async (req, res) => {
  const st = waStatus(req.params.id);
  if (st.status === "qr" && st.qr) {
    const png = await QRCode.toDataURL(st.qr, { margin: 1, width: 360 });
    return res.json({ status: st.status, qrDataUrl: png, phone: null });
  }
  res.json({ status: st.status, qrDataUrl: null, phone: st.phoneMasked });
});

/** فصل / إلغاء ربط الجهاز */
tenantsRouter.delete("/:id/wa", async (req, res) => {
  await stopSession(req.params.id, true);
  res.json({ ok: true });
});
