// ═══════════════════════════════════════════════════════════════════
// Edge Function: channels (standalone)
// Endpoints: /channels/accounts, /channels/summary, /channels/meta/status, /channels/meta/oauth-url
// ═══════════════════════════════════════════════════════════════════

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-hub-signature-256",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};

let _admin: SupabaseClient | null = null;
function getAdmin(): SupabaseClient {
  if (_admin) return _admin;
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  _admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _admin;
}

type ChannelId = "whatsapp" | "instagram" | "facebook";
const VALID_CHANNELS: ChannelId[] = ["whatsapp", "instagram", "facebook"];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── FIX: قراءة الأسرار مع إزالة المسافات والأسطر المخفية ───
function envTrim(name: string): string | undefined {
  const v = Deno.env.get(name);
  if (v === undefined || v === null) return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

// ─── FIX: تفسير مرن للقيمة المنطقية (true / True / 1 / yes) ───
function envFlag(name: string): boolean {
  const v = (Deno.env.get(name) ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

// ─── FIX: الأساس الثابت للروابط (بدل الاعتماد على url.origin) ───
function getBaseUrl(reqUrl: URL): string {
  return (envTrim("SUPABASE_URL") ?? reqUrl.origin).replace(/\/+$/, "");
}

async function requireAuth(req: Request): Promise<{ userId: string } | Response> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return jsonResponse({ error: "غير مصرح" }, 401);

  const { data, error } = await getAdmin().auth.getUser(token);
  if (error || !data?.user) return jsonResponse({ error: "جلسة غير صالحة" }, 401);

  return { userId: data.user.id };
}

async function ownedTenant(userId: string, tenantId?: string | null) {
  const supabase = getAdmin();

  if (tenantId) {
    const { data } = await supabase
      .from("tenants").select("*")
      .eq("id", tenantId).eq("user_id", userId).maybeSingle();
    if (data) return data;
  }

  const { data: existing } = await supabase
    .from("tenants").select("*").eq("user_id", userId).maybeSingle();
  if (existing) return existing;

  const { data: created, error: createErr } = await supabase
    .from("tenants")
    .insert({ user_id: userId, name: "Default" })
    .select().maybeSingle();

  if (createErr) {
    console.error("[channels] failed to create default tenant:", createErr);
    return null;
  }
  return created;
}

function normalizeAccount(row: any) {
  const channel = row.channel || row.platform || "whatsapp";
  return {
    id: row.id, tenantId: row.tenant_id ?? null, channel, platform: channel,
    externalId: row.external_id ?? row.platform_account_id ?? null,
    platformAccountId: row.platform_account_id ?? row.external_id ?? null,
    displayName: row.display_name ?? row.account_name ?? null,
    accountName: row.account_name ?? row.display_name ?? null,
    avatarUrl: row.avatar_url ?? row.account_avatar ?? null,
    accountAvatar: row.account_avatar ?? row.avatar_url ?? null,
    status: row.status ?? (row.is_active === false ? "inactive" : "active"),
    isActive: row.is_active !== false,
    agentEnabled: row.agent_enabled !== false,
    autoReply: row.auto_reply !== false,
    language: row.language ?? "ar",
    handoffRules: row.handoff_rules ?? {},
    agentConfig: row.agent_config ?? {},
    tokenExpiresAt: row.token_expires_at ?? null,
    connectedAt: row.connected_at ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

// ─── بناء OAuth State (موحد) ───
async function buildOAuthState(opts: {
  userId: string; tenantId: string; platform: string; secret: string;
}) {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const exp = Math.floor(Date.now() / 1000) + 15 * 60;
  const payload = { u: opts.userId, t: opts.tenantId, p: opts.platform, i: nonce, exp };
  const body = btoa(JSON.stringify(payload))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(opts.secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const state = `${body}.${sigB64}`;

  await getAdmin().from("meta_oauth_states").insert({
    id: nonce, user_id: opts.userId, tenant_id: opts.tenantId,
    platform: opts.platform, expires_at: new Date(exp * 1000).toISOString(),
    consumed: false,
  });

  return state;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/channels\/?/, "");
  const parts = path.split("/").filter(Boolean);
  const query = url.searchParams;

  try {
    // ─── GET /channels/meta/status (public) ───
    if (parts[0] === "meta" && parts[1] === "status" && req.method === "GET") {
      const configured = Boolean(
        Deno.env.get("META_APP_ID") && Deno.env.get("META_APP_SECRET"),
      );
      return jsonResponse({
        configured,
        channels: null,
        appReviewNote: "حالة مراجعة صلاحيات Meta تُتابَع يدويًا من لوحة Meta Developers.",
        developersUrl: "https://developers.facebook.com/apps",
      });
    }

    // ─── باقي الـ endpoints تحتاج auth ───
    const auth = await requireAuth(req);
    if (auth instanceof Response) return auth;
    const { userId } = auth;

    // ═══════════════════════════════════════════════════════
    // ─── GET /channels/meta/oauth-url ───
    // ═══════════════════════════════════════════════════════
    if (parts[0] === "meta" && parts[1] === "oauth-url" && req.method === "GET") {
      const channel = query.get("channel") as ChannelId | null;

      if (!channel || !VALID_CHANNELS.includes(channel)) {
        return jsonResponse({ error: "قناة غير مدعومة" }, 400);
      }

      const tenant = await ownedTenant(userId, query.get("tenantId"));
      if (!tenant) return jsonResponse({ error: "لا يوجد حساب مرتبط" }, 404);

      const baseUrl = getBaseUrl(url);
      const wantDebug = query.get("debug") === "1";

      // ═══════════════════════════════════════════
      // 1) Instagram Login المباشر
      // ═══════════════════════════════════════════
      const directFlag = envFlag("USE_INSTAGRAM_DIRECT_LOGIN");

      // ===== DIAGNOSTIC (مؤقت - احذفه بعد التشخيص) =====
      if (channel === "instagram") {
        console.log("[IG-DIAG] USE_INSTAGRAM_DIRECT_LOGIN raw =", JSON.stringify(Deno.env.get("USE_INSTAGRAM_DIRECT_LOGIN")));
        console.log("[IG-DIAG] direct login enabled =", directFlag);
        console.log("[IG-DIAG] baseUrl =", JSON.stringify(baseUrl), "| req origin =", JSON.stringify(url.origin));
      }
      // ==================================================

      if (channel === "instagram" && directFlag) {
        const igAppId = envTrim("INSTAGRAM_APP_ID");
        const igSecret = envTrim("INSTAGRAM_APP_SECRET");
        const igRedirectEnv = envTrim("INSTAGRAM_REDIRECT_URI");

        // الرابط المسجل في Meta (Instagram Business Login) بصيغته الدقيقة
        const igRedirectCanonical = `${baseUrl}/functions/v1/meta-auth/instagram/callback`;

        if (!igAppId || !igSecret) {
          return jsonResponse({
            error: "instagram_oauth_not_configured",
            message: "إعدادات Instagram Login المباشر غير مكتملة.",
          }, 400);
        }

        // FIX: نعتمد الرابط الدقيق المحسوب، ونحذّر إن اختلف السر عنه
        const igRedirectUri = igRedirectCanonical;
        const redirectMatchesEnv = igRedirectEnv === igRedirectCanonical;
        if (igRedirectEnv && !redirectMatchesEnv) {
          console.warn(
            "[IG-DIAG] INSTAGRAM_REDIRECT_URI secret differs from canonical!",
            JSON.stringify({ secret: igRedirectEnv, canonical: igRedirectCanonical }),
          );
        }

        const state = await buildOAuthState({
          userId, tenantId: tenant.id, platform: "instagram", secret: igSecret,
        });

        const igScopes = [
          "instagram_business_basic",
          "instagram_business_manage_messages",
        ];

        const igUrl =
          `https://www.instagram.com/oauth/authorize` +
          `?force_reauth=true` +
          `&client_id=${encodeURIComponent(igAppId)}` +
          `&redirect_uri=${encodeURIComponent(igRedirectUri)}` +
          `&response_type=code` +
          `&scope=${encodeURIComponent(igScopes.join(","))}` +
          `&state=${encodeURIComponent(state)}`;

        // ===== DIAGNOSTIC (مؤقت - احذفه بعد التشخيص) =====
        console.log("[IG-DIAG] INSTAGRAM_APP_ID =", JSON.stringify(igAppId), "length =", igAppId.length);
        console.log("[IG-DIAG] INSTAGRAM_REDIRECT_URI (secret) =", JSON.stringify(Deno.env.get("INSTAGRAM_REDIRECT_URI")));
        console.log("[IG-DIAG] redirect used =", JSON.stringify(igRedirectUri), "length =", igRedirectUri.length);
        console.log("[IG-DIAG] encoded redirect_uri =", encodeURIComponent(igRedirectUri));
        console.log("[IG-DIAG] secret matches canonical =", redirectMatchesEnv);
        console.log("[IG-DIAG] FINAL AUTH URL (without state) =", igUrl.replace(/&state=.*$/, ""));
        // ==================================================

        const result: Record<string, unknown> = { url: igUrl, state, provider: "instagram" };
        if (wantDebug) {
          result.debug = {
            clientId: igAppId,
            redirectUri: igRedirectUri,
            redirectSecretMatchesCanonical: redirectMatchesEnv,
            directLogin: directFlag,
          };
        }
        return jsonResponse(result);
      }

      // ═══════════════════════════════════════════
      // 2) Facebook Login (facebook أو instagram عبر FB)
      // ═══════════════════════════════════════════
      const appId = envTrim("META_APP_ID");
      const appSecret = envTrim("META_APP_SECRET");

      if (!appId || !appSecret) {
        return jsonResponse({
          error: "oauth_not_configured",
          message: "تطبيق Meta غير مُهيّأ على الخادم.",
        }, 400);
      }

      const redirectUri = `${baseUrl}/functions/v1/meta-auth/facebook/callback`;

      const state = await buildOAuthState({
        userId, tenantId: tenant.id, platform: channel, secret: appSecret,
      });

      const scopes: Record<ChannelId, string[]> = {
        facebook: [
          "pages_show_list", "pages_messaging", "pages_manage_metadata",
          "pages_read_engagement", "business_management",
        ],
        instagram: [
          "instagram_basic", "instagram_manage_messages", "pages_read_engagement",
          "pages_show_list", "business_management", "pages_manage_metadata",
          "pages_messaging",
        ],
        whatsapp: [],
      };

      const oauthUrl =
        `https://www.facebook.com/v21.0/dialog/oauth` +
        `?client_id=${encodeURIComponent(appId)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&state=${encodeURIComponent(state)}` +
        `&scope=${encodeURIComponent(scopes[channel].join(","))}` +
        `&response_type=code`;

      if (channel === "instagram") {
        console.warn("[IG-DIAG] FALLING BACK TO FACEBOOK LOGIN for instagram (direct login flag is off)");
      }

      const fbResult: Record<string, unknown> = { url: oauthUrl, state, provider: "facebook" };
      if (wantDebug) {
        fbResult.debug = { clientId: appId, redirectUri, directLogin: directFlag };
      }
      return jsonResponse(fbResult);
    }

    // ─── GET /channels/accounts ───
    if (parts[0] === "accounts" && parts.length === 1 && req.method === "GET") {
      const tenant = await ownedTenant(userId, query.get("tenantId"));
      if (!tenant) return jsonResponse({ error: "لا يوجد حساب مرتبط" }, 404);

      const { data, error } = await getAdmin()
        .from("channel_accounts").select("*")
        .eq("tenant_id", tenant.id).order("created_at", { ascending: false });

      if (error) {
        console.error("[Channels] accounts select error:", error);
        return jsonResponse([]);
      }
      return jsonResponse((data ?? []).map(normalizeAccount));
    }

    // ─── GET /channels/summary ───
    if (parts[0] === "summary" && req.method === "GET") {
      const tenant = await ownedTenant(userId, query.get("tenantId"));
      if (!tenant) return jsonResponse({ error: "لا يوجد حساب مرتبط" }, 404);

      const [accRes, convRes] = await Promise.all([
        getAdmin().from("channel_accounts").select("channel, status").eq("tenant_id", tenant.id),
        getAdmin().from("conversations").select("channel").eq("tenant_id", tenant.id),
      ]);

      const summary: Record<string, { accounts: number; active: number; conversations: number }> = {
        whatsapp: { accounts: 0, active: 0, conversations: 0 },
        instagram: { accounts: 0, active: 0, conversations: 0 },
        facebook: { accounts: 0, active: 0, conversations: 0 },
      };

      for (const a of accRes.data ?? []) {
        const ch = (a as any).channel ?? (a as any).platform;
        const s = summary[ch];
        if (!s) continue;
        s.accounts += 1;
        if ((a as any).status === "active" || (a as any).is_active === true) s.active += 1;
      }
      for (const c of convRes.data ?? []) {
        const ch = (c as any).channel ?? "whatsapp";
        if (summary[ch]) summary[ch].conversations += 1;
      }

      return jsonResponse(summary);
    }

    // ─── PATCH /channels/accounts/:id ───
    if (parts[0] === "accounts" && parts[1] && req.method === "PATCH") {
      const accountId = parts[1];
      const tenant = await ownedTenant(userId, query.get("tenantId"));
      if (!tenant) return jsonResponse({ error: "لا يوجد حساب مرتبط" }, 404);

      const body = await req.json().catch(() => ({}));
      const allowed = [
        "agent_enabled", "auto_reply", "language", "handoff_rules",
        "agent_config", "display_name", "status",
      ];
      const patch: Record<string, unknown> = {};
      for (const k of allowed) {
        if (body?.[k] !== undefined) patch[k] = body[k];
      }
      if (patch.status && !["active", "needs_reauth", "disconnected"].includes(String(patch.status))) {
        return jsonResponse({ error: "حالة غير صالحة" }, 400);
      }
      if (Object.keys(patch).length === 0) {
        return jsonResponse({ error: "لا توجد حقول للتعديل" }, 400);
      }

      patch.updated_at = new Date().toISOString();

      const { data, error } = await getAdmin()
        .from("channel_accounts").update(patch)
        .eq("id", accountId).eq("tenant_id", tenant.id)
        .select("*").maybeSingle();

      if (error) return jsonResponse({ error: error.message }, 500);
      if (!data) return jsonResponse({ error: "الحساب غير موجود" }, 404);
      return jsonResponse(normalizeAccount(data));
    }

    // ─── DELETE /channels/accounts/:id (soft delete) ───
    if (parts[0] === "accounts" && parts[1] && req.method === "DELETE") {
      const accountId = parts[1];
      const tenant = await ownedTenant(userId, query.get("tenantId"));
      if (!tenant) return jsonResponse({ error: "لا يوجد حساب مرتبط" }, 404);

      const { error } = await getAdmin()
        .from("channel_accounts")
        .update({
          status: "disconnected",
          access_token_encrypted: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", accountId).eq("tenant_id", tenant.id);

      if (error) return jsonResponse({ error: error.message }, 500);
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: "Not found", path: parts }, 404);

  } catch (e: any) {
    console.error("[channels] fatal:", e);
    return jsonResponse({ error: e?.message ?? "خطأ داخلي" }, 500);
  }
});