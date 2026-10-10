// ═══════════════════════════════════════════════════════════════════
// Edge Function: channels (standalone)
// Endpoints: /channels/accounts, /channels/summary, /channels/meta/status
// ═══════════════════════════════════════════════════════════════════

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── CORS ───
const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-hub-signature-256",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};

// ─── Supabase Admin Client ───
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

// ─── Types ───
type ChannelId = "whatsapp" | "instagram" | "facebook";
const VALID_CHANNELS: ChannelId[] = ["whatsapp", "instagram", "facebook"];

// ─── OAuth state (توقيع HMAC متوافق مع دالة meta-auth: base64url(body).base64url(sig)) ───
const enc = new TextEncoder();

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacSign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return b64url(String.fromCharCode(...new Uint8Array(sig)));
}

/** يبني state موقّعًا ويسجّله في meta_oauth_states (أفضل جهد — مثل خادم Node السابق) */
async function createSignedState(opts: {
  platform: "instagram" | "facebook";
  userId: string;
  tenantId?: string | null;
}): Promise<string> {
  const secret =
    Deno.env.get("INSTAGRAM_APP_SECRET") ?? Deno.env.get("META_APP_SECRET") ?? "";
  if (!secret) throw new Error("INSTAGRAM_APP_SECRET/META_APP_SECRET مفقود — لا يمكن توقيع OAuth state");

  const nonce = crypto.randomUUID();
  const bodyB64 = b64url(JSON.stringify({ i: nonce, p: opts.platform, exp: Math.floor(Date.now() / 1000) + 600 }));
  const state = `${bodyB64}.${await hmacSign(secret, bodyB64)}`;

  try {
    const { error } = await getAdmin().from("meta_oauth_states").insert({
      id: nonce,
      user_id: opts.userId,
      tenant_id: opts.tenantId ?? null,
      platform: opts.platform,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
    if (error) console.warn("[channels] meta_oauth_states insert failed:", error.message);
  } catch (e: any) {
    console.warn("[channels] meta_oauth_states insert error:", e?.message ?? e);
  }
  return state;
}

// ─── Helpers ───
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
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
      .from("tenants")
      .select("*")
      .eq("id", tenantId)
      .eq("user_id", userId)
      .maybeSingle();
    return data;
  }
  const { data } = await supabase
    .from("tenants")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  return data;
}

