// ═══════════════════════════════════════════════════════════════════
// Edge Function: meta-auth
// GET /functions/v1/meta-auth/instagram/callback?code=...&state=...
// يستقبل عودة Instagram Login (مسار عام بلا JWT — Meta تعيد المتصفح إليه)،
// يتحقق من state الموقّع، يبدّل code بتوكن طويل الأمد، يحفظ الحساب في
// channel_accounts (توكن مشفّر بنفس صيغة milan-api)، يشترك في webhooks،
// ثم يعيد المستخدم إلى الواجهة.
//
// Secrets: INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET, FIELD_ENCRYPTION_KEY,
//          INSTAGRAM_REDIRECT_URI (يجب أن يطابق المسجّل في Meta تماماً)،
//          FRONTEND_ORIGIN (اختياري، الافتراضي https://hsnq2022022-cyber.github.io)
// ═══════════════════════════════════════════════════════════════════

import { createClient } from "npm:@supabase/supabase-js@2";

const IG_TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const IG_GRAPH_HOST = "https://graph.instagram.com";
const IG_GRAPH_V = `${IG_GRAPH_HOST}/v21.0`;

const enc = new TextEncoder();
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

// ─── تشفير الحقول: مطابق لـ encryptField في milan-api ───
async function encryptField(plain: string): Promise<string> {
  if (!plain) return "";
  const mat = await crypto.subtle.digest(
    "SHA-256",
    enc.encode(Deno.env.get("FIELD_ENCRYPTION_KEY") ?? ""),
  );
  const key = await crypto.subtle.importKey("raw", mat, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plain)),
  );
  return `enc:v1:${hex(iv)}:${hex(ct.slice(-16))}:${hex(ct.slice(0, -16))}`;
}

// ─── state: body.sig (HMAC-SHA256 base64url) كما في channels/buildOAuthState ───
const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf as ArrayBuffer)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function verifyState(
  state: string,
  secret: string,
): Promise<{ ok: true; nonce: string; platform: string } | { ok: false; reason: string }> {
  const [body, sig] = state.split(".");
  if (!body || !sig) return { ok: false, reason: "state_format" };

  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const expected = b64url(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  if (!safeEqual(sig, expected)) return { ok: false, reason: "state_signature" };

  try {
    const padded = body.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (body.length % 4)) % 4);
    const p = JSON.parse(atob(padded));
    if (!p?.i || !p?.exp || Date.now() / 1000 > Number(p.exp)) {
      return { ok: false, reason: "state_expired" };
    }
    return { ok: true, nonce: String(p.i), platform: String(p.p ?? "") };
  } catch {
    return { ok: false, reason: "state_format" };
  }
}

function frontBase(): string {
  const origin = (Deno.env.get("FRONTEND_ORIGIN") || "https://hsnq2022022-cyber.github.io")
    .trim().replace(/\/+$/, "");
  return `${origin}/milanochat/`;
}

// الواجهة تقرأ المعاملات من location.search ثم تنتقل إلى #/dashboard
function back(params: Record<string, string>): Response {
  const q = new URLSearchParams(params).toString();
  return new Response(null, {
    status: 302,
    headers: { Location: `${frontBase()}?${q}#/dashboard`, "Cache-Control": "no-store" },
  });
}

