/**
 * مسارات ربط Meta عبر OAuth — Facebook Pages + Instagram Professional
 *
 * التدفق المعتمد (حسب إعداد تطبيق Meta الفعلي — App ID 4221334814824983):
 *   Instagram API with Facebook Login
 * المستخدم يسجّل الدخول عبر facebook.com/dialog/oauth، ثم يجلب الخادم
 * /me/accounts ويستخرج حساب Instagram الاحترافي المرتبط بالصفحة
 * (instagram_business_account) ويحفظه في
 * channel_accounts بقناة "instagram".
 *
 * إصلاح مهم (v3):
 * - عند نجاح OAuth: نكتب في channel_accounts (بيانات الحساب) + في channels
 *   (حالة القناة للواجهة). كان الكود السابق يستخدم update فقط على channels،
 *   فيفشل بصمت إذا لم يكن الصف موجودًا → الواجهة تظل تظهر "غير متصل".
 *   الآن نستخدم check + (update أو insert) — يعمل حتى بدون UNIQUE constraint.
 *
 * تدفق Instagram Login المباشر (v4):
 * - إذا كان INSTAGRAM_APP_ID و INSTAGRAM_APP_SECRET مضبوطين، يبدأ زر
 *   "ربط Instagram" تدفق instagram.com/oauth/authorize مباشرةً بمعاملات:
 *     client_id / redirect_uri=/api/auth/instagram/callback / response_type=code
 *     scope=instagram_business_basic,instagram_business_manage_messages / state
 * - callback مستقل جديد: GET /api/auth/instagram/callback يستدعي
 *   handleInstagramLoginCallback الذي يستخدم buildInstagramCallbackUrl().
 * - التمييز بين نوعي الرموز يتم ببادئة التوكن (IG* مقابل EAA*) في metaSend.ts،
 *   بلا أي تغيير في المخطط (schema).
 * - إن لم يُضبط INSTAGRAM_APP_ID يبقى المسار القديم عبر Facebook Login كما هو.
 */

import express, { Router } from "express";
import crypto from "node:crypto";
import { db, authClient } from "../db.js";
import { config, buildMetaCallbackUrl, buildInstagramCallbackUrl } from "../config.js";
import { encryptField } from "../crypto.js";

export const metaAuthRouter = Router();

const GRAPH_API = "https://graph.facebook.com/v21.0";

const SCOPES: Record<string, string[]> = {
  facebook: [
    "pages_show_list",
    "pages_messaging",
    "pages_manage_metadata",
    "pages_read_engagement",
    "business_management",
  ],
  instagram: [
    "instagram_basic",
    "instagram_manage_messages",
    "pages_read_engagement",
    "pages_show_list",
    "business_management",
    "pages_manage_metadata",
    "pages_messaging",
  ],
};

/* ═══════════ Instagram Login المباشر (بدون Facebook) ═══════════
 * يُفعَّل تلقائياً عند ضبط INSTAGRAM_APP_ID و INSTAGRAM_APP_SECRET في Railway
 * (من Meta: Instagram API setup with Instagram login). وإن لم يُضبطا يبقى
 * المسار القديم عبر Facebook Login كما هو. */
const IG_AUTHORIZE = "https://www.instagram.com/oauth/authorize";
const IG_TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const IG_GRAPH_HOST = "https://graph.instagram.com";
const IG_GRAPH_V = `${IG_GRAPH_HOST}/v21.0`;
const IG_LOGIN_SCOPES = ["instagram_business_basic", "instagram_business_manage_messages"];

function instagramLoginConfigured(): boolean {
  return Boolean(process.env.INSTAGRAM_APP_ID && process.env.INSTAGRAM_APP_SECRET);
}

