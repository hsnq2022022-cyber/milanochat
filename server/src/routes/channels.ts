/**
 * مسارات القنوات والحسابات — Omnichannel
 * - CRUD لحسابات channel_accounts لكل عميل (Multi-Tenant)
 * - روابط بدء OAuth الرسمية لتطبيق Meta (Facebook / Instagram)
 * - ملاحظة: WhatsApp يبقى عبر مسار الربط الحالي (/api/whatsapp)
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { db, authClient } from "../db.js";
import { config } from "../config.js";
import { encryptField } from "../crypto.js";

export const channelsRouter = Router();

type AuthedRequest = Request & { userId?: string };

async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "غير مصرح" });
  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ error: "جلسة غير صالحة" });
  (req as AuthedRequest).userId = data.user.id;
  next();
}

channelsRouter.use(requireAuth);

type ChannelId = "whatsapp" | "instagram" | "facebook";
const VALID_CHANNELS = ["whatsapp", "instagram", "facebook"];

/* جلب tenant المالك (نفس نمط dashboard router — tenants.user_id) */
async function ownedTenant(userId: string, tenantId?: string) {
  if (tenantId) {
    const { data } = await db
      .from("tenants")
      .select("*")
      .eq("id", tenantId)
      .eq("user_id", userId)
      .maybeSingle();
    return data;
  }
  const { data } = await db
    .from("tenants")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  return data;
}

/** قائمة حسابات العميل مرتبة حسب القناة */
channelsRouter.get("/accounts", async (req, res) => {
  const userId = (req as any).userId as string;
  const tenant = await ownedTenant(userId, req.query.tenantId as string);
  if (!tenant) return res.status(404).json({ error: "لا يوجد حساب مرتبط" });

  const { data, error } = await db
    .from("channel_accounts")
    .select("id, channel, external_id, display_name, avatar_url, status, agent_enabled, auto_reply, language, handoff_rules, agent_config, token_expires_at, created_at, updated_at")
    .eq("tenant_id", tenant.id)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
});

/** إحصاءات سريعة لكل قناة (عدد الحسابات + المحادثات) */
channelsRouter.get("/summary", async (req, res) => {
  const userId = (req as any).userId as string;
  const tenant = await ownedTenant(userId, req.query.tenantId as string);
  if (!tenant) return res.status(404).json({ error: "لا يوجد حساب مرتبط" });

  const [accRes, convRes] = await Promise.all([
    db.from("channel_accounts").select("channel, status").eq("tenant_id", tenant.id),
    db.from("conversations").select("channel").eq("tenant_id", tenant.id),
  ]);

  const summary: Record<string, { accounts: number; active: number; conversations: number }> = {
    whatsapp: { accounts: 0, active: 0, conversations: 0 },
    instagram: { accounts: 0, active: 0, conversations: 0 },
    facebook: { accounts: 0, active: 0, conversations: 0 },
  };

  for (const a of accRes.data ?? []) {
    const s = summary[a.channel];
    if (!s) continue;
    s.accounts += 1;
    if (a.status === "active") s.active += 1;
  }
  for (const c of convRes.data ?? []) {
    const ch = c.channel ?? "whatsapp";
    if (summary[ch]) summary[ch].conversations += 1;
  }

  res.json(summary);
});

/** تعديل إعدادات حساب (الوكيل / الرد التلقائي / اللغة / قواعد التحويل) */
channelsRouter.patch("/accounts/:id", async (req, res) => {
  const userId = (req as any).userId as string;
  const tenant = await ownedTenant(userId, req.query.tenantId as string);
  if (!tenant) return res.status(404).json({ error: "لا يوجد حساب مرتبط" });

  const allowed = ["agent_enabled", "auto_reply", "language", "handoff_rules", "agent_config", "display_name", "status"];
  const patch: Record<string, unknown> = {};
  for (const k of allowed) {
    if (req.body?.[k] !== undefined) patch[k] = req.body[k];
  }
  if (patch.status && !["active", "needs_reauth", "disconnected"].includes(String(patch.status))) {
    return res.status(400).json({ error: "حالة غير صالحة" });
  }
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: "لا توجد حقول للتعديل" });

  patch.updated_at = new Date().toISOString();

  const { data, error } = await db
    .from("channel_accounts")
    .update(patch)
    .eq("id", req.params.id)
    .eq("tenant_id", tenant.id) // عزل بيانات العملاء: لا تعديل خارج النطاق
    .select()
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "الحساب غير موجود" });
  res.json(data);
});