const fail = (code: string) => {
  console.warn("[meta-auth] FAILED →", code);
  return back({ channel_error: code });
};

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // تشخيص: يعرض قيم الإعداد غير السرية فقط (للتحقق من مطابقة redirect_uri)
  if (req.method === "GET" && url.pathname.endsWith("/debug")) {
    const ru = Deno.env.get("INSTAGRAM_REDIRECT_URI") ?? null;
    return new Response(JSON.stringify({
      INSTAGRAM_REDIRECT_URI: ru,
      length: ru?.length ?? 0,
      hasWhitespaceOrQuotes: ru ? /[\s"']/.test(ru) : null,
      expected: `${Deno.env.get("SUPABASE_URL")}/functions/v1/meta-auth/instagram/callback`,
      INSTAGRAM_APP_ID: Deno.env.get("INSTAGRAM_APP_ID") ?? null,
      USE_INSTAGRAM_DIRECT_LOGIN: Deno.env.get("USE_INSTAGRAM_DIRECT_LOGIN") ?? null,
    }, null, 2), { headers: { "Content-Type": "application/json" } });
  }

  if (req.method !== "GET" || !url.pathname.endsWith("/instagram/callback")) {
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const supaUrl = Deno.env.get("SUPABASE_URL");
    const srvKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const igAppId = Deno.env.get("INSTAGRAM_APP_ID");
    const igSecret = Deno.env.get("INSTAGRAM_APP_SECRET");

    if (!supaUrl || !srvKey || !igAppId || !igSecret) {
      console.error("[meta-auth] missing configuration");
      return fail("config_missing");
    }

    const metaError = url.searchParams.get("error");
    if (metaError) return fail(metaError === "access_denied" ? "user_cancelled" : metaError);

    const code = (url.searchParams.get("code") ?? "").replace(/#_$/, "");
    const state = url.searchParams.get("state") ?? "";
    if (!code || !state) return fail("missing_params");

    const st = await verifyState(state, igSecret);
    if (!st.ok) return fail(`oauth_state:${st.reason}`);
    if (st.platform !== "instagram") return fail("oauth_state_platform_mismatch");

    const sb = createClient(supaUrl, srvKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // استهلاك الـ state مرة واحدة (claim ذري)
    const { data: claimed, error: claimErr } = await sb
      .from("meta_oauth_states")
      .update({ consumed: true })
      .eq("id", st.nonce)
      .eq("consumed", false)
      .gt("expires_at", new Date().toISOString())
      .select("tenant_id, platform")
      .maybeSingle();

    if (claimErr) {
      console.error("[meta-auth] state claim error", claimErr.message);
      return fail("db_error");
    }
    if (!claimed) return fail("oauth_state:state_reused");
    if (claimed.platform !== "instagram") return fail("oauth_state_platform_mismatch");

    const tenantId: string = claimed.tenant_id;

    // نفس redirect_uri الذي أُرسل في طلب التفويض
    const redirectUri = Deno.env.get("INSTAGRAM_REDIRECT_URI") ||
      `${supaUrl}/functions/v1/meta-auth/instagram/callback`;

    // 1) code → short-lived token
    const tRes = await fetch(IG_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: igAppId,
        client_secret: igSecret,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code,
      }),
    });
    const tJson: any = await tRes.json().catch(() => ({}));
    const first = Array.isArray(tJson?.data) ? tJson.data[0] : tJson;
    const shortToken: string | undefined = first?.access_token;
    if (!shortToken) {
      console.error("[meta-auth] token exchange failed:", tJson?.error_message ?? tJson?.error?.message ?? "unknown");
      return fail("oauth_token_exchange");
    }

    // 2) → long-lived (60 يوماً)
    let token = shortToken;
    let expiresIn = 3600;
    const lRes = await fetch(
      `${IG_GRAPH_HOST}/access_token?grant_type=ig_exchange_token` +
        `&client_secret=${encodeURIComponent(igSecret)}&access_token=${encodeURIComponent(shortToken)}`,
    );
    const lJson: any = await lRes.json().catch(() => ({}));
    if (lJson?.access_token) {
      token = lJson.access_token;
      expiresIn = Number(lJson.expires_in ?? 5184000);
    } else {
      console.warn("[meta-auth] long-lived exchange failed:", lJson?.error?.message ?? "unknown");
    }

    // 3) بيانات الحساب
    const pRes = await fetch(
      `${IG_GRAPH_V}/me?fields=user_id,username,name,profile_picture_url,account_type` +
        `&access_token=${encodeURIComponent(token)}`,
    );
    const prof: any = await pRes.json().catch(() => ({}));
    const igId = String(prof?.user_id ?? prof?.id ?? first?.user_id ?? "");
    if (!igId || igId === "undefined") {
      console.error("[meta-auth] /me failed:", prof?.error?.message ?? "no id");
      return fail("no_eligible_instagram");
    }
    if (prof?.account_type && !["BUSINESS", "MEDIA_CREATOR"].includes(prof.account_type)) {
      return fail("no_eligible_instagram — الحساب يجب أن يكون Business أو Creator");
    }

    // الحساب غير مربوط بعميل آخر
    const { data: taken } = await sb
      .from("channel_accounts")
      .select("tenant_id")
      .eq("channel", "instagram")
      .eq("external_id", igId)
      .neq("tenant_id", tenantId)
      .eq("status", "active")
      .maybeSingle();
    if (taken) return fail("account_already_linked");

    // 4) الحفظ
    const username = prof?.username ? `@${prof.username}` : (prof?.name ?? null);
    const now = new Date().toISOString();

    const { error: upErr } = await sb.from("channel_accounts").upsert(
      {
        tenant_id: tenantId,
        channel: "instagram",
        platform: "instagram",
        external_id: igId,
        display_name: username,
        avatar_url: typeof prof?.profile_picture_url === "string" && prof.profile_picture_url
          ? prof.profile_picture_url
          : null,
        status: "active",
        is_active: true,
        access_token_encrypted: await encryptField(token),
        token_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
        connected_at: now,
        updated_at: now,
      },
      { onConflict: "tenant_id,channel,external_id" },
    );
    if (upErr) {
      console.error("[meta-auth] channel_accounts upsert failed:", upErr.message);
      return fail("db_save_failed");
    }

    // 5) اشتراك webhooks
    try {
      const sRes = await fetch(
        `${IG_GRAPH_V}/me/subscribed_apps?subscribed_fields=messages,messaging_postbacks,messaging_seen` +
          `&access_token=${encodeURIComponent(token)}`,
        { method: "POST" },
      );
      const sJson: any = await sRes.json().catch(() => ({}));
      if (!sJson?.success) {
        console.error("[meta-auth] subscribed_apps failed:", sJson?.error?.message ?? JSON.stringify(sJson));
      }
    } catch (e) {
      console.error("[meta-auth] subscribed_apps error:", e instanceof Error ? e.message : e);
    }

    console.log("[meta-auth] instagram linked:", igId);
    return back({ channel_connected: "instagram", name: username ?? "" });
  } catch (e) {
    console.error("[meta-auth]", e);
    return fail(e instanceof Error ? e.message.slice(0, 120) : "unknown");
  }
});
