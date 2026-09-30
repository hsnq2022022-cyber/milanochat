/**
 * مسارات ربط Meta عبر OAuth — Facebook Pages + Instagram Professional
 *
 * التدفق المعتمد (حسب إعداد تطبيق Meta الفعلي — App ID 4221334814824983):
 *   Instagram API with Facebook Login
 * المستخدم يسجّل الدخول عبر facebook.com/dialog/oauth، ثم يجلب الخادم
 * /me/accounts ويستخرج حساب Instagram الاحترافي المرتبط بالصفحة
 * (instagram_user_account / instagram_business_account) ويحفظه في
 * channel_accounts بقناة "instagram".
 *
 * الصلاحيات المطلوبة لقناة instagram هي المطابقة حرفياً لشاشة أذونات التطبيق:
 *   لإدارة محتوى Instagram: instagram_basic, pages_read_engagement,
 *                            business_management, pages_show_list
 *   لرسائل Instagram:        instagram_basic, instagram_manage_messages,
 *                            pages_read_engagement
 * ملاحظة: لا تُستخدم أبداً أسماء Instagram Login (instagram_business_basic /
 * instagram_business_manage_messages) في هذا التدفق — فهي خاصة بنقطة
 * www.instagram.com/oauth/authorize وترفضها شاشة Facebook.
 *
 * المسارات:
 *   Dashboard → POST /api/auth/facebook/start (platform=facebook|instagram, tenantId)
 *   ← { url } رابط Meta OAuth الرسمي بـ state عشوائي موقّع ومخزن لمرة واحدة
 *   المستخدم يفوّض في Meta → GET /api/auth/facebook/callback
 *   ← تبادل الرمز برمز طويل الأمد من الخادم فقط، جلب الصفحات/حسابات IG
 *     المؤهلة، الحفظ في channel_accounts (تشفير على الخادم فقط)،
 *     ثم redirect إلى GitHub Pages مع باراميترات نجاح/فشل.
 */
import express, { Router } from "express";
import crypto from "node:crypto";
import { db, authClient } from "../db.js";
import { config, buildMetaCallbackUrl } from "../config.js";
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
    // Instagram API with Facebook Login — الأذونات مطابقة لشاشة تطبيق Meta الفعلي:
    //   instagram_basic           → قراءة ملف تعريف حساب IG المرتبط بالصفحة
    //   instagram_manage_messages → استقبال رسائل العملاء والرد عليها (Messaging)
    //   pages_read_engagement     → قراءة بيانات الصفحة وحساب IG المرتبط
    //   pages_show_list           → GET /me/accounts (اكتشاف الصفحات)
    //   business_management       → الوصول لأصول Business Manager عند الحاجة
    //   pages_manage_metadata     → اشتراك Webhooks وتفعيل أحداث messages
    //   pages_messaging           → إرسال الردود عبر Messenger/IG Messaging
    "instagram_basic",
    "instagram_manage_messages",
    "pages_read_engagement",
    "pages_show_list",
    "business_management",
    "pages_manage_metadata",
    "pages_messaging",
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

/* ═══════════ state: توقيع HMAC ثابت-المصدر + سجل استهلاك واحد — آمن مع تعدد النسخ/restart/إعادة النشر ═══════════
   التصميم الأول كان يخزن state في Map داخل عملية Node الواحدة — يفشل عند تعدد النسخ/restart.
   التصميم الثاني (HMAC فقط) أثبت فشله الميداني: كل deploy يعيد توليد META_APP_STATE_SECRET
   (كان يسقط إلى crypto.randomBytes) فتصبح كل states ما قبل النشر غير قابلة للتحقق → oauth_state.
   الحل النهائي:
   1) السر يُشتق حصريًا من META_APP_SECRET الثابت في Railway (لا sources متذبذبة).
   2) السجل الوحيد الموثوق لعدم إعادة الاستخدام/الإبطال هو جدول meta_oauth_states في Supabase
      — مشترك بين كل النسخ، ويصمد أمام restarts وإعادة النشر. */

type OAuthStatePayload = {
  u: string; // userId
  t: string; // tenantId
  p: string; // platform
  i: string; // nonce مطابق لعمود id في meta_oauth_states
  exp: number; // unix seconds
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

/** إنشاء state موقّع + تسجيله في قاعدة البيانات (السجل الوحيد للاستهلاك) */
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
    // إن كان الجدول غير منشأ بعد — نتابع بوضع HMAC-only (توافق خلفي) مع تحذير واضح
    console.warn("[Meta Auth] meta_oauth_states insert failed (يتطلب migration 0007):", error.message);
  }
  return { state, nonce };
}

/** التحقق من التوقيع + عدم الانتهاء + الاستهلاك لمرة واحدة من قاعدة البيانات.
 *  يعيد { ok:true, session } أو { ok:false, reason } — السبب يُسجل ويُعاد للواجهة للتشخيص. */