/** فصل حساب (soft delete → disconnected، والرمز يُعطَّل) */
channelsRouter.delete("/accounts/:id", async (req, res) => {
  const userId = (req as any).userId as string;
  const tenant = await ownedTenant(userId, req.query.tenantId as string);
  if (!tenant) return res.status(404).json({ error: "لا يوجد حساب مرتبط" });

  const { error } = await db
    .from("channel_accounts")
    .update({ status: "disconnected", access_token_encrypted: null, updated_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .eq("tenant_id", tenant.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

/** رابط بدء OAuth الرسمي لصفحات Facebook / حسابات Instagram */
channelsRouter.get("/meta/oauth-url", async (req, res) => {
  const userId = (req as any).userId as string;
  const tenant = await ownedTenant(userId, req.query.tenantId as string);
  if (!tenant) return res.status(404).json({ error: "لا يوجد حساب مرتبط" });

  const appId = process.env.META_APP_ID;
  if (!appId) {
    return res.status(503).json({
      error: "تطبيق Meta غير مُهيّأ على الخادم بعد. تواصل مع إدارة المنصة لتفعيل ربط فيسبوك وإنستغرام.",
    });
  }

  const channel = String(req.query.channel ?? "facebook") as ChannelId;
  if (!VALID_CHANNELS.includes(channel)) return res.status(400).json({ error: "قناة غير صالحة" });

  // الصلاحيات الدنيا المطلوبة فعلياً لكل قناة — لا نطلب صلاحيات غير مستخدمة
  const scopes =
    channel === "instagram"
      ? ["pages_show_list", "pages_messaging", "pages_manage_metadata", "instagram_basic", "instagram_manage_messages"]
      : ["pages_show_list", "pages_messaging", "pages_manage_metadata", "pages_read_engagement"];

  const redirect = `${config.publicUrl}/api/channels/meta/callback`;
  const state = btoa(JSON.stringify({ tenantId: tenant.id, userId, channel }));

  const url =
    `https://www.facebook.com/v21.0/dialog/oauth` +
    `?client_id=${encodeURIComponent(appId)}` +
    `&redirect_uri=${encodeURIComponent(redirect)}` +
    `&scope=${encodeURIComponent(scopes.join(","))}` +
    `&state=${encodeURIComponent(state)}`;

  res.json({ url, scopes });
});

/**
 * callback من Meta — يستبدل الرمز قصير الأمد ثم يحفظ الحساب.
 * الرموز تُخزن مشفرة على الخادم فقط ولا ترسل أبداً للواجهة.
 */
channelsRouter.get("/meta/callback", async (req, res) => {
  try {
    const { code, state } = req.query as Record<string, string>;
    if (!code || !state) return res.redirect("/#/dashboard?error=oauth_missing");

    let parsed: { tenantId: string; userId: string; channel: string };
    try {
      parsed = JSON.parse(atob(state));
    } catch {
      return res.redirect("/#/dashboard?error=oauth_state");
    }
    if (!VALID_CHANNELS.includes(parsed.channel)) return res.redirect("/#/dashboard?error=oauth_channel");

    const appSecret = process.env.META_APP_SECRET;
    const appId = process.env.META_APP_ID;
    if (!appSecret || !appId) return res.redirect("/#/dashboard?error=oauth_not_configured");

    const redirect = `${config.publicUrl}/api/channels/meta/callback`;

    // استبدال الرمز برمز طويل الأمد
    const tokenRes = await fetch(
      `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${code}`
    );
    const tokenJson: any = await tokenRes.json();
    if (!tokenJson.access_token) return res.redirect("/#/dashboard?error=oauth_token");

    // جلب الصفحات التي يديرها المستخدم
    const pagesRes = await fetch(
      `https://graph.facebook.com/v21.0/me/accounts?access_token=${tokenJson.access_token}`
    );
    const pagesJson: any = await pagesRes.json();
    const pages: any[] = pagesJson.data ?? [];

    for (const p of pages) {
      if (!p?.id) continue;
      const channel = parsed.channel === "instagram" ? "instagram" : "facebook";
      const { error } = await db.from("channel_accounts").upsert(
        {
          tenant_id: parsed.tenantId,
          channel,
          external_id: String(p.id),
          display_name: p.name ?? null,
          status: "active",
          access_token_encrypted: encryptField(p.access_token ?? tokenJson.access_token),
          token_expires_at: tokenJson.expires_in
            ? new Date(Date.now() + Number(tokenJson.expires_in) * 1000).toISOString()
            : null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "tenant_id,channel,external_id" }
      );
      if (error) console.error("[channels] upsert failed:", error);
    }

    res.redirect("/#/dashboard?tab=channels&connected=1");
  } catch (err) {
    console.error("[channels] oauth callback error:", err);
    res.redirect("/#/dashboard?error=oauth_failed");
  }
});
