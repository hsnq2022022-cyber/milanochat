/**
 * مسارات ربط Meta عبر OAuth — Facebook Pages + Instagram Professional
 *
 * التدفق المعتمد: Facebook Login → Instagram Graph API / Messaging API
 * (هذا هو التدفق الرسمي الوحيد الذي يدعم رسائل العملاء على حسابات
 * Instagram الاحترافية عبر Instagram Messaging API — وليس Instagram Login
 * المباشر الذي لا يمنح instagram_manage_messages للتطبيقات الخارجية).
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
    "instagram_basic",
    "instagram_manage_messages",
    "pages_show_list",
    "pages_messaging",
    "pages_manage_metadata",
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