async function markChannelConnected(
  tenantId: string,
  platform: string,
  accountName: string,
  accountId: string
) {
  const { data: existing } = await db
    .from("channels")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("platform", platform)
    .maybeSingle();
  const row = {
    is_connected: true,
    connected_at: new Date().toISOString(),
    account_name: accountName || null,
    platform_account_id: accountId || null,
  };
  const { error } = existing?.id
    ? await db.from("channels").update(row).eq("id", existing.id)
    : await db.from("channels").insert({ tenant_id: tenantId, platform, ...row });
  if (error) console.warn("[Meta Auth] channels write failed:", error.message);
}

async function handleInstagramLoginCallback(a: {
  res: any;
  code: string;
  tenantId: string;
  frontBase: string;
  fail: (c: string) => any;
}) {
  const { res, tenantId, frontBase, fail } = a;
  const code = a.code.replace(/#_$/, "");
  const igAppId = process.env.INSTAGRAM_APP_ID!;
  const igSecret = process.env.INSTAGRAM_APP_SECRET!;

  let redirectUri: string;
  try {
    // Instagram Login المباشر يستخدم المسار المستقل /api/auth/instagram/callback
    // وليس redirect_uri الخاص بـ Facebook (buildMetaCallbackUrl).
    redirectUri = buildInstagramCallbackUrl();
  } catch (e: any) {
    console.error("[Meta Auth] instagram redirect_uri build failed:", e?.message);
    return fail("config_redirect_uri");
  }
  console.log("[Meta Auth] Instagram Login callback → redirect_uri:", redirectUri);

  try {
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
      console.error(
        "[Meta Auth] IG token exchange failed:",
        tJson?.error_message ?? tJson?.error?.message ?? "unknown"
      );
      return fail("oauth_token_exchange");
    }
    console.log("[Meta Auth] IG token exchange OK");

    // 2) short-lived → long-lived (60 يوماً)
    let token = shortToken;
    let expiresIn = 3600;
    const lRes = await fetch(
      `${IG_GRAPH_HOST}/access_token?grant_type=ig_exchange_token` +
        `&client_secret=${encodeURIComponent(igSecret)}&access_token=${encodeURIComponent(shortToken)}`
    );
    const lJson: any = await lRes.json().catch(() => ({}));
    if (lJson?.access_token) {
      token = lJson.access_token;
      expiresIn = Number(lJson.expires_in ?? 5184000);
    } else {
      console.warn("[Meta Auth] IG long-lived exchange failed:", lJson?.error?.message ?? "unknown");
    }

    // 3) بيانات الحساب
    const pRes = await fetch(
      `${IG_GRAPH_V}/me?fields=user_id,username,name,profile_picture_url,account_type` +
        `&access_token=${encodeURIComponent(token)}`
    );
    const prof: any = await pRes.json().catch(() => ({}));
    const igId = String(prof?.user_id ?? prof?.id ?? first?.user_id ?? "");
    if (!igId) {
      console.error("[Meta Auth] IG /me failed:", prof?.error?.message ?? "no id");
      return fail("no_eligible_instagram");
    }
    console.log(
      `[Meta Auth] IG profile: ${prof?.username ?? igId} type=${prof?.account_type ?? "?"}`
    );
    if (prof?.account_type && !["BUSINESS", "MEDIA_CREATOR"].includes(prof.account_type)) {
      return fail("no_eligible_instagram — الحساب يجب أن يكون Business أو Creator");
    }

    const { data: taken } = await db
      .from("channel_accounts")
      .select("tenant_id")
      .eq("channel", "instagram")
      .eq("external_id", igId)
      .neq("tenant_id", tenantId)
      .eq("status", "active")
      .maybeSingle();
    if (taken) {
      console.warn(`[Meta Auth] IG account ${igId} already owned by another tenant`);
      return fail("account_already_linked");
    }

    // 4) الحفظ
    const username = prof?.username ? `@${prof.username}` : prof?.name ?? null;
    const { error: upErr } = await db.from("channel_accounts").upsert(
      {
        tenant_id: tenantId,
        channel: "instagram",
        external_id: igId,
        display_name: username,
      typescript
avatar_url:
  typeof prof?.profile_picture_url === "string" &&
  prof.profile_picture_url.length > 0
    ? prof.profile_picture_url
    : null,
        status: "active",
        access_token_encrypted: encryptField(token),
        token_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id,channel,external_id" }
    );
    if (upErr) {
      console.error("[Meta Auth] channel_accounts upsert FAILED:", upErr.message);
      return fail("db_save_failed");
    }

    // 5) اشتراك الحساب في webhooks (كان يدوياً سابقاً)
    try {
      const sRes = await fetch(
        `${IG_GRAPH_V}/me/subscribed_apps?subscribed_fields=messages,messaging_postbacks,messaging_seen` +
          `&access_token=${encodeURIComponent(token)}`,
        { method: "POST" }
      );
      const sJson: any = await sRes.json().catch(() => ({}));
      if (sJson?.success) console.log("[Meta Auth] IG webhooks subscribed ✓");
      else console.error("[Meta Auth] IG subscribed_apps FAILED:", sJson?.error?.message ?? JSON.stringify(sJson));
    } catch (e: any) {
      console.error("[Meta Auth] IG subscribed_apps error:", e?.message);
    }

    await markChannelConnected(tenantId, "instagram", username ?? "", igId);
    console.log("[Meta Auth] Instagram Login done — account:", igId);
    return res.redirect(
      `${frontBase}?channel_connected=instagram&accounts=1&name=${encodeURIComponent(username ?? "")}`
    );
  } catch (e: any) {
    console.error("[Meta Auth] Instagram Login callback error:", e);
    return fail(e?.message ? String(e.message).slice(0, 120) : "unknown");
  }
}

/* عنوان الواجهة بعد اكتمال OAuth — GitHub Pages مع Hash Routing ومسار المشروع */
function frontendDashboardUrl(): string {
  const origin = (process.env.FRONTEND_ORIGIN || config.frontendOrigin || "")
    .trim()
    .replace(/\/+$/, "");
  return `${origin}/milanochat/#/dashboard`;
}

/* التحقق من ملكية tenant للمستخدم (Multi-Tenant isolation) */
async function ownedTenant(userId: string, tenantId?: string) {
  if (!tenantId) return null;
  const { data } = await db
    .from("tenants")
    .select("id")
    .eq("id", tenantId)
    .eq("user_id", userId)
    .maybeSingle();
  return data;
}

/* ═══════════ state: توقيع HMAC ثابت-المصدر + سجل استهلاك واحد ═══════════ */

type OAuthStatePayload = {
  u: string;
  t: string;
  p: string;
  i: string;
  exp: number;
};

const STATE_TTL_SEC = 15 * 60;

function stateSecret(): string {
  const secret = process.env.META_APP_SECRET || "";
  if (!secret) throw new Error("META_APP_SECRET مفقود — لا يمكن توقيع/التحقق من OAuth state");
  return secret;
}

function hmacSign(body: string): string {
  return crypto.createHmac("sha256", stateSecret()).update(body).digest("base64url");
}

async function createOAuthState(rec: {
  platform: string;
  tenantId: string;
  userId: string;
}): Promise<{ state: string; nonce: string } | null> {
  const nonce = crypto.randomBytes(12).toString("hex");
  const payload: OAuthStatePayload = {
    u: rec.userId,
    t: rec.tenantId,
    p: rec.platform,
    i: nonce,
    exp: Math.floor(Date.now() / 1000) + STATE_TTL_SEC,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const state = `${body}.${hmacSign(body)}`;

  const expiresAt = new Date(payload.exp * 1000).toISOString();
  const { error } = await db.from("meta_oauth_states").insert({
    id: nonce,
    user_id: rec.userId,
    tenant_id: rec.tenantId,
    platform: rec.platform,
    expires_at: expiresAt,
    consumed: false,
  });
  if (error) {
    console.warn("[Meta Auth] meta_oauth_states insert failed:", error.message);
  }
  return { state, nonce };
}

async function consumeOAuthState(
  state: string
): Promise<
  | { ok: true; session: { platform: string; tenantId: string; userId: string } }
  | { ok: false; reason: string }
> {
  let decoded: Partial<OAuthStatePayload> | null = null;
  try {
    const dot = state.lastIndexOf(".");
    if (dot <= 0) return { ok: false, reason: "state_format" };
    const body = state.slice(0, dot);
    const sig = state.slice(dot + 1);
    const expected = hmacSign(body);
    if (
      sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    )
      return { ok: false, reason: "state_signature" };
    decoded = JSON.parse(Buffer.from(body, "base64url").toString()) as Partial<OAuthStatePayload>;
    if (!decoded?.u || !decoded?.t || !decoded?.p || !decoded?.exp)
      return { ok: false, reason: "state_payload" };
    if (decoded.p !== "facebook" && decoded.p !== "instagram")
      return { ok: false, reason: "state_platform" };
  } catch {
    return { ok: false, reason: "state_parse" };
  }

  if (Math.floor(Date.now() / 1000) > decoded!.exp!) return { ok: false, reason: "state_expired" };

  const { data: row, error: selErr } = await db
    .from("meta_oauth_states")
    .select("id, consumed")
    .eq("id", decoded!.i!)
    .maybeSingle();
  if (selErr) {
    console.warn("[Meta Auth] meta_oauth_states select failed:", selErr.message);
  } else if (!row) {
    console.warn("[Meta Auth] meta_oauth_states: no record for nonce");
  } else if (row.consumed) {
    return { ok: false, reason: "state_reused" };
  } else {
    const { error: updErr } = await db
      .from("meta_oauth_states")
      .update({ consumed: true })
      .eq("id", decoded!.i!)
      .eq("consumed", false);
    if (updErr) console.warn("[Meta Auth] mark consumed failed:", updErr.message);
  }

  return {
    ok: true,
    session: { userId: decoded!.u!, tenantId: decoded!.t!, platform: decoded!.p! },
  };
}

/* تحقق الملكية عبر bearer token */
async function requireUser(req: any, res: any, next: any) {
  const header = String(req.headers.authorization ?? "");
  const token = header.startsWith("Bearer ")
    ? header.slice(7)
    : req.method === "GET"
      ? String(req.query?.t ?? "") || null
      : null;
  if (!token) return res.status(401).json({ error: "غير مصرح" });
  try {
    const { data, error } = await authClient.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: "جلسة غير صالحة" });
    req.userId = data.user.id;
    next();
  } catch {
    return res.status(401).json({ error: "تحقق فشل" });
  }
}