function normalizeAccount(row: any) {
  const channel = row.channel || row.platform || "whatsapp";
  return {
    id: row.id,
    tenantId: row.tenant_id ?? null,
    channel,
    platform: channel,
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

// ─── Main Handler ───
Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/channels\/?/, ""); // كل ما بعد /channels/
  const parts = path.split("/").filter(Boolean);
  const query = url.searchParams;

  try {
    // ─── GET /channels/meta/status (public) ───
    if (parts[0] === "meta" && parts[1] === "status" && req.method === "GET") {
      const configured = Boolean(
        Deno.env.get("META_APP_ID") && Deno.env.get("META_APP_SECRET"),
      );

      let perChannel: { whatsapp: boolean; instagram: boolean; facebook: boolean } | null = null;

      const authHeader = req.headers.get("authorization") ?? "";
      const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

      if (bearer) {
        try {
          const { data: userData } = await getAdmin().auth.getUser(bearer);
          const userId = userData?.user?.id;
          if (userId) {
            const tenant = await ownedTenant(userId, query.get("tenantId"));
            if (tenant) {
              const { data } = await getAdmin()
                .from("channels")
                .select("*")
                .eq("tenant_id", tenant.id);
              const find = (p: string) =>
                (data ?? []).find((c: any) => c.platform === p)?.is_connected === true;
              perChannel = {
                whatsapp: find("whatsapp"),
                instagram: find("instagram"),
                facebook: find("facebook"),
              };
            }
          }
        } catch {
          /* تجاهل */
        }
      }

      return jsonResponse({
        configured,
        channels: perChannel,
        appReviewNote: "حالة مراجعة صلاحيات Meta تُتابَع يدويًا من لوحة Meta Developers.",
        developersUrl: "https://developers.facebook.com/apps",
      });
    }

    // ─── باقي الـ endpoints تحتاج auth ───
    const auth = await requireAuth(req);
    if (auth instanceof Response) return auth;
    const { userId } = auth;

    // ─── GET /channels/meta/oauth-url?channel=instagram[&debug=1] ───
    // يبني رابط تفويض Instagram Login (أو Facebook OAuth) من الأسرار المنشورة.
    if (parts[0] === "meta" && parts[1] === "oauth-url" && req.method === "GET") {
      const channel = query.get("channel") ?? "instagram";
      const debug = query.get("debug") === "1";

      if (channel === "instagram") {
        const appId = Deno.env.get("INSTAGRAM_APP_ID") ?? "";
        const redirectUri = (Deno.env.get("INSTAGRAM_REDIRECT_URI") ?? "").replace(/\/+$/, "");
        if (!appId || !redirectUri) {
          return jsonResponse(
            { error: "إعدادات Instagram OAuth غير مكتملة — تحقق من الأسرار INSTAGRAM_APP_ID و INSTAGRAM_REDIRECT_URI" },
            500,
          );
        }
        let state: string;
        try {
          state = await createSignedState({
            platform: "instagram",
            userId,
            tenantId: query.get("tenantId"),
          });
        } catch (e: any) {
          return jsonResponse({ error: e?.message ?? "تعذر تجهيز جلسة OAuth" }, 500);
        }
        const oauthUrl =
          "https://www.instagram.com/oauth/authorize" +
          "?force_reauth=true" +
          `&client_id=${encodeURIComponent(appId)}` +
          `&redirect_uri=${encodeURIComponent(redirectUri)}` +
          "&response_type=code" +
          "&scope=" +
          encodeURIComponent("instagram_business_basic,instagram_business_manage_messages") +
          `&state=${encodeURIComponent(state)}`;

        if (debug) {
          return jsonResponse({
            clientId: appId,
            redirectUri,
            provider: "instagram",
            url: oauthUrl,
          });
        }
        return jsonResponse({ url: oauthUrl, state });
      }

      if (channel === "facebook") {
        const appId = Deno.env.get("META_APP_ID") ?? "";
        const redirectUri = (Deno.env.get("META_REDIRECT_URI") ?? "").replace(/\/+$/, "");
        if (!appId || !redirectUri) {
          return jsonResponse({ error: "إعدادات Facebook OAuth غير مكتملة" }, 500);
        }
        let state: string;
        try {
          state = await createSignedState({
            platform: "facebook",
            userId,
            tenantId: query.get("tenantId"),
          });
        } catch (e: any) {
          return jsonResponse({ error: e?.message ?? "تعذر تجهيز جلسة OAuth" }, 500);
        }
        const oauthUrl =
          "https://www.facebook.com/v21.0/dialog/oauth" +
          `?client_id=${encodeURIComponent(appId)}` +
          `&redirect_uri=${encodeURIComponent(redirectUri)}` +
          "&state=" + encodeURIComponent(state);
        if (debug) {
          return jsonResponse({ clientId: appId, redirectUri, provider: "facebook", url: oauthUrl });
        }
        return jsonResponse({ url: oauthUrl, state });
      }

      return jsonResponse({ error: `قناة غير مدعومة في OAuth: ${channel}` }, 400);
    }

    // ─── GET /channels/accounts ───
    if (parts[0] === "accounts" && parts.length === 1 && req.method === "GET") {
      const tenant = await ownedTenant(userId, query.get("tenantId"));
      if (!tenant) return jsonResponse({ error: "لا يوجد حساب مرتبط" }, 404);

      const { data, error } = await getAdmin()
        .from("channel_accounts")
        .select("*")
        .eq("tenant_id", tenant.id)
        .order("created_at", { ascending: false });

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
        .from("channel_accounts")
        .update(patch)
        .eq("id", accountId)
        .eq("tenant_id", tenant.id)
        .select("*")
        .maybeSingle();

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
        .eq("id", accountId)
        .eq("tenant_id", tenant.id);

      if (error) return jsonResponse({ error: error.message }, 500);
      return jsonResponse({ ok: true });
    }

    // ─── 404 ───
    return jsonResponse({ error: "Not found", path: parts }, 404);

  } catch (e: any) {
    console.error("[channels] fatal:", e);
    return jsonResponse({ error: e?.message ?? "خطأ داخلي" }, 500);
  }
});
