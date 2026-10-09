/**
 * الدفع عبر Wayl + الوضع التجريبي
 *
 * DEMO_MODE=true:
 *   - لا يتم الاتصال بـ Wayl.
 *   - يتم منح الرصيد التجريبي مباشرة.
 *
 * DEMO_MODE=false:
 *   - يتم استخدام Wayl للدفع الحقيقي (يدعم IQD فقط).
 */

import { Router } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { db } from "../db.js";
import { rateLimit } from "../middleware/rateLimit.js";

export const paymentsRouter = Router();
export const webhooksRouter = Router();

const DEMO_MODE = process.env.DEMO_MODE === "true";

const PRICE_IQD = 25000; // 25,000 دينار عراقي

type Package = {
  id: string;
  name: string;
  credits: number;
  amountIQD: number; // المبلغ بالدينار العراقي
};

const PACKAGES: Package[] = [
  {
    id: "starter",
    name: "باقة البداية",
    credits: 1000,
    amountIQD: PRICE_IQD,
  },
  {
    id: "growth",
    name: "باقة النمو",
    credits: 3000,
    amountIQD: 60000, // 60,000 IQD
  },
  {
    id: "scale",
    name: "باقة التوسع",
    credits: 10000,
    amountIQD: 150000, // 150,000 IQD
  },
];

/**
 * إنشاء عملية الشحن
 */
paymentsRouter.post(
  "/create",
  rateLimit({ windowMs: 60_000, max: 6 }),
  async (req, res) => {
    try {
      const { tenantId, packageId } = req.body ?? {};

      const pkg =
        PACKAGES.find((p) => p.id === packageId) ??
        PACKAGES[0];

      if (!tenantId) {
        return res.status(400).json({
          error: "tenantId ناقص",
        });
      }

      const { data: tenant, error: tenantError } = await db
        .from("tenants")
        .select("id, business_name, credits_remaining, is_active")
        .eq("id", tenantId)
        .maybeSingle();

      if (tenantError) {
        console.error("[payments] tenant lookup:", tenantError);
        return res.status(500).json({
          error: "تعذر قراءة بيانات العميل",
        });
      }

      if (!tenant) {
        return res.status(404).json({
          error: "العميل غير موجود",
        });
      }

      /**
       * =========================================================
       * الوضع التجريبي
       * =========================================================
       */

      if (DEMO_MODE) {
        console.log(
          `[DEMO PAYMENT] منح ${pkg.credits} رصيد للعميل ${tenantId}`
        );

        const currentCredits =
          Number(tenant.credits_remaining) || 0;

        const newCredits =
          currentCredits + pkg.credits;

        const { error: updateError } = await db
          .from("tenants")
          .update({
            credits_remaining: newCredits,
            is_active: true,
            activated_at: new Date().toISOString(),
          })
          .eq("id", tenantId);

        if (updateError) {
          console.error(
            "[DEMO PAYMENT] update error:",
            updateError
          );

          return res.status(500).json({
            error: "تعذر إضافة الرصيد التجريبي",
          });
        }

        /**
         * تسجيل العملية التجريبية في payments
         * حتى تظهر في سجل العمليات.
         */
        const demoReferenceId =
          `demo_${Date.now()}_${Math.random()
            .toString(36)
            .slice(2, 10)}`;

        await db.from("payments").insert({
          tenant_id: tenantId,
          provider: "demo",
          invoice_id: demoReferenceId,
          amount: pkg.amountIQD,
          currency: "IQD",
          status: "paid",
          credits_granted: pkg.credits,
          paid_at: new Date().toISOString(),
          webhook_event: {
            demo: true,
            package_id: pkg.id,
          },
        });

        return res.json({
          success: true,
          demo: true,
          packageId: pkg.id,
          packageName: pkg.name,
          creditsGranted: pkg.credits,
          creditsRemaining: newCredits,
          message: `تمت إضافة ${pkg.credits} رصيد تجريبي بنجاح`,
        });
      }

      /**
       * =========================================================
       * الدفع الحقيقي عبر Wayl
       * =========================================================
       */

      if (!config.wayl?.secretKey) {
        return res.status(500).json({
          error: "WAYL_TOKEN غير مضبوط في الخادم",
        });
      }

      const referenceId = `pay_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 10)}`;

      const waylBody = {
        env: process.env.WAYL_ENV || "test", // test أو live
        referenceId: referenceId,
        total: pkg.amountIQD,
        currency: "IQD",
        customParameter: JSON.stringify({
          tenant_id: tenantId,
          package_id: pkg.id,
        }),
        lineItem: [
          {
            label: `إدارة ســوشـــيــــال — ${pkg.name} (${pkg.credits} رد ذكي)`,
            amount: pkg.amountIQD,
            type: "increase" as const,
          },
        ],
        webhookUrl: `${config.publicUrl}/api/webhooks/wayl`,
        webhookSecret: config.wayl.webhookSecret,
        redirectionUrl: `${config.publicUrl}/payment-status?ref=${referenceId}`,
      };

      const waylResponse = await fetch(
        "https://api.thewayl.com/api/v1/links",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-WAYL-AUTHENTICATION": config.wayl.secretKey,
          },
          body: JSON.stringify(waylBody),
        }
      );

      if (!waylResponse.ok) {
        const errorText = await waylResponse.text();
        console.error(
          `[Wayl] ${waylResponse.status}:`,
          errorText
        );

        return res.status(502).json({
          error: `Wayl ${waylResponse.status}: ${errorText}`,
        });
      }

      const waylData: any = await waylResponse.json();

      const { error: paymentError } = await db
        .from("payments")
        .insert({
          tenant_id: tenantId,
          provider: "wayl",
          invoice_id: referenceId, // نستخدم referenceId كـ invoice_id
          wayl_code: waylData.data?.code,
          amount: pkg.amountIQD,
          currency: "IQD",
          status: "created",
          credits_granted: 0,
        });

      if (paymentError) {
        console.error(
          "[payments] insert error:",
          paymentError
        );

        return res.status(500).json({
          error: "تم إنشاء رابط الدفع لكن تعذر حفظ العملية",
        });
      }

      return res.json({
        invoiceId: referenceId,
        paymentUrl: waylData.data?.url ?? null,
        waylCode: waylData.data?.code ?? null,
      });

    } catch (error: any) {
      console.error(
        "[payments] create error:",
        error
      );

      return res.status(500).json({
        error:
          error?.message ??
          "حدث خطأ أثناء إنشاء عملية الدفع",
      });
    }
  }
);

