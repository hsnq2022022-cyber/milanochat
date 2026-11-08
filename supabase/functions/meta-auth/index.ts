// ═══════════════════════════════════════════════════════════════════
// Edge Function: meta-auth
// GET /functions/v1/meta-auth/instagram/callback?code=...&state=...
// يستقبل عودة Instagram Login (مسار عام بلا JWT — Meta تعيد المتصفح إليه)،
// يتحقق من state الموقّع، يبدّل code بتوكن طويل الأمد، يحفظ الحساب في
// channel_accounts (توكن مشفّر بنفس صيغة milan-api)، يشترك في webhooks،
// ثم يعيد المستخدم إلى الواجهة.
//
// Secrets: INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET, FIELD_ENCRYPTION_KEY,
//          OAUTH_STATE_SECRET (>= 32 حرفاً، نفس قيمة دالة channels؛ إلزامي)،
//          INSTAGRAM_REDIRECT_URI (يجب أن يطابق المسجّل في Meta تماماً)،
//          FRONTEND_ORIGIN (اختياري، الافتراضي https://hsnq2022022-cyber.github.io)
// ═══════════════════════════════════════════════════════════════════

import { createClient } from "npm:@supabase/supabase-js@2";
import { consumeOAuthState, oauthStateSecret } from "../_shared/oauthState.ts";
import { facebookDb, linkFacebookPages } from "./facebook.ts";

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

// ─── state (S5): verified by ../_shared/oauthState.ts with OAUTH_STATE_SECRET.
// Only the user/tenant inside the verified state are used; never query params.

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

  // Facebook Login (Pages / Messenger): state issued by channels with
  // platform "facebook"; see handleFacebookCallback below.
  if (req.method === "GET" && url.pathname.endsWith("/facebook/callback")) {
    return await handleFacebookCallback(url);
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

    const sb = createClient(supaUrl, srvKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Signature, shape and expiry are verified BEFORE any DB access or
    // token exchange; then the nonce is claimed exactly once (atomic) for
    // the same user/tenant/platform. Missing OAUTH_STATE_SECRET fails closed.
    const st = await consumeOAuthState({
      secret: oauthStateSecret((k) => Deno.env.get(k)),
      state,
      expectedPlatform: "instagram",
      nowSec: Math.floor(Date.now() / 1000),
      claimNonce: async (c) => {
        const { data: claimed, error: claimErr } = await sb
          .from("meta_oauth_states")
          .update({ consumed: true })
          .eq("id", c.nonce)
          .eq("consumed", false)
          .eq("user_id", c.userId)
          .eq("tenant_id", c.tenantId)
          .eq("platform", c.platform)
          .gt("expires_at", new Date().toISOString())
          .select("id")
          .maybeSingle();
        if (claimErr) return "error";
        return claimed ? "claimed" : "not_found";
      },
    });
    if (!st.ok) {
      return fail(st.reason === "config_missing" ? "config_missing" : `oauth_state:${st.reason}`);
    }

    const tenantId: string = st.tenantId;

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

// ─── GET /meta-auth/facebook/callback?code=...&state=... ───
// Secrets: META_APP_ID, META_APP_SECRET, FIELD_ENCRYPTION_KEY,
//          OAUTH_STATE_SECRET, META_REDIRECT_URI (exactly the value channels
//          sends to the dialog; default .../meta-auth/facebook/callback).
// The state is verified and its nonce claimed (platform "facebook") BEFORE
// any DB write or Graph call; the tenant comes ONLY from the verified state.
async function handleFacebookCallback(url: URL): Promise<Response> {
  try {
    const supaUrl = Deno.env.get("SUPABASE_URL");
    const srvKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const appId = Deno.env.get("META_APP_ID");
    const appSecret = Deno.env.get("META_APP_SECRET");

    if (!supaUrl || !srvKey || !appId || !appSecret) {
      console.error("[meta-auth] facebook: missing configuration");
      return fail("config_missing");
    }

    const metaError = url.searchParams.get("error");
    if (metaError) return fail(metaError === "access_denied" ? "user_cancelled" : "oauth_denied");

    const code = (url.searchParams.get("code") ?? "").replace(/#_$/, "");
    const state = url.searchParams.get("state") ?? "";
    if (!code || !state) return fail("missing_params");

    const sb = createClient(supaUrl, srvKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const st = await consumeOAuthState({
      secret: oauthStateSecret((k) => Deno.env.get(k)),
      state,
      expectedPlatform: "facebook",
      nowSec: Math.floor(Date.now() / 1000),
      claimNonce: async (c) => {
        const { data: claimed, error: claimErr } = await sb
          .from("meta_oauth_states")
          .update({ consumed: true })
          .eq("id", c.nonce)
          .eq("consumed", false)
          .eq("user_id", c.userId)
          .eq("tenant_id", c.tenantId)
          .eq("platform", c.platform)
          .gt("expires_at", new Date().toISOString())
          .select("id")
          .maybeSingle();
        if (claimErr) return "error";
        return claimed ? "claimed" : "not_found";
      },
    });
    if (!st.ok) {
      return fail(st.reason === "config_missing" ? "config_missing" : `oauth_state:${st.reason}`);
    }

    const fbTenantId: string = st.tenantId;
    const redirectUri = (Deno.env.get("META_REDIRECT_URI") ?? "").trim().replace(/\/+$/, "") ||
      `${supaUrl}/functions/v1/meta-auth/facebook/callback`;

    const r = await linkFacebookPages(code, {
      fetch: (u, init) => fetch(u, init),
      appId,
      appSecret,
      redirectUri,
      tenantId: fbTenantId,
      encryptField,
      db: facebookDb(sb, fbTenantId),
      nowMs: () => Date.now(),
    });
    if (!r.ok) return fail(r.code);
    return back({ channel_connected: "facebook", name: r.name, count: String(r.saved) });
  } catch (e) {
    console.error("[meta-auth] facebook", e instanceof Error ? e.name : "unknown");
    return fail("unknown");
  }
}
