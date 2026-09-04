/**
 * الدفع عبر Moyasar:
 * - إنشاء فاتورة → العميل يُحوَّل لبوابة الدفع
 * - الـ webhook يؤكد الدفع (بتوقيع HMAC) وبعدها فقط يُفعَّل الحساب ويُمنح الرصيد
 * - معالجة idempotent: تكرار نفس الحدث لا يمنح رصيدًا إضافيًا
 */
import { Router } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { db } from "../db.js";
import { rateLimit } from "../middleware/rateLimit.js";

export const paymentsRouter = Router();
export const webhooksRouter = Router();

const PRICE_SAR = 99; // يطابق عرض الواجهة: 99 ريال دفعة واحدة

type Package = { id: string; name: string; credits: number; amountHalalas: number };

const PACKAGES: Package[] = [
  { id: "starter", name: "باقة البداية", credits: 1000, amountHalalas: PRICE_SAR * 100 },
  { id: "growth", name: "باقة النمو", credits: 3000, amountHalalas: 249 * 100 },
  { id: "scale", name: "باقة التوسع", credits: 10000, amountHalalas: 649 * 100 },
];

/** إنشاء فاتورة Moyasar وإعادة رابط الدفع */
paymentsRouter.post(
  "/create",
  rateLimit({ windowMs: 60_000, max: 6 }),
  async (req, res) => {
    const { tenantId, packageId } = req.body ?? {};
    const pkg = PACKAGES.find((p) => p.id === packageId) ?? PACKAGES[0];
    if (!tenantId) return res.status(400).json({ error: "tenantId ناقص" });

    const { data: tenant } = await db.from("tenants").select("id, business_name").eq("id", tenantId).maybeSingle();
    if (!tenant) return res.status(404).json({ error: "العميل غير موجود" });

    const invoiceBody = {
      amount: pkg.amountHalalas,
      currency: "SAR",
      description: `ميلانو — ${pkg.name} (${pkg.credits} رد ذكي) — ${tenant.business_name}`,
      // إشعار عند اكتمال الدفع
      callback_url: `${config.publicUrl}/api/webhooks/moyasar`,
      metadata: { tenant_id: tenantId, package_id: pkg.id },
    };

    const moyasar = await fetch("https://api.moyasar.com/v1/invoices", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(config.moyasar.secretKey + ":").toString("base64")}`,
      },
      body: JSON.stringify(invoiceBody),
    });

    if (!moyasar.ok) {
      return res.status(502).json({ error: `Moyasar ${moyasar.status}: ${await moyasar.text()}` });
    }

    const invoice: any = await moyasar.json();

    await db.from("payments").insert({
      tenant_id: tenantId,
      provider: "moyasar",
      invoice_id: invoice.id,
      amount: pkg.amountHalalas,
      currency: "SAR",
      status: "created",
      credits_granted: 0,
    });

    res.json({
      invoiceId: invoice.id,
      // صفحة الدفع hosted الخاصة بـ Moyasar
      paymentUrl: invoice.transaction?.url ?? invoice.url ?? null,
    });
  }
);

/** التحقق من توقيع webhook Moyasar (مقارنة ثابتة الزمن) */
function verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!config.moyasar.webhookSecret || !signature) return false;
  const expected = createHmac("sha256", config.moyasar.webhookSecret)
    .update(rawBody)
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * webhook الدفع — التفعيل يحدث هنا فقط.
 * مقيّد بمعدل صارم ولا يقبل أي حدث بدون توقيع صحيح.
 */
webhooksRouter.post("/moyasar", rateLimit({ windowMs: 60_000, max: 30 }), async (req, res) => {
  const raw: Buffer = (req as any).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
  const signature =
    (req.headers["moyasar-signature"] as string) ?? (req.headers["x-moyasar-signature"] as string);

  if (!verifySignature(raw, signature)) {
    return res.status(401).json({ error: "توقيع غير صالح" });
  }

  const event = req.body ?? {};
  const type: string = event.type ?? "";
  const data = event.data ?? {};
  const invoiceId: string | undefined = data.invoice_id ?? data.id;

  if (!invoiceId || !/paid|succeeded/.test(type)) {
    return res.status(200).json({ received: true });
  }

  const { data: payment } = await db
    .from("payments")
    .select("*")
    .eq("invoice_id", invoiceId)
    .maybeSingle();

  // idempotency: حدث مكرر لفاتورة مدفوعة سابقًا
  if (!payment || payment.status === "paid") {
    return res.status(200).json({ received: true });
  }

  const pkg = PACKAGES.find((p) => p.amountHalalas === payment.amount) ?? PACKAGES[0];

  await db
    .from("payments")
    .update({ status: "paid", credits_granted: pkg.credits, webhook_event: event, paid_at: new Date().toISOString() })
    .eq("id", payment.id);

  // التفعيل الفعلي: رصيد + is_active — لا يحدث في أي مكان آخر
  await db.rpc("grant_credits", { p_tenant_id: payment.tenant_id, p_credits: pkg.credits }).catch(async () => {
    // لو الدالة غير موجودة نطبق التحديث يدويًا
    const { data: t } = await db.from("tenants").select("credits_remaining").eq("id", payment.tenant_id).single();
    await db
      .from("tenants")
      .update({
        credits_remaining: (t?.credits_remaining ?? 0) + pkg.credits,
        is_active: true,
        activated_at: new Date().toISOString(),
      })
      .eq("id", payment.tenant_id);
  });

  res.status(200).json({ received: true, activated: true });
});