/**
 * التحقق من توقيع webhook Wayl
 * Wayl يستخدم HMAC-SHA256 مع header x-wayl-signature-256
 */
function verifyWaylSignature(
  rawBody: Buffer | string,
  signature: string | undefined
): boolean {
  if (
    !config.wayl?.webhookSecret ||
    !signature
  ) {
    return false;
  }

  const expected = createHmac(
    "sha256",
    config.wayl.webhookSecret
  )
    .update(rawBody)
    .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");

  return (
    a.length === b.length &&
    timingSafeEqual(a, b)
  );
}

/**
 * Webhook الدفع الحقيقي
 *
 * في DEMO_MODE لا نحتاج webhook لأن الرصيد
 * يُمنح مباشرة من /create.
 */
webhooksRouter.post(
  "/wayl",
  rateLimit({
    windowMs: 60_000,
    max: 30,
  }),
  async (req, res) => {

    if (DEMO_MODE) {
      return res.status(200).json({
        received: true,
        demo: true,
      });
    }

    try {
      // Wayl يرسل JSON raw، نحتاج الـ raw body للتحقق من التوقيع
      const raw: Buffer =
        (req as any).rawBody ??
        Buffer.from(
          JSON.stringify(req.body ?? {})
        );

      const signature =
        (req.headers[
          "x-wayl-signature-256"
        ] as string) ?? "";

      if (
        !verifyWaylSignature(
          raw,
          signature
        )
      ) {
        return res.status(401).json({
          error: "توقيع غير صالح",
        });
      }

      const event = req.body ?? {};

      // Wayl يرسل الحقول مباشرة وليس متداخلة مثل Moyasar
      const referenceId: string | undefined =
        event.referenceId;

      const paymentStatus: string =
        event.paymentStatus ?? "";

      // التحقق من نجاح الدفع
      // الحالات في Wayl: Created, Pending, Processing, Complete, Delivered, Cancelled, Rejected, Returned
      if (
        !referenceId ||
        paymentStatus !== "Complete"
      ) {
        // إذا لم يكن Complete، نحدث الحالة فقط بدون منح رصيد
        if (referenceId) {
          await db
            .from("payments")
            .update({
              status: paymentStatus.toLowerCase(),
              webhook_event: event,
            })
            .eq("invoice_id", referenceId);
        }

        return res.status(200).json({
          received: true,
        });
      }

      const { data: payment } =
        await db
          .from("payments")
          .select("*")
          .eq(
            "invoice_id",
            referenceId
          )
          .maybeSingle();

      /**
       * منع منح الرصيد مرتين
       */
      if (
        !payment ||
        payment.status === "paid"
      ) {
        return res.status(200).json({
          received: true,
        });
      }

      // التحقق من المبلغ (أمان إضافي)
      if (payment.amount !== event.total) {
        console.error(
          `[Wayl] Amount mismatch: expected ${payment.amount}, got ${event.total}`
        );
        // يمكنك اختيار الرفض هنا أو الاستمرار
      }

      const pkg =
        PACKAGES.find(
          (p) =>
            p.amountIQD ===
            payment.amount
        ) ??
        PACKAGES[0];

      await db
        .from("payments")
        .update({
          status: "paid",
          credits_granted:
            pkg.credits,
          webhook_event: event,
          paid_at:
            new Date().toISOString(),
        })
        .eq(
          "id",
          payment.id
        );

      /**
       * منح الرصيد
       */
      await db
        .rpc(
          "grant_credits",
          {
            p_tenant_id:
              payment.tenant_id,
            p_credits:
              pkg.credits,
          }
        )
        .catch(
          async () => {
            const { data: t } =
              await db
                .from("tenants")
                .select(
                  "credits_remaining"
                )
                .eq(
                  "id",
                  payment.tenant_id
                )
                .single();

            await db
              .from("tenants")
              .update({
                credits_remaining:
                  (t?.credits_remaining ?? 0) +
                  pkg.credits,

                is_active: true,

                activated_at:
                  new Date().toISOString(),
              })
              .eq(
                "id",
                payment.tenant_id
              );
          }
        );

      return res.status(200).json({
        received: true,
        activated: true,
      });

    } catch (error: any) {
      console.error(
        "[Wayl webhook] error:",
        error
      );

      return res.status(500).json({
        error:
          error?.message ??
          "خطأ في معالجة الدفع",
      });
    }
  }
);
