/**
 * مسارات ربط Meta عبر OAuth — Facebook Pages + Instagram Professional
 *
 * التدفق المعتمد: Facebook Login → اكتشاف الصفحة الوسيطة → Instagram Messaging API
 * المستخدم يسجّل الدخول عبر facebook.com/dialog/oauth بصلاحيات pages_* فقط،
 * ثم يجلب الخادم /me/accounts ويستخرج حساب Instagram الاحترافي المرتبط
 * بالصفحة (instagram_user_account / instagram_business_account).
 * لا تُطلب أي صلاحية instagram_* في هذا التدفق:
 *   - instagram_basic / instagram_manage_messages → مُلغاة من Facebook Login.
 *   - instagram_business_basic / instagram_business_manage_messages → خاصة
 *     بـ Instagram Login وترفضها شاشة Facebook (Invalid Scopes).
 * إدارة الرسائل تتم عبر اشتراك Webhook لأحداث messages + منتج Instagram
 * المفعّل في App Dashboard (إعدادات لوحة تحكم، ليست scopes).
 *
 * المسارات:
 *   Dashboard → POST /api/auth/facebook/start (platform, tenantId)
 *   ← { url } رابط Meta OAuth الرسمي بـ state عشوائي موقّع ومخزن لمرة واحدة
 *   المستخدم يفوّض في Meta → GET /api/auth/facebook/callback
 *   ← تبادل الرمز برمز طويل الأمد من الخادم فقط، جلب الصفحات/حسابات IG
 *     المؤهلة، الحفظ في channel_accounts (تشفير على الخادم فقط)،
 *     ثم redirect إلى GitHub Pages مع باراميترات نجاح/فشل.
 */
import { Router } from "express";
import crypto from "node:crypto";
import { db, authClient } from "../db.js";
import { config, buildMetaCallbackUrl, buildInstagramCallbackUrl } from "../config.js";
import { encryptField } from "../crypto.js";

export const metaAuthRouter = Router();

const GRAPH_API = "https://graph.facebook.com/v21.0";

/* ─── Instagram Login (تدفق مستقل تمامًا عن Facebook Login) ───
 * نقطة التفويض الرسمية: https://www.instagram.com/oauth/authorize
 * نقطة الرموز:          https://graph.instagram.com/access_token  (قصير)
 *                       https://graph.instagram.com/refresh_token (تجديد)
 *                       https://graph.instagram.com/upgradetoken  (60 يومًا من short-lived)
 * نقطة بيانات الحساب:   https://graph.instagram.com/me?fields=user_id,username,account_type
 * نقطة إرسال الرسائل:   POST https://graph.facebook.com/v21.0/<ig_user_id>/messages
 *   (نفس endpoint الخاص بـ Messenger Platform — يتطلب منتج Instagram Messaging +
 *    صلاحية instagram_business_manage_messages الممنوحة فعلياً في شاشة تفويض Instagram)
 */
const IG_AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize";
const IG_GRAPH_API = "https://graph.instagram.com";
/* الصلاحيات الصحيحة لـ Instagram Login وفق وثائق Meta الحالية:
 * - user_profile → بديل instagram_basic الملغاة (user_id, username, account_type)
 * - business_management → مطلوب للوصول لأصول Business المرتبطة
 * - instagram_business_manage_messages →Messaging API؛ تُطلب فقط إذا كان التطبيق
 *   مفعّل لديه منتج "Instagram Messaging" وإلا ترفضها شاشة Instagram بـ Invalid Scopes.
 */
const IG_SCOPES_BASE = ["user_profile", "business_management"];
const IG_SCOPE_MESSAGES = "instagram_business_manage_messages";

