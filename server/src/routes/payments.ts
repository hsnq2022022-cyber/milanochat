/**
 * الدفع عبر Moyasar + الوضع التجريبي
 *
 * DEMO_MODE=true:
 *   - لا يتم الاتصال بـ Moyasar.
 *   - يتم منح الرصيد التجريبي مباشرة.
 *
 * DEMO_MODE=false:
 *   - يتم استخدام Moyasar للدفع الحقيقي.
 */

import { Router } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { db } from "../db.js";
import { rateLimit } from "../middleware/rateLimit.js";

export const paymentsRouter = Router();
export const webhooksRouter = Router();

const DEMO_MODE = process.env.DEMO_MODE === "true";

const PRICE_SAR = 99;

type Package = {
  id: string;
  name: string;
  credits: number;
  amountHalalas: number;
};

const PACKAGES: Package[] = [
  {
    id: "starter",
    name: "باقة البداية",
    credits: 1000,
    amountHalalas: PRICE_SAR * 100,
  },
  {
    id: "growth",
    name: "باقة النمو",
    credits: 3000,
    amountHalalas: 249 * 100,
  },
  {
    id: "scale",
    name: "باقة التوسع",
    credits: 10000,
    amountHalalas: 649 * 100,
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
        const demoInvoiceId =
          `demo_${Date.now()}_${Math.random()
            .toString(36)
            .slice(2, 10)}`;

        await db.from("payments").insert({
          tenant_id: tenantId,
          provider: "demo",
          invoice_id: demoInvoiceId,
          amount: pkg.amountHalalas,
          currency: "SAR",
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
       * الدفع الحقيقي عبر Moyasar
       * =========================================================
       */

      if (!config.moyasar.secretKey) {
        return res.status(500).json({
          error: "MOYASAR_SECRET_KEY غير مضبوط في الخادم",
        });
      }

      const invoiceBody = {
        amount: pkg.amountHalalas,
        currency: "SAR",
        description:
          `ميلانو — ${pkg.name} (${pkg.credits} رد ذكي) — ${tenant.business_name}`,
        callback_url:
          `${config.publicUrl}/api/webhooks/moyasar`,
        metadata: {
          tenant_id: tenantId,
          package_id: pkg.id,
        },
      };

      const authorization = Buffer.from(
        `${config.moyasar.secretKey}:`
      ).toString("base64");

      const moyasar = await fetch(
        "https://api.moyasar.com/v1/invoices",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Basic ${authorization}`,
          },
          body: JSON.stringify(invoiceBody),
        }
      );

      if (!moyasar.ok) {
        const errorText = await moyasar.text();

        console.error(
          `[Moyasar] ${moyasar.status}:`,
          errorText
        );

        return res.status(502).json({
          error:
            `Moyasar ${moyasar.status}: ${errorText}`,
        });
      }

      const invoice: any = await moyasar.json();

      const { error: paymentError } = await db
        .from("payments")
        .insert({
          tenant_id: tenantId,
          provider: "moyasar",
          invoice_id: invoice.id,
          amount: pkg.amountHalalas,
          currency: "SAR",
          status: "created",
          credits_granted: 0,
        });

      if (paymentError) {
        console.error(
          "[payments] insert error:",
          paymentError
        );

        return res.status(500).json({
          error: "تم إنشاء الفاتورة لكن تعذر حفظ العملية",
        });
      }

      return res.json({
        invoiceId: invoice.id,
        paymentUrl:
          invoice.transaction?.url ??
          invoice.url ??
          null,
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
 * التحقق من توقيع webhook Moyasar
 */
function verifySignature(
  rawBody: Buffer,
  signature: string | undefined
): boolean {
  if (
    !config.moyasar.webhookSecret ||
    !signature
  ) {
    return false;
  }

  const expected = createHmac(
    "sha256",
    config.moyasar.webhookSecret
  )
    .update(rawBody)
    .digest("hex");

  const a = Buffer.from(
    expected,
    "utf8"
  );

  const b = Buffer.from(
    signature,
    "utf8"
  );

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
  "/moyasar",
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
      const raw: Buffer =
        (req as any).rawBody ??
        Buffer.from(
          JSON.stringify(req.body ?? {})
        );

      const signature =
        (req.headers[
          "moyasar-signature"
        ] as string) ??
        (req.headers[
          "x-moyasar-signature"
        ] as string);

      if (
        !verifySignature(
          raw,
          signature
        )
      ) {
        return res.status(401).json({
          error: "توقيع غير صالح",
        });
      }

      const event = req.body ?? {};

      const type: string =
        event.type ?? "";

      const data =
        event.data ?? {};

      const invoiceId:
        | string
        | undefined =
        data.invoice_id ??
        data.id;

      if (
        !invoiceId ||
        !/paid|succeeded/.test(type)
      ) {
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
            invoiceId
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

      const pkg =
        PACKAGES.find(
          (p) =>
            p.amountHalalas ===
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
                  (t?.credits_remaining ??
                    0) +
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
        "[Moyasar webhook] error:",
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
