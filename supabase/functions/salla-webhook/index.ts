// ═══════════════════════════════════════════════════════════════════
// Edge Function: salla-webhook
// POST من سلة (Salla) عند تثبيت/إلغاء تثبيت التطبيق.
// - يتحقق من x-salla-signature (HMAC-SHA256 hex على الجسم الخام)
// - app.store.authorize: يحفظ التوكنات في salla_stores
// - app.uninstalled: يحذف صف التاجر
//
// Secrets: SALLA_WEBHOOK_SECRET
// ═══════════════════════════════════════════════════════════════════

import { createClient } from "npm:@supabase/supabase-js@2";

const enc = new TextEncoder();

const reply = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });

const toHex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmacHex(secret: string, raw: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(raw)));
}

/** مقارنة بزمن ثابت لتفادي تسريب التوقيع بالتوقيت. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return reply("Method not allowed", 405);

  const secret = Deno.env.get("SALLA_WEBHOOK_SECRET");
  const supaUrl = Deno.env.get("SUPABASE_URL");
  const srvKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!secret || !supaUrl || !srvKey) {
    console.error("[salla-webhook] missing environment variables");
    return reply("server misconfigured", 500);
  }

  // الجسم الخام ضروري لحساب التوقيع — لا نحوّله إلى JSON قبل التحقق
  const raw = await req.text();

  const sigHeader = (req.headers.get("x-salla-signature") ?? "")
    .trim()
    .toLowerCase();

  if (!sigHeader) {
    console.warn("[salla-webhook] missing signature");
    return reply("missing signature", 401);
  }

  const expected = await hmacHex(secret, raw);
  if (!safeEqual(sigHeader, expected)) {
    console.warn("[salla-webhook] invalid signature");
    return reply("invalid signature", 401);
  }

  // من هنا فصاعدًا الطلب موثوق من سلة: نرجع 200 دائمًا
  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    console.warn("[salla-webhook] invalid json");
    return reply("ok");
  }

  const event = String(payload?.event ?? "");
  const merchantId = payload?.merchant != null ? String(payload.merchant) : "";

  if (!merchantId) {
    console.warn("[salla-webhook] no merchant id, event:", event);
    return reply("ok");
  }

  try {
    const sb = createClient(supaUrl, srvKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    if (event === "app.store.authorize") {
      const d = payload?.data ?? {};
      const accessToken = typeof d.access_token === "string" ? d.access_token : "";

      if (!accessToken) {
        console.warn("[salla-webhook] authorize without access_token, merchant:", merchantId);
        return reply("ok");
      }

      const expiresSec = Number(d.expires);
      const expiresAt = Number.isFinite(expiresSec) && expiresSec > 0
        ? new Date(expiresSec * 1000).toISOString()
        : null;

      const { error } = await sb.from("salla_stores").upsert(
        {
          merchant_id: merchantId,
          access_token: accessToken,
          refresh_token: typeof d.refresh_token === "string" ? d.refresh_token : null,
          expires_at: expiresAt,
          scope: typeof d.scope === "string" ? d.scope : null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "merchant_id" },
      );

      if (error) console.error("[salla-webhook] upsert failed:", error.message);
      else console.log("[salla-webhook] store authorized:", merchantId);
    } else if (event === "app.uninstalled") {
      const { error } = await sb
        .from("salla_stores")
        .delete()
        .eq("merchant_id", merchantId);

      if (error) console.error("[salla-webhook] delete failed:", error.message);
      else console.log("[salla-webhook] store uninstalled:", merchantId);
    } else {
      console.log("[salla-webhook] ignored event:", event);
    }
  } catch (e) {
    console.error("[salla-webhook] unexpected error:", (e as Error)?.message);
  }

  return reply("ok");
});