const SCOPES: Record<string, string[]> = {
  facebook: [
    "pages_show_list",
    "pages_messaging",
    "pages_manage_metadata",
    "pages_read_engagement",
    "business_management",
  ],
  instagram: [
    // صلاحيات Facebook Login فقط — لا تُطلب أي صلاحية instagram_* هنا.
    // أسباب الرفض التي ظهرت سابقاً ("Invalid Scopes"):
    //   • instagram_basic / instagram_manage_messages → مُلغاة من Facebook Login.
    //   • instagram_business_basic / instagram_business_manage_messages → خاصة
    //     بـ Instagram Login (www.instagram.com/oauth/authorize) وترفضها
    //     facebook.com/dialog/oauth.
    // ربط Instagram عبر Facebook Login يتم بالصفحة الوسيطة:
    //   pages_show_list        → GET /me/accounts (اكتشاف الصفحات)
    //   pages_read_engagement  → قراءة بيانات الصفحة + حساب IG المرتبط
    //                            (instagram_user_account / instagram_business_account)
    //   pages_manage_metadata  → اشتراك Webhooks وتفعيل أحداث messages
    //   pages_messaging        → إرسال الردود (Messenger/IG Messaging عبر الصفحة)
    //   business_management    → الوصول لأصول Business Manager عند الحاجة
    // ملاحظة: إدارة الرسائل المباشرة لحساب IG تتطلب أيضاً تفعيل منتج
    // "Instagram" + اشتراك webhook لأحداث messages في App Dashboard —
    // وهي إعدادات لوحة تحكم وليست scopes في هذا الطلب.
    "pages_show_list",
    "pages_messaging",
    "pages_manage_metadata",
    "pages_read_engagement",
    "business_management",
  ],
};

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

/* ═══════════ state عشوائي قوي، موقّع، ومخزن لمرة واحدة (منع CSRF وإعادة الاستخدام) ═══════════ */

type OAuthStateRecord = {
  platform: string;
  tenantId: string;
  userId: string;
  createdAt: number;
};

const STATE_TTL_MS = 15 * 60 * 1000;
const stateStore = new Map<string, OAuthStateRecord>();

function pruneStates() {
  const now = Date.now();
  for (const [k, v] of stateStore) {
    if (now - v.createdAt > STATE_TTL_MS) stateStore.delete(k);
  }
}

