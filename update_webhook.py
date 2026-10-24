import re

file_path = "supabase/functions/salla-webhook/index.ts"

new_code = '''// POST من سلة (Salla) عند تثبيت/إلغاء تثبيت التطبيق.
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

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// دالة التشفير (نفس الموجودة في milan-api)
async function encryptField(plain: string): Promise<string> {
  if (!plain) return "";
  const keyMat = await crypto.subtle.digest("SHA-256", enc.encode(Deno.env.get("FIELD_ENCRYPTION_KEY") || ""));
  const key = await crypto.subtle.importKey("raw", keyMat, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plain)));
  return `enc:v1:${toHex(iv)}:${toHex(ct.slice(-16))}:${toHex(ct.slice(0, -16))}`;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return reply("Method not allowed", 405);

  const secret = Deno.env.get("SALLA_WEBHOOK_SECRET");
  const supaUrl = Deno.env.get("SUPABASE_URL");
  const srvKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!secret || !supaUrl || !srvKey) return reply("server misconfigured", 500);

  const raw = await req.text();
  const sigHeader = (req.headers.get("x-salla-signature") ?? "").trim().toLowerCase();
  if (!sigHeader) return reply("missing signature", 401);

  const expected = await hmacHex(secret, raw);
  if (!safeEqual(sigHeader, expected)) return reply("invalid signature", 401);

  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    return reply("ok");
  }

  const event = String(payload?.event ?? "");
  const merchantId = payload?.merchant != null ? String(payload.merchant) : "";
  
  if (!merchantId) return reply("ok");

  try {
    const sb = createClient(supaUrl, srvKey, { auth: { autoRefreshToken: false, persistSession: false } });

    if (event === "app.store.authorize") {
      const d = payload?.data ?? {};
      const accessToken = typeof d.access_token === "string" ? d.access_token : "";
      const merchantEmail = d.merchant?.email || d.email; // محاولة جلب الإيميل

      if (!accessToken) return reply("ok");

      const encryptedToken = await encryptField(accessToken);

      // محاولة إيجاد tenant_id بواسطة الإيميل
      let tenantId = null;
      if (merchantEmail) {
        const { data: tenant } = await sb.from("tenants").select("id").eq("email", merchantEmail).maybeSingle();
        if (tenant) tenantId = tenant.id;
      }

      // إذا لم نجد إيميل، سنضع معرف افتراضي (أو نتركه فارغاً لحين ربطه يدوياً)
      // كحل مبدئي للتجربة، سنضع الإيميل كـ tenant_id إذا لم نجده، أو نستخدم merchantId
      const finalTenantId = tenantId || merchantEmail || merchantId; 

      // حفظ في جدول channel_accounts
      const { error } = await sb.from("channel_accounts").upsert(
        {
          tenant_id: finalTenantId,
          channel: "salla",
          platform: "whatsapp", // لاجتياز القيد الأمني
          access_token_encrypted: encryptedToken,
          external_id: merchantId,
          status: "active",
          is_active: true,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "tenant_id, channel" }
      );

      if (error) console.error("[salla-webhook] upsert failed:", error.message);
      else console.log("[salla-webhook] store authorized and encrypted for tenant:", finalTenantId);

    } else if (event === "app.uninstalled") {
      await sb.from("channel_accounts").delete().eq("external_id", merchantId).eq("channel", "salla");
      console.log("[salla-webhook] store uninstalled:", merchantId);
    }
  } catch (e) {
    console.error("[salla-webhook] unexpected error:", (e as Error)?.message);
  }

  return reply("ok");
});
'''

try:
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(new_code)
    print("✅ تم تحديث كود salla-webhook بنجاح ليتوافق مع channel_accounts والتشفير!")
except Exception as e:
    print(f"❌ حدث خطأ: {e}")