const protectedRoutes = express.Router();
protectedRoutes.use(requireUser);

/* ═══════════ مسار عام — Instagram Login يعود إليه مباشرة (مستقل عن Facebook) ═══════════ */
metaAuthRouter.get("/instagram/callback", async (req: any, res) => {
  const frontBase = frontendDashboardUrl();
  const fail = (code: string) => {
    console.warn("[Meta Auth] IG callback FAILED →", code);
    return res.redirect(`${frontBase}?channel_error=${encodeURIComponent(code)}`);
  };

  console.log("[Meta Auth] IG callback ENTERED — params:", Object.keys(req.query ?? {}));

  const { code, state, error: metaError } = req.query as Record<string, string>;
  if (metaError) return fail(metaError === "access_denied" ? "user_cancelled" : metaError);
  if (!code || !state) return fail("missing_params");

  const stateResult = await consumeOAuthState(String(state));
  if (!stateResult.ok) return fail(`oauth_state:${stateResult.reason}`);

  const { platform, tenantId, userId } = stateResult.session;
  console.log("[Meta Auth] IG callback state OK — platform:", platform, "nonce verified");

  if (platform !== "instagram") {
    // state خاص بتدفق آخر (facebook) — لا يُقبل على هذا المسار
    return fail("oauth_state_platform_mismatch");
  }

  return handleInstagramLoginCallback({
    res,
    code: String(code),
    tenantId,
    frontBase,
    fail,
  });
});

