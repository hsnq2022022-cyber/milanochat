// Edge Function: meta-auth (Instagram Login callback)
// Deploy with: supabase functions deploy meta-auth --no-verify-jwt
import { createClient } from "npm:@supabase/supabase-js@2";

const IG_TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const IG_GRAPH_HOST = "https://graph.instagram.com";
const IG_GRAPH_V = `${IG_GRAPH_HOST}/v21.0`;

const enc = new TextEncoder();
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

// FIX: قراءة الأسرار بعد إزالة المسافات والأسطر المخفية (نفس منطق channels)
function envTrim(name: string): string | undefined {
  const v = Deno.env.get(name);
  if (v === undefined || v === null) return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

// FIX: نفس الرابط الدقيق الذي تبني به دالة channels رابط التفويض
function canonicalIgRedirect(): string {
  const base = (envTrim("SUPABASE_URL") ?? "").replace(/\/+$/, "");
  return `${base}/functions/v1/meta-auth/instagram/callback`;
}

async function encryptField(plain: string): Promise<string> {
  if (!plain) return "";
  // FIX: لا نشفّر أبداً بمفتاح فارغ (كان يحدث بصمت)
  const secret = envTrim("FIELD_ENCRYPTION_KEY");
  if (!secret) throw new Error("FIELD_ENCRYPTION_KEY_missing");
  const mat = await crypto.subtle.digest("SHA-256", enc.encode(secret));
  const key = await crypto.subtle.importKey("raw", mat, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plain)),
  );
  return `enc:v1:${hex(iv)}:${hex(ct.slice(-16))}:${hex(ct.slice(0, -16))}`;
}

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

function back(params: Record<string, string>): Response {
  const q = new URLSearchParams(params).toString();
  return new Response(null, {
    status: 302,
    headers: { Location: `${frontBase()}?${q}#/dashboard`, "Cache-Control": "no-store" },
  });
}

const fail = (code: string) => {
  console.warn("[meta-auth] FAILED ->", code);
  return back({ channel_error: code });
};

// Safe log tag for database-client errors: the SQLSTATE/PGRST code, else the error class name.
// Never the message: a network failure embeds the REST request URL (filters, state nonce) in it.
function dbErrTag(err: any): string {
  const code = typeof err?.code === "string" ? err.code : "";
  if (/^[A-Za-z0-9_]{1,16}$/.test(code)) return code;
  const m = typeof err?.message === "string" ? err.message.match(/^([A-Za-z][A-Za-z0-9]{0,40}Error)\b/) : null;
  return m ? m[1] : "unknown";
}