async function consumeOAuthState(
  state: string
): Promise<{ ok: true; session: { platform: string; tenantId: string; userId: string } } | { ok: false; reason: string }> {
  let decoded: Partial<OAuthStatePayload> | null = null;
  try {
    const dot = state.lastIndexOf(".");
    if (dot <= 0) return { ok: false, reason: "state_format" };
    const body = state.slice(0, dot);
    const sig = state.slice(dot + 1);
    const expected = hmacSign(body);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)))
      return { ok: false, reason: "state_signature" };
    decoded = JSON.parse(Buffer.from(body, "base64url").toString()) as Partial<OAuthStatePayload>;
    if (!decoded?.u || !decoded?.t || !decoded?.p || !decoded?.exp) return { ok: false, reason: "state_payload" };
    if (decoded.p !== "facebook" && decoded.p !== "instagram") return { ok: false, reason: "state_platform" };
  } catch {
    return { ok: false, reason: "state_parse" };
  }

  if (Math.floor(Date.now() / 1000) > decoded!.exp!) return { ok: false, reason: "state_expired" };

  // الاستهلاك لمرة واحدة من السجل المشترك (يعمل عبر كل النسخ وعمليات النشر)
  const { data: row, error: selErr } = await db
    .from("meta_oauth_states")
    .select("id, consumed")
    .eq("id", decoded!.i!)
    .maybeSingle();
  if (selErr) {
    // تعذر قراءة الجدول (غير منشأ) — نتجاهل فحص الاستهلاك ونقبل state صالح التوقيع
    console.warn("[Meta Auth] meta_oauth_states select failed — تجاهل فحص الاستهلاك:", selErr.message);
  } else if (!row) {
    // الجدول منشأ لكن السجل غير موجود (مثلاً state أُنشئ قبل تطبيق migration) — نتجاهل الفحص بحذر
    console.warn("[Meta Auth] meta_oauth_states: no record for nonce — تجاهل فحص الاستهلاك");
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

  return { ok: true, session: { userId: decoded!.u!, tenantId: decoded!.t!, platform: decoded!.p! } };
}

/* تحقق الملكية عبر bearer token.
   ملاحظة: تدفق OAuth الحالي في الواجهة يستخدم POST + Authorization header (apiAuthFetch)،
   لكن لدعم أي فتح مباشر للرابط (GET مع ?t=<token>) نقرأ التوكن من query أيضًا. */
async function requireUser(req: any, res: any, next: any) {
  const header = String(req.headers.authorization ?? "");
  const token = header.startsWith("Bearer ")
    ? header.slice(7)
    : req.requestMethod === "GET"
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

/* مسارات محمية بجلسة المستخدم (تُستدعى من Dashboard ببearer token) */
const protectedRoutes = express.Router();
protectedRoutes.use(requireUser);

/* مسار عام — Meta تعود إليه مباشرة في المتصفح بدون أي Authorization header.
   الأمان هنا لا يعتمد على الجلسة إطلاقاً، بل على state الموقّع HMAC + الاستهلاك
   لمرة واحدة (consumeOAuthState) الذي يربط العملية بالمستخدم والـ tenant الصحيحين.
   ملاحظة حرجة: هذا المسار يجب أن يُسجل قبل metaAuthRouter.use(requireUser)،
   لأن router.use middleware يُطبَّق على كل طلب يطابق الراوتر بغض النظر عن Method،
   فكان callback يحصل على 401 {"error":"غير مصرح"} قبل تنفيذ معالجه. */
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
    // تبادل الرمز قصير الأمد — من الخادم فقط
    const tokenRes = await fetch(
      `${GRAPH_API}/oauth/access_token?client_id=${encodeURIComponent(appId)}&client_secret=${encodeURIComponent(appSecret)}&redirect_uri=${encodeURIComponent(redirectUri)}&code=${encodeURIComponent(code)}`
    );
    const tokenData: any = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error("[Meta Auth] token exchange failed:", tokenData?.error?.message ?? "unknown");
      return fail("oauth_token_exchange");
    }
    console.log("[Meta Auth] token exchange OK");

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
    console.log("[Meta Auth] /me/accounts → pages:", pages.length, pages.map((p) => p?.id).join(","));
    if (pagesData.error) console.error("[Meta Auth] /me/accounts error:", pagesData.error?.message ?? "unknown");

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
        console.log(`[Meta Auth] page ${p.id} IG discovery:`, igAcc?.id ? `found ${igAcc.username ?? igAcc.id}` : `not found (${ig?.error?.message ?? "no linked account"})`);
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

/* ما تبقى من مسارات: محمي بجلسة المستخدم */
metaAuthRouter.use(protectedRoutes);

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