/* ═══════════ مسار عام — Meta تعود إليه مباشرة ═══════════ */
metaAuthRouter.get("/facebook/callback", async (req: any, res) => {
  const frontBase = frontendDashboardUrl();
  const fail = (code: string) => {
    console.warn("[Meta Auth] callback FAILED →", code);
    return res.redirect(`${frontBase}?channel_error=${encodeURIComponent(code)}`);
  };

  console.log("[Meta Auth] callback ENTERED — params:", Object.keys(req.query ?? {}));

  const { code, state, error: metaError } = req.query as Record<string, string>;
  if (metaError) return fail(metaError === "access_denied" ? "user_cancelled" : metaError);
  if (!code || !state) return fail("missing_params");

  const stateResult = await consumeOAuthState(String(state));
  if (!stateResult.ok) return fail(`oauth_state:${stateResult.reason}`);

  const { platform, tenantId, userId } = stateResult.session;
  console.log("[Meta Auth] callback state OK — platform:", platform, "nonce verified");

  /* جسر احتياطي (غير مستخدم حاليًا): لا يُكمل Instagram Login المباشر إلا إذا
     فُعِّل صراحةً بالعلم USE_INSTAGRAM_DIRECT_LOGIN=true بعد تسجيل redirect URI
     الخاص به في لوحة Meta. خلاف ذلك يستمر المسار أدناه بتدفق Facebook Login. */
  if (platform === "instagram" && process.env.USE_INSTAGRAM_DIRECT_LOGIN === "true" && instagramLoginConfigured()) {
    // وصل code صادر عن تدفق Instagram Login المباشر المحفوظ في state سابق —
    // نكمله عبر handleInstagramLoginCallback مع redirect_uri الصحيح.
    return handleInstagramLoginCallback({ res, code: String(code), tenantId, frontBase, fail });
  }

  const appId = process.env.META_APP_ID!;
  const appSecret = process.env.META_APP_SECRET!;
  let redirectUri: string;
  try {
    redirectUri = buildMetaCallbackUrl();
  } catch (e: any) {
    console.error("[Meta Auth] redirect_uri build failed:", e?.message);
    return fail("config_redirect_uri");
  }

  console.log("[Meta Auth] OAuth callback → redirect_uri:", redirectUri, "platform:", platform);

  try {
    const tokenRes = await fetch(
      `${GRAPH_API}/oauth/access_token?client_id=${encodeURIComponent(appId)}&client_secret=${encodeURIComponent(appSecret)}&redirect_uri=${encodeURIComponent(redirectUri)}&code=${encodeURIComponent(code)}`
    );
    const tokenData: any = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error("[Meta Auth] token exchange failed:", tokenData?.error?.message ?? "unknown");
      return fail("oauth_token_exchange");
    }
    console.log("[Meta Auth] token exchange OK");

    let accessToken = tokenData.access_token;
    try {
      const longRes = await fetch(
        `${GRAPH_API}/oauth/access_token?grant_type=fb_exchange_token&client_id=${encodeURIComponent(appId)}&client_secret=${encodeURIComponent(appSecret)}&fb_exchange_token=${accessToken}`
      );
      const longData: any = await longRes.json();
      if (longData.access_token) accessToken = longData.access_token;
    } catch {
      /* بقي الرمز قصير الأمد */
    }

    const expiresAt =
      Number(tokenData.expires_in ?? 0) > 0
        ? new Date(Date.now() + Number(tokenData.expires_in) * 1000).toISOString()
        : null;

    const pagesRes = await fetch(
      `${GRAPH_API}/me/accounts?fields=id,name,picture&access_token=${accessToken}`
    );
    const pagesData: any = await pagesRes.json();
    const pages: any[] = pagesData.data ?? [];
    console.log("[Meta Auth] /me/accounts → pages:", pages.length, pages.map((p) => p?.id).join(","));
    if (pagesData.error) console.error("[Meta Auth] /me/accounts error:", pagesData.error?.message ?? "unknown");

    let saved = 0;
    let lastAccountName = "";
    let lastAccountId = "";

    for (const p of pages) {
      if (!p?.id) continue;
      const picture = typeof p.picture?.data?.url === "string" ? p.picture.data.url : null;
      const pageToken: string = p.access_token ?? accessToken;

      if (platform === "facebook") {
        const { error } = await db.from("channel_accounts").upsert(
          {
            tenant_id: tenantId,
            channel: "facebook",
            external_id: String(p.id),
            display_name: p.name ?? null,
            avatar_url: picture,
            status: "active",
            access_token_encrypted: encryptField(pageToken),
            token_expires_at: expiresAt,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "tenant_id,channel,external_id" }
        );
        if (!error) {
          saved += 1;
          lastAccountName = p.name ?? lastAccountName;
          lastAccountId = String(p.id);
        }
      } else if (platform === "instagram") {
      typescript
const igRes = await fetch(
  `${GRAPH_API}/${p.id}?fields=name,instagram_business_account{id,username,profile_picture_url}&access_token=${encodeURIComponent(pageToken)}`
);
        );
        const ig: any = await igRes.json();
        const igAcc = ig?.instagram_business_account;
        console.log(
          `[Meta Auth] page ${p.id} IG discovery:`,
          igAcc?.id ? `found ${igAcc.username ?? igAcc.id}` : `not found (${ig?.error?.message ?? "no linked account"})`
        );
        if (!igAcc?.id) continue;

        const username = igAcc.username ? `@${igAcc.username}` : ig?.name ?? null;
        typescript
const igPicture =
  typeof igAcc?.profile_picture_url === "string" &&
  igAcc.profile_picture_url.length > 0
    ? igAcc.profile_picture_url
    : typeof igAcc?.picture?.data?.url === "string"
      ? igAcc.picture.data.url
      : typeof igAcc?.picture_url === "string"
        ? igAcc.picture_url
        : null;

        const { data: taken } = await db
          .from("channel_accounts")
          .select("tenant_id, status")
          .eq("channel", "instagram")
          .eq("external_id", String(igAcc.id))
          .neq("tenant_id", tenantId)
          .eq("status", "active")
          .maybeSingle();
        if (taken) {
          console.warn(`[Meta Auth] IG account ${igAcc.id} already owned by another tenant — skipped`);
          continue;
        }

        const { error } = await db.from("channel_accounts").upsert(
          {
            tenant_id: tenantId,
            channel: "instagram",
            external_id: String(igAcc.id),
            display_name: username,
            avatar_url: igPicture,
            status: "active",
            access_token_encrypted: encryptField(pageToken),
            token_expires_at: expiresAt,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "tenant_id,channel,external_id" }
        );
        if (!error) {
          saved += 1;
          lastAccountName = username ?? lastAccountName;
          lastAccountId = String(igAcc.id);

          /* ═══════════════════════════════════════════════════════
             اشتراك Page Webhooks — مطلوب لوصول أحداث Instagram DMs
             عبر Facebook Login → Instagram API.
             POST /{pageId}/subscribed_apps (graph.facebook.com)
             فشل الاشتراك لا يمنع حفظ الحساب، لكنه يُسجَّل بوضوح.
             ═══════════════════════════════════════════════════════ */
          console.log(`[Meta Auth] Subscribing Page webhooks → page: ${p.id}`);
          try {
            const subRes = await fetch(
              `${GRAPH_API}/${p.id}/subscribed_apps`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  access_token: pageToken,
                  subscribed_fields: ["messages", "messaging_postbacks", "messaging_seen"],
                }),
              }
            );
            let subJson: any = null;
            try {
              subJson = await subRes.json();
            } catch {
              subJson = null;
            }
            // HTTP 200 وحده لا يكفي — نفحص response body
            if (subRes.ok && subJson && (subJson.success === true || subJson.result === true)) {
              console.log("[Meta Auth] Page webhooks subscribed ✓");
            } else {
              console.error(
                "[Meta Auth] Page webhooks subscribe failed:",
                `status=${subRes.status}`,
                `body=${JSON.stringify(subJson ?? "(unparseable)")}`.slice(0, 400)
              );
            }
          } catch (e: any) {
            console.error(
              "[Meta Auth] Page webhooks subscribe failed:",
              e?.message ?? String(e)
            );
          }
        } else {
          console.error("[Meta Auth] channel_accounts upsert FAILED:", error.message);
        }
      }
    }

    console.log("[Meta Auth] callback done — accounts saved:", saved, "platform:", platform);

    if (saved === 0) {
      return fail(
        platform === "instagram"
          ? "no_eligible_instagram — لم يُعثر على حساب Instagram احترافي مرتبط بصفحاتك"
          : "no_pages — لم تمنح صلاحيات لأي صفحة Facebook"
      );
    }

    /* ═══════════════════════════════════════════════════════════
       إصلاح v3: كتابة حالة القناة في جدول channels بطريقة آمنة.
       - update فقط كان يفشل بصمت إذا لم يكن الصف موجودًا.
       - الآن: نبحث عن الصف أولًا، ثم نعمل update أو insert.
       ═══════════════════════════════════════════════════════════ */
    const { data: existingChannel } = await db
      .from("channels")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("platform", platform)
      .maybeSingle();

    if (existingChannel?.id) {
      const { error: chUpdErr } = await db
        .from("channels")
        .update({
          is_connected: true,
          connected_at: new Date().toISOString(),
          account_name: lastAccountName || null,
          platform_account_id: lastAccountId || null,
        })
        .eq("id", existingChannel.id);
      if (chUpdErr) console.warn("[Meta Auth] channels update failed:", chUpdErr.message);
      else console.log("[Meta Auth] channels row UPDATED for", platform);
    } else {
      const { error: chInsErr } = await db.from("channels").insert({
        tenant_id: tenantId,
        platform,
        is_connected: true,
        connected_at: new Date().toISOString(),
        account_name: lastAccountName || null,
        platform_account_id: lastAccountId || null,
      });
      if (chInsErr) console.warn("[Meta Auth] channels insert failed:", chInsErr.message);
      else console.log("[Meta Auth] channels row INSERTED for", platform);
    }

    res.redirect(
      `${frontBase}?channel_connected=${platform}&accounts=${saved}&name=${encodeURIComponent(lastAccountName)}`
    );
  } catch (e: any) {
    console.error("[Meta Auth] callback error:", e);
    fail(e?.message ? String(e.message).slice(0, 120) : "unknown");
  }
});