// Safe log tag for a Meta API error body: numeric code or short type only, never the free-text
// message (Graph errors such as "Malformed access token <token>" can echo the credential).
function metaErrTag(j: any): string {
  for (const v of [j?.error?.code, j?.code, j?.error?.type, j?.error_type]) {
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    if (typeof v === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(v)) return v;
  }
  return "unknown";
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // ─── FIX: channels يبني رابط Facebook callback نحو هذه الدالة؛ كان يعطي 404 JSON ───
  if (req.method === "GET" && url.pathname.endsWith("/facebook/callback")) {
    console.warn("[meta-auth] facebook callback is not handled by this function");
    return fail("facebook_callback_not_supported");
  }

  if (req.method !== "GET" || !url.pathname.endsWith("/instagram/callback")) {
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const supaUrl = envTrim("SUPABASE_URL");
    const srvKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const igAppId = envTrim("INSTAGRAM_APP_ID");
    const igSecret = envTrim("INSTAGRAM_APP_SECRET");

    if (!supaUrl || !srvKey || !igAppId || !igSecret) {
      console.error("[meta-auth] missing configuration");
      return fail("config_missing");
    }

    const metaError = url.searchParams.get("error");
    if (metaError === "access_denied") return fail("user_cancelled");
    if (metaError) {
      // The value is attacker-controlled: it is still passed back to the client unchanged
      // (same redirect), but never written to logs.
      console.warn("[meta-auth] FAILED -> provider_error");
      return back({ channel_error: metaError });
    }

    const code = (url.searchParams.get("code") ?? "").replace(/#_$/, "");
    const state = url.searchParams.get("state") ?? "";
    if (!code || !state) return fail("missing_params");

    const st = await verifyState(state, igSecret);
    if (!st.ok) return fail(`oauth_state:${st.reason}`);
    if (st.platform !== "instagram") return fail("oauth_state_platform_mismatch");

    const sb = createClient(supaUrl, srvKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: claimed, error: claimErr } = await sb
      .from("meta_oauth_states")
      .update({ consumed: true })
      .eq("id", st.nonce)
      .eq("consumed", false)
      .gt("expires_at", new Date().toISOString())
      .select("tenant_id, platform")
      .maybeSingle();

    if (claimErr) {
      console.error("[meta-auth] state claim error:", dbErrTag(claimErr));
      return fail("db_error");
    }
    if (!claimed) return fail("oauth_state:state_reused");
    if (claimed.platform !== "instagram") return fail("oauth_state_platform_mismatch");

    const tenantId: string = claimed.tenant_id;

    // FIX: نفس redirect_uri المستخدم في طلب التفويض (محسوب، لا من السر)
    const redirectUri = canonicalIgRedirect();

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
      console.error("[meta-auth] token exchange failed:", metaErrTag(tJson));
      return fail("oauth_token_exchange");
    }

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
      console.warn("[meta-auth] long-lived exchange failed:", metaErrTag(lJson));
    }

    const pRes = await fetch(
      `${IG_GRAPH_V}/me?fields=user_id,username,name,profile_picture_url,account_type` +
        `&access_token=${encodeURIComponent(token)}`,
    );
    const prof: any = await pRes.json().catch(() => ({}));
    const igId = String(prof?.user_id ?? prof?.id ?? first?.user_id ?? "");
    if (!igId || igId === "undefined") {
      console.error("[meta-auth] /me failed:", prof?.error ? metaErrTag(prof) : "no id");
      return fail("no_eligible_instagram");
    }
    if (
      prof?.account_type &&
      !["BUSINESS", "MEDIA_CREATOR"].includes(String(prof.account_type).toUpperCase())
    ) {
      return fail("no_eligible_instagram");
    }

    const { data: taken } = await sb
      .from("channel_accounts")
      .select("tenant_id")
      .eq("channel", "instagram")
      .eq("external_id", igId)
      .neq("tenant_id", tenantId)
      .eq("status", "active")
      .maybeSingle();
    if (taken) return fail("account_already_linked");

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
      console.error("[meta-auth] channel_accounts upsert failed:", dbErrTag(upErr));
      return fail("db_save_failed");
    }

    try {
      const sRes = await fetch(
        `${IG_GRAPH_V}/me/subscribed_apps?subscribed_fields=messages,messaging_postbacks,messaging_seen` +
          `&access_token=${encodeURIComponent(token)}`,
        { method: "POST" },
      );
      const sJson: any = await sRes.json().catch(() => ({}));
      if (!sJson?.success) {
        console.error("[meta-auth] subscribed_apps failed:", sJson?.error ? metaErrTag(sJson) : "no_success");
      }
    } catch (e) {
      console.error("[meta-auth] subscribed_apps error:", e instanceof Error ? e.name : "unknown");
    }

    console.log("[meta-auth] instagram linked:", igId);
    return back({ channel_connected: "instagram", name: username ?? "" });
  } catch (e) {
    console.error("[meta-auth] unexpected error:", e instanceof Error ? e.name : "unknown");
    // FIX: لا نمرّر نص الخطأ الداخلي في رابط العودة
    const msg = e instanceof Error ? e.message : "";
    return fail(msg === "FIELD_ENCRYPTION_KEY_missing" ? "config_missing" : "unexpected_error");
  }
});