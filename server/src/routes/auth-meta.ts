/**
 * مسارات ربط Meta عبر OAuth — Facebook Pages + Instagram Professional
 *
 * ملاحظة معمارية مهمة: هذا الراوتر يستخدم نفس البنية الموجودة فعلياً في
 * المشروع (جدول channel_accounts + التشفير على الخادم عبر encryptField)،
 * ولا يخزن access_token نصاً صريحاً في قاعدة البيانات — لأن المطلوب
 * صراحةً: "لا تضع App Secret أو Access Tokens في Frontend أو بشكل مكشوف".
 *
 * التدفق:
 *   Dashboard → POST /api/auth/facebook/start (platform, tenantId)
 *   ← { url } رابط Meta OAuth الرسمي بـ state يحمل tenantId+platform
 *   المستخدم يفوّض في Meta → GET /api/auth/facebook/callback
 *   ← تبادل الرمز برمز طويل الأمد، جلب الصفحات/حسابات IG المؤهلة،
 *     الحفظ في channel_accounts (تشفير على الخادم فقط)،
 *     ثم redirect إلى الواجهة مع ?channel_connected=platform&accounts=N
 */
import { Router } from "express";
import crypto from "node:crypto";
import { db, authClient } from "../db.js";
import { config } from "../config.js";
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

/* state موقّع حتى لا يُزيَّف tenantId أثناء العودة من Meta */
function signState(payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const secret = process.env.META_APP_SECRET || process.env.APP_ENCRYPTION_KEY || "state-key";
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyState(state: string): any | null {
  try {
    const [body, sig] = state.split(".");
    const secret = process.env.META_APP_SECRET || process.env.APP_ENCRYPTION_KEY || "state-key";
    const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
    if (
      sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    )
      return null;
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString());
    // صلاحية 15 دقيقة للجلسة
    if (!parsed.ts || Date.now() - Number(parsed.ts) > 15 * 60 * 1000) return null;
    return parsed;
  } catch {
    return null;
  }
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

  const scopes = SCOPES[platform];
  const state = signState({ platform, tenantId: tenant.id, ts: Date.now() });
  const redirectUri = `${config.publicUrl}/api/auth/facebook/callback`;

  const url =
    `https://www.facebook.com/v21.0/dialog/oauth?client_id=${appId}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}&scope=${scopes.join(",")}&response_type=code`;

  res.json({ url });
});

// 2) callback — بدون auth (Meta تعود إليه مباشرة)، الأمان بالتوقيع في state
metaAuthRouter.get("/facebook/callback", async (req: any, res) => {
  const frontBase = `${config.publicUrl}/#/dashboard`;
  const fail = (code: string) => res.redirect(`${frontBase}?channel_error=${encodeURIComponent(code)}`);

  const { code, state, error: metaError } = req.query as Record<string, string>;
  if (metaError) return fail(metaError === "access_denied" ? "user_cancelled" : metaError);
  if (!code || !state) return fail("missing_params");

  const decoded = verifyState(String(state));
  if (!decoded) return fail("oauth_state");

  const { platform, tenantId } = decoded as { platform: string; tenantId: string };
  const appId = process.env.META_APP_ID!;
  const appSecret = process.env.META_APP_SECRET!;
  const redirectUri = `${config.publicUrl}/api/auth/facebook/callback`;

  try {
    // تبادل الرمز قصير الأمد
    const tokenRes = await fetch(
      `${GRAPH_API}/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&redirect_uri=${encodeURIComponent(redirectUri)}&code=${code}`
    );
    const tokenData: any = await tokenRes.json();
    if (!tokenData.access_token) throw new Error(tokenData.error?.message || "فشل الحصول على access_token");

    // تحويل إلى long-lived
    let accessToken = tokenData.access_token;
    try {
      const longRes = await fetch(
        `${GRAPH_API}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${accessToken}`
      );
      const longData: any = await longRes.json();
      if (longData.access_token) accessToken = longData.access_token;
    } catch {
      /* بقي الرمز قصير الأمد */
    }

    // جلب الصفحات
    const pagesRes = await fetch(`${GRAPH_API}/me/accounts?fields=id,name,picture&access_token=${accessToken}`);
    const pagesData: any = await pagesRes.json();
    const pages: any[] = pagesData.data ?? [];

    let saved = 0;
    let lastAccountName = "";

    for (const p of pages) {
      if (!p?.id) continue;
      const picture = typeof p.picture?.data?.url === "string" ? p.picture.data.url : null;

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
            access_token_encrypted: encryptField(p.access_token ?? accessToken),
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
          `${GRAPH_API}/${p.id}?fields=instagram_user_account{id,username},instagram_business_account{id,username}&access_token=${accessToken}`
        );
        const ig: any = await igRes.json();
        const igAcc = ig?.instagram_user_account ?? ig?.instagram_business_account;
        if (!igAcc?.id) continue; // غير مؤهل — لا نحفظ حسابات شخصية
        const { error } = await db.from("channel_accounts").upsert(
          {
            tenant_id: tenantId,
            channel: "instagram",
            external_id: String(igAcc.id),
            display_name: igAcc.username ? `@${igAcc.username}` : ig?.name ?? null,
            avatar_url: picture,
            status: "active",
            access_token_encrypted: encryptField(p.access_token ?? accessToken),
            updated_at: new Date().toISOString(),
          },
          { onConflict: "tenant_id,channel,external_id" }
        );
        if (!error) {
          saved += 1;
          lastAccountName = igAcc.username ? `@${igAcc.username}` : lastAccountName;
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

    // تحديث سجل القناة في جدول channels إن وُجد (لا نفترض تنفيذه — best effort)
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
