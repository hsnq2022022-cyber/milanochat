// ═══════════════════════════════════════════════════════════════════
// Edge Function: topup-create
// شحن رصيد الردود بالدينار العراقي عبر Wayl (بديل Moyasar/SAR).
//
// POST { packageId: "starter"|"growth"|"scale", returnUrl? }  (Bearer: Supabase user JWT)
// → { invoiceId, paymentUrl }
//
// - السعر والرصيد يُحدَّدان هنا فقط (الخادم) ولا يُقبلان من العميل
// - يُنشئ صفاً في payments (provider=wayl, currency=IQD) ثم رابط دفع في Wayl
// - منح الرصيد يتم في wayl-webhook عند تأكيد الدفع
//
// Secrets: WAYL_TOKEN, WAYL_WEBHOOK_SECRET, WAYL_ENV (test|live، الافتراضي test)
// ═══════════════════════════════════════════════════════════════════

import { createClient } from "npm:@supabase/supabase-js@2";

const WAYL_API = "https://api.thewayl.com/api/v1/links";

/** الباقات بالدينار العراقي. عدّل الأسعار هنا (وفي src/pages/Dashboard.tsx للعرض). */
const PACKAGES: Record<string, { name: string; credits: number; amount: number }> = {
  starter: { name: "باقة البداية", credits: 1000, amount: 35000 },
  growth: { name: "باقة النمو", credits: 3000, amount: 85000 },
  scale: { name: "باقة التوسع", credits: 10000, amount: 225000 },
};

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
  });

/** رابط العودة: نفس Origin الطلب فقط وبـ HTTPS (يمنع التحويل لمواقع أخرى). */
function returnUrl(req: Request, requested: unknown): string | null {
  const origin = (req.headers.get("origin") ?? "").trim().replace(/\/+$/, "");
  const site = (Deno.env.get("SITE_URL") ?? "").trim().replace(/\/+$/, "");

  if (typeof requested === "string" && /^https:\/\//i.test(origin)) {
    try {
      const u = new URL(requested);
      if (u.origin === origin) return u.origin + u.pathname + u.search;
    } catch {
      /* تجاهل */
    }
  }

  if (/^https:\/\//i.test(site)) return site + "/";
  if (/^https:\/\//i.test(origin)) return origin + "/milanochat/";

  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: cors });
  }

  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const supaUrl = Deno.env.get("SUPABASE_URL");
    const srvKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const waylToken = Deno.env.get("WAYL_TOKEN");
    const waylSecret = Deno.env.get("WAYL_WEBHOOK_SECRET");

    if (!supaUrl || !srvKey) return json({ error: "إعدادات الخادم ناقصة" }, 500);

    if (!waylToken || !waylSecret || waylSecret.length < 32) {
      console.error("[topup-create] WAYL_TOKEN / WAYL_WEBHOOK_SECRET missing or too short");
      return json({ error: "بوابة الدفع غير مهيأة بعد" }, 500);
    }

    const sb = createClient(supaUrl, srvKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // ─── المصادقة ───
    const header = req.headers.get("authorization") ?? "";
    const jwt = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!jwt) return json({ error: "غير مصرح" }, 401);

    const { data: userData, error: userErr } = await sb.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "جلسة غير صالحة" }, 401);

    const { data: tenant } = await sb
      .from("tenants")
      .select("id, business_name")
      .eq("user_id", userData.user.id)
      .maybeSingle();

    if (!tenant) return json({ error: "لا يوجد حساب مرتبط" }, 404);

    // ─── الباقة (من الخادم فقط) ───
    const body = await req.json().catch(() => ({}));
    const pkg = PACKAGES[String(body?.packageId ?? "")] ?? PACKAGES.starter;
    const pkgId = PACKAGES[String(body?.packageId ?? "")] ? String(body.packageId) : "starter";

    const back = returnUrl(req, body?.returnUrl);
    if (!back) return json({ error: "تعذر تحديد رابط العودة" }, 400);

    // ─── سجل الدفع ───
    const { data: payment, error: payErr } = await sb
      .from("payments")
      .insert({
        tenant_id: tenant.id,
        provider: "wayl",
        amount: pkg.amount,
        currency: "IQD",
        status: "created",
        credits_granted: 0,
        webhook_event: { package: pkgId, credits: pkg.credits },
      })
      .select("id")
      .single();

    if (payErr || !payment) {
      console.error("[topup-create] insert payment failed", payErr);
      return json({ error: "تعذر إنشاء عملية الدفع" }, 500);
    }

    // ─── رابط Wayl ───
    const env = (Deno.env.get("WAYL_ENV") ?? "test").toLowerCase() === "live" ? "live" : "test";

    const waylRes = await fetch(WAYL_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-WAYL-AUTHENTICATION": waylToken,
      },
      body: JSON.stringify({
        env,
        referenceId: payment.id,
        total: pkg.amount,
        currency: "IQD",
        customParameter: "",
        lineItem: [{
          label: `ميلانو — ${pkg.name} (${pkg.credits} رد)`,
          amount: pkg.amount,
          type: "increase",
        }],
        webhookUrl: `${supaUrl}/functions/v1/wayl-webhook`,
        webhookSecret: waylSecret,
        redirectionUrl: back,
      }),
    });

    const waylText = await waylRes.text();
    let waylJson: any = {};
    try {
      waylJson = JSON.parse(waylText);
    } catch {
      /* ليس JSON */
    }

    const paymentUrl: string | undefined = waylJson?.data?.url;
    const code: string | undefined = waylJson?.data?.code;

    if (!waylRes.ok || !paymentUrl) {
      console.error(`[topup-create] wayl ${waylRes.status}: ${waylText.slice(0, 500)}`);

      await sb.from("payments").update({ status: "failed" }).eq("id", payment.id);

      return json({ error: "تعذر إنشاء رابط الدفع، حاول لاحقاً" }, 502);
    }

    await sb.from("payments").update({ invoice_id: code ?? payment.id }).eq("id", payment.id);

    return json({ invoiceId: payment.id, paymentUrl });
  } catch (e) {
    console.error("[topup-create]", e);
    return json({ error: e instanceof Error ? e.message : "خطأ داخلي" }, 500);
  }
});