/* ═══════════ مسارات محمية بجلسة المستخدم ═══════════ */
metaAuthRouter.use(protectedRoutes);

// 1) بدء OAuth
metaAuthRouter.post("/facebook/start", async (req: any, res) => {
  const { platform } = req.body ?? {};
  if (platform !== "facebook" && platform !== "instagram") {
    return res.status(400).json({ error: "قناة غير مدعومة" });
  }

  const tenant = await ownedTenant(req.userId, req.body?.tenantId);
  if (!tenant) return res.status(403).json({ error: "تعذر التحقق من ملكية النشاط التجاري" });

  /* التوجيه الحالي: زر Instagram يستخدم "Instagram API with Facebook Login"
     (المسار القديم أدناه عبر facebook.com/v21.0/dialog/oauth مع META_APP_ID
     و SCOPES.instagram) — لأن إعداد Meta في الحساب الحالي يسجّل Redirect URIs
     فقط ضمن Facebook Business Login، ولا يتوفر حقل OAuth redirect URIs لمنتج
     Instagram Login. كود Instagram Login المباشر (instagram.com/oauth/authorize)
     يبقى موجودًا وغير محذوف خلف العلم التجريبي USE_INSTAGRAM_DIRECT_LOGIN=true
     (يُفعَّل فقط بعد تسجيل redirect URI الخاص به في لوحة Meta). */

  if (platform === "instagram" && process.env.USE_INSTAGRAM_DIRECT_LOGIN === "true" && instagramLoginConfigured()) {
    let igRedirectUri: string;
    let igState: string;
    try {
      igRedirectUri = buildInstagramCallbackUrl();
      const st = await createOAuthState({ platform, tenantId: tenant.id, userId: req.userId });
      if (!st) throw new Error("تعذر إنشاء جلسة OAuth");
      igState = st.state;
    } catch (e: any) {
      console.error("[Meta Auth] إعداد Instagram OAuth غير صالح:", e?.message);
      return res.status(500).json({
        error: "oauth_misconfigured",
        message: "إعداد PUBLIC_URL/INSTAGRAM_REDIRECT_URI/الأسرار غير صحيحة على الخادم.",
      });
    }

    const igUrl =
      `${IG_AUTHORIZE}?force_reauth=true&client_id=${encodeURIComponent(process.env.INSTAGRAM_APP_ID!)}` +
      `&redirect_uri=${encodeURIComponent(igRedirectUri)}&response_type=code` +
      `&scope=${encodeURIComponent(IG_LOGIN_SCOPES.join(","))}&state=${encodeURIComponent(igState)}`;
    console.log("[Meta Auth] using Instagram Login (direct) for platform: instagram →", igRedirectUri);
    return res.json({ url: igUrl });
  }

  /* فرع Facebook Login (المسار القديم) — لا يتغير */
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) {
    return res.status(400).json({
      error: "oauth_not_configured",
      message: "تطبيق Meta غير مُهيّأ على الخادم بعد.",
    });
  }

  let redirectUri: string;
  let state: string;
  try {
    redirectUri = buildMetaCallbackUrl();
    const st = await createOAuthState({ platform, tenantId: tenant.id, userId: req.userId });
    if (!st) throw new Error("تعذر إنشاء جلسة OAuth");
    state = st.state;
  } catch (e: any) {
    console.error("[Meta Auth] إعداد OAuth غير صالح:", e?.message);
    return res.status(500).json({
      error: "oauth_misconfigured",
      message: "إعداد PUBLIC_URL/الأسرار غير صحيحة على الخادم.",
    });
  }

  console.log("[Meta Auth] OAuth start → redirect_uri:", redirectUri, "platform:", platform);

  const scopes = SCOPES[platform];
  const url =
    `https://www.facebook.com/v21.0/dialog/oauth?client_id=${encodeURIComponent(appId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(state)}&scope=${encodeURIComponent(scopes.join(","))}&response_type=code`;

  res.json({ url });
});

// 2) فصل قناة
metaAuthRouter.post("/disconnect", async (req: any, res) => {
  const { platform } = req.body ?? {};
  if (platform !== "facebook" && platform !== "instagram") {
    return res.status(400).json({ error: "قناة غير مدعومة" });
  }
  const tenant = await ownedTenant(req.userId, req.body?.tenantId);
  if (!tenant) return res.status(403).json({ error: "تعذر التحقق من ملكية النشاط" });

  await db
    .from("channel_accounts")
    .update({
      status: "disconnected",
      access_token_encrypted: null,
      updated_at: new Date().toISOString(),
    })
    .eq("tenant_id", tenant.id)
    .eq("channel", platform);

  await db
    .from("channels")
    .update({
      is_connected: false,
      account_name: null,
      account_avatar: null,
      platform_account_id: null,
    })
    .eq("tenant_id", tenant.id)
    .eq("platform", platform);

  res.json({ ok: true });
});