function signState(payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const secret = process.env.META_APP_SECRET || process.env.FIELD_ENCRYPTION_KEY || "";
  if (!secret) throw new Error("لا يوجد سر ل توقيع state — اضبط META_APP_SECRET");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyState(state: string): any | null {
  try {
    const [body, sig] = state.split(".");
    if (!body || !sig) return null;
    const secret = process.env.META_APP_SECRET || process.env.FIELD_ENCRYPTION_KEY || "";
    if (!secret) return null;
    const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
    if (
      sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    )
      return null;
    return JSON.parse(Buffer.from(body, "base64url").toString());
  } catch {
    return null;
  }
}

/** إنشاء state جديد مرتبط بالمستخدم والـ tenant — nonce عشوائي يُستهلك مرة واحدة */
function createOAuthState(rec: Omit<OAuthStateRecord, "createdAt">): string {
  pruneStates();
  const nonce = crypto.randomBytes(16).toString("hex");
  stateStore.set(nonce, { ...rec, createdAt: Date.now() });
  return signState({ n: nonce, p: rec.platform, t: rec.tenantId });
}

/** التحقق من state واستهلاكه — لا يمكن إعادة استخدامه إطلاقاً */
function consumeOAuthState(state: string): OAuthStateRecord | null {
  pruneStates();
  const decoded = verifyState(state);
  if (!decoded?.n) return null;
  const rec = stateStore.get(decoded.n);
  if (!rec) return null; // منتهي أو غير معروف أو مُعاد استخدامه
  stateStore.delete(decoded.n); // استهلاك لمرة واحدة
  if (Date.now() - rec.createdAt > STATE_TTL_MS) return null;
  // ربط صارم: ما في الـ payload الموقّع يجب أن يطابق السجل المخزّن
  if (decoded.p !== rec.platform || decoded.t !== rec.tenantId) return null;
  return rec;
}

/* تحقق الملكية عبر bearer token (نفس نمط requireAuth في channels.ts) */
async function requireUser(req: any, res: any, next: any) {
  const header = String(req.headers.authorization ?? "");
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
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

metaAuthRouter.use(requireUser);

// 1) بدء OAuth — الخادم يبني الرابط، الأسرار لا تغادره أبداً
metaAuthRouter.post("/facebook/start", async (req: any, res) => {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) {
    return res.status(400).json({
      error: "oauth_not_configured",
      message: "تطبيق Meta غير مُهيّأ على الخادم بعد (META_APP_ID / META_APP_SECRET).",
    });
  }

  const { platform } = req.body ?? {};
  if (platform !== "facebook" && platform !== "instagram") {
    return res.status(400).json({ error: "قناة غير مدعومة" });
  }

  const tenant = await ownedTenant(req.userId, req.body?.tenantId);
  if (!tenant) return res.status(403).json({ error: "تعذر التحقق من ملكية النشاط التجاري" });

  let redirectUri: string;
  let state: string;
  try {
    redirectUri = buildMetaCallbackUrl();
    state = createOAuthState({ platform, tenantId: tenant.id, userId: req.userId });
  } catch (e: any) {
    console.error("[Meta Auth] إعداد OAuth غير صالح:", e?.message);
    return res.status(500).json({
      error: "oauth_misconfigured",
      message: "إعداد PUBLIC_URL غير صحيح على الخادم (يجب أن يكون https بلا مسار).",
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

/* ═══════════ Instagram Login — تدفق OAuth مستقل تمامًا عن Facebook Login ═══════════ */

/** متغير اختياري لتعطيل طلب صلاحية المراسلة إذا كان منتج Instagram Messaging غير مفعّل بعد في التطبيق */
const IG_MESSAGES_DISABLED = /^(1|true|yes)$/i.test(process.env.INSTAGRAM_DISABLE_MESSAGES_SCOPE || "");

// I-1) بدء Instagram Login — الخادم يبني الرابط الرسمي، الأسرار لا تغادره أبداً
metaAuthRouter.post("/instagram/start", async (req: any, res) => {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) {
    return res.status(400).json({
      error: "oauth_not_configured",
      message: "تطبيق Meta غير مُهيّأ على الخادم بعد (META_APP_ID / META_APP_SECRET).",
    });
  }

  const tenant = await ownedTenant(req.userId, req.body?.tenantId);
  if (!tenant) return res.status(403).json({ error: "تعذر التحقق من ملكية النشاط التجاري" });

  let redirectUri: string;
  let state: string;
  try {
    // مبني من PUBLIC_URL فقط — لا اعتماد على META_REDIRECT_URI
    redirectUri = buildInstagramCallbackUrl();
    // platform="instagram_login" يميّز التدفق المستقل عن facebook/instagram القديم
    state = createOAuthState({ platform: "instagram_login", tenantId: tenant.id, userId: req.userId });
  } catch (e: any) {
    console.error("[Instagram Auth] إعداد OAuth غير صالح:", e?.message);
    return res.status(500).json({
      error: "oauth_misconfigured",
      message: "إعداد PUBLIC_URL غير صحيح على الخادم (يجب أن يكون https بلا مسار).",
    });
  }

  const scopes = IG_MESSAGES_DISABLED ? [...IG_SCOPES_BASE] : [...IG_SCOPES_BASE, IG_SCOPE_MESSAGES];

  console.log("[Instagram Auth] OAuth start → redirect_uri:", redirectUri, "scopes:", scopes.join(","));

  // نقطة التفويض الرسمية لـ Instagram Login (وليست facebook.com/dialog/oauth)
  const url =
    `${IG_AUTHORIZE_URL}?client_id=${encodeURIComponent(appId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(scopes.join(","))}` +
    `&state=${encodeURIComponent(state)}`;

  res.json({ url });
});

// I-2) callback من Instagram — بدون auth، الأمان بالتوقيع + الاستهلاك لمرة واحدة
metaAuthRouter.get("/instagram/callback", async (req: any, res) => {
  const frontBase = frontendDashboardUrl();
  const fail = (code: string) =>
    res.redirect(`${frontBase}?channel_error=${encodeURIComponent(code)}`);

  const { code, state, error: igError } = req.query as Record<string, string>;
  // المستخدم رفض أو ألغى تسجيل الدخول من شاشة Instagram
  if (igError) return fail(igError === "access_denied" ? "user_cancelled" : igError);
  if (!code || !state) return fail("missing_params");

  const session = consumeOAuthState(String(state));
  if (!session || session.platform !== "instagram_login") return fail("oauth_state");

  const { tenantId } = session;
  const appId = process.env.META_APP_ID!;
  const appSecret = process.env.META_APP_SECRET!;
  const redirectUri = buildInstagramCallbackUrl();

  console.log("[Instagram Auth] OAuth callback → redirect_uri:", redirectUri);

  try {
    // 1) تبادل authorization code برمز قصير الأمد — من الخادم فقط
    const tokenRes = await fetch(`${IG_GRAPH_API}/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: appId,
        client_secret: appSecret,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code: String(code),
      }).toString(),
    });
    const tokenData: any = await tokenRes.json();
    if (!tokenData.access_token) {
      // لا نسجل أي رمز — فقط وصف الخطأ
      console.error("[Instagram Auth] token exchange failed:", tokenData?.error_message ?? tokenData?.error?.message ?? "unknown");
      return fail("oauth_token — رفضت Instagram تبادل الرمز (تحقق من مطابقة redirect_uri المسجلة في Meta)");
    }

    let accessToken: string = tokenData.access_token;
    let expiresIn = Number(tokenData.expires_in ?? 0);

    // 2) ترقية الرمز إلى 60 يومًا (upgradetoken الخاص بـ Instagram Login)
    try {
      const upRes = await fetch(`${IG_GRAPH_API}/upgradetoken?${new URLSearchParams({
        client_id: appId,
        client_secret: appSecret,
        grant_type: "ig_exchange_token",
        access_token: accessToken,
      }).toString()}`);
      const upData: any = await upRes.json();
      if (upData.access_token) {
        accessToken = upData.access_token;
        expiresIn = Number(upData.expires_in ?? expiresIn);
      }
    } catch {
      /* بقي الرمز قصير الأمد — الربط يعمل مع إعادة ربط لاحقة */
    }

    const expiresAt = expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

    // 3) بيانات الحساب — user_id وusername ونوع الحساب من نقطة Instagram Login الرسمية
    const meRes = await fetch(
      `${IG_GRAPH_API}/me?${new URLSearchParams({
        fields: "user_id,username,account_type",
        access_token: accessToken,
      }).toString()}`
    );
    const me: any = await meRes.json();
    if (!me?.user_id) {
      console.error("[Instagram Auth] /me failed:", me?.error?.message ?? "unknown");
      return fail("oauth_profile — تعذر جلب بيانات حساب Instagram");
    }

    // التحقق من أهلية الحساب: المراسلة تتطلب احترافي (BUSINESS=1 أو CREATOR=2 أو 3)
    const accountType = Number(me.account_type ?? 0);
    const isProfessional = accountType === 1 || accountType === 2 || accountType === 3;

    // سياسة الملكية الحصرية: نفس الحساب لا يُربط بأكثر من tenant نشط
    const { data: taken } = await db
      .from("channel_accounts")
      .select("tenant_id")
      .eq("channel", "instagram")
      .eq("external_id", String(me.user_id))
      .neq("tenant_id", tenantId)
      .eq("status", "active")
      .maybeSingle();
    if (taken) {
      return fail("already_linked — هذا الحساب مرتبط بنشاط آخر بالفعل");
    }

    // 4) الحفظ في channel_accounts — التشفير بالآلية الحالية، والرمز لا يغادر الخادم
    const username = me.username ? `@${me.username}` : String(me.user_id);
    const { error: upErr } = await db.from("channel_accounts").upsert(
      {
        tenant_id: tenantId,
        channel: "instagram",
        external_id: String(me.user_id),
        display_name: username,
        status: "active",
        access_token_encrypted: encryptField(accessToken),
        token_expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id,channel,external_id" }
    );
    if (upErr) {
      console.error("[Instagram Auth] save error:", upErr.message);
      return fail("save_failed — تعذر حفظ الحساب المرتبط");
    }

    // تحديث سجل القناة في جدول channels إن وُجد (best effort — نفس نمط facebook)
    await db
      .from("channels")
      .update({
        is_connected: true,
        connected_at: new Date().toISOString(),
        account_name: username,
      })
      .eq("tenant_id", tenantId)
      .eq("platform", "instagram");

    console.log(`[Instagram Auth] ✓ Linked ${username} (${me.user_id}) professional=${isProfessional}`);

    // 5) العودة إلى GitHub Pages مع حالة نجاح واضحة (لا يظهر أي رمز للواجهة)
    res.redirect(
      `${frontBase}?channel_connected=instagram&accounts=1&name=${encodeURIComponent(username)}${isProfessional ? "" : "&note=personal_account"}`
    );
  } catch (e: any) {
    console.error("[Instagram Auth] callback error:", e);
    fail(e?.message ? String(e.message).slice(0, 120) : "unknown");
  }
});

// 2) callback — بدون auth (Meta تعود إليه مباشرة)، الأمان بالتوقيع + الاستهلاك لمرة واحدة
metaAuthRouter.get("/facebook/callback", async (req: any, res) => {
  const frontBase = frontendDashboardUrl();
  const fail = (code: string) =>
    res.redirect(`${frontBase}?channel_error=${encodeURIComponent(code)}`);

  const { code, state, error: metaError } = req.query as Record<string, string>;
  if (metaError) return fail(metaError === "access_denied" ? "user_cancelled" : metaError);
  if (!code || !state) return fail("missing_params");

  const session = consumeOAuthState(String(state));
  if (!session) return fail("oauth_state");

  const { platform, tenantId, userId } = session;
  const appId = process.env.META_APP_ID!;
  const appSecret = process.env.META_APP_SECRET!;
  const redirectUri = buildMetaCallbackUrl();

  console.log("[Meta Auth] OAuth callback → redirect_uri:", redirectUri, "platform:", platform);

  try {
    // تبادل الرمز قصير الأمد — من الخادم فقط
    const tokenRes = await fetch(
      `${GRAPH_API}/oauth/access_token?client_id=${encodeURIComponent(appId)}&client_secret=${encodeURIComponent(appSecret)}&redirect_uri=${encodeURIComponent(redirectUri)}&code=${encodeURIComponent(code)}`
    );
    const tokenData: any = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error("[Meta Auth] token exchange failed:", tokenData?.error?.message ?? "unknown");
      throw new Error("رفضت Meta تبادل الرمز — تحقق من مطابقة redirect_uri وإعداد التطبيق.");
    }

    // تحويل إلى long-lived
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

    // جلب الصفحات التي يستطيع المستخدم إدارتها
    const pagesRes = await fetch(`${GRAPH_API}/me/accounts?fields=id,name,picture&access_token=${accessToken}`);
    const pagesData: any = await pagesRes.json();
    const pages: any[] = pagesData.data ?? [];

    let saved = 0;
    let lastAccountName = "";

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
            // الرمز يُحفظ مشفراً على الخادم فقط — لا يصل الواجهة أبداً
            access_token_encrypted: encryptField(pageToken),
            token_expires_at: expiresAt,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "tenant_id,channel,external_id" }
        );
        if (!error) {
          saved += 1;
          lastAccountName = p.name ?? lastAccountName;
        }
      } else if (platform === "instagram") {
        // حساب Instagram الاحترافي المرتبط بالصفحة هو المؤهل للمراسلة فقط
        const igRes = await fetch(
          `${GRAPH_API}/${p.id}?fields=name,instagram_user_account{id,username,picture},instagram_business_account{id,username,picture_url}&access_token=${accessToken}`
        );
        const ig: any = await igRes.json();
        const igAcc = ig?.instagram_user_account ?? ig?.instagram_business_account;
        if (!igAcc?.id) continue; // غير مؤهل — لا نحفظ حسابات شخصية

        const username = igAcc.username ? `@${igAcc.username}` : ig?.name ?? null;
        const igPicture =
          typeof igAcc?.picture?.data?.url === "string"
            ? igAcc.picture.data.url
            : typeof igAcc?.picture_url === "string"
              ? igAcc.picture_url
              : picture;

        // سياسة الملكية الحصرية: نفس الحساب لا يُربط بأكثر من tenant
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
        }
      }
    }

    if (saved === 0) {
      return fail(
        platform === "instagram"
          ? "no_eligible_instagram — لم يُعثر على حساب Instagram احترافي مرتبط بصفحاتك"
          : "no_pages — لم تمنح صلاحيات لأي صفحة Facebook"
      );
    }

    // تحديث سجل القناة في جدول channels إن وُجد (best effort — لا نفترض تنفيذه)
    await db
      .from("channels")
      .update({
        is_connected: true,
        connected_at: new Date().toISOString(),
        account_name: lastAccountName || null,
      })
      .eq("tenant_id", tenantId)
      .eq("platform", platform);

    res.redirect(
      `${frontBase}?channel_connected=${platform}&accounts=${saved}&name=${encodeURIComponent(lastAccountName)}`
    );
  } catch (e: any) {
    console.error("[Meta Auth] callback error:", e);
    fail(e?.message ? String(e.message).slice(0, 120) : "unknown");
  }
});

// 3) فصل قناة
metaAuthRouter.post("/disconnect", async (req: any, res) => {
  const { platform } = req.body ?? {};
  if (platform !== "facebook" && platform !== "instagram") {
    return res.status(400).json({ error: "قناة غير مدعومة" });
  }
  const tenant = await ownedTenant(req.userId, req.body?.tenantId);
  if (!tenant) return res.status(403).json({ error: "تعذر التحقق من ملكية النشاط" });

  // حذف الرموز من الحسابات + إغلاق السجل
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
    .update({ is_connected: false, account_name: null, account_avatar: null, platform_account_id: null })
    .eq("tenant_id", tenant.id)
    .eq("platform", platform);

  res.json({ ok: true });
});
