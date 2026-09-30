/**
 * مسارات القنوات والحسابات — Omnichannel
 * - CRUD لحسابات channel_accounts لكل عميل (Multi-Tenant)
 * - روابط بدء OAuth الرسمية لتطبيق Meta (Facebook / Instagram)
 * - ملاحظة: WhatsApp يبقى عبر مسار الربط الحالي (/api/whatsapp)
 */
import crypto from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import { db, authClient } from "../db.js";
import { config, buildServerBaseUrl } from "../config.js";
import { encryptField, decryptField } from "../crypto.js";
import { answerFromKnowledge } from "../rag/qa.js";

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

  // الصلاحيات الدنيا المطلوبة فعلياً لكل قناة — مطابقة لإعداد تطبيق Meta الفعلي
  // (Instagram API with Facebook Login). صلاحيات instagram_basic و
  // instagram_manage_messages صحيحة هنا لأن الطلب يُرسل إلى facebook.com/dialog/oauth؛
  // أما أسماء Instagram Login (instagram_business_*) فلا تُستخدم إطلاقاً.
  const scopes =
    channel === "instagram"
      ? ["instagram_basic", "instagram_manage_messages", "pages_read_engagement", "pages_show_list", "business_management", "pages_manage_metadata", "pages_messaging"]
      : ["pages_show_list", "pages_messaging", "pages_manage_metadata", "pages_read_engagement"];

  const redirect = `${buildServerBaseUrl()}/api/channels/meta/callback`;
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

    const redirect = `${buildServerBaseUrl()}/api/channels/meta/callback`;

    // استبدال الرمز برمز طويل الأمد
    const tokenRes = await fetch(
      `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${code}`
    );
    const tokenJson: any = await tokenRes.json();
    if (!tokenJson.access_token) return res.redirect("/#/dashboard?error=oauth_token");

    // جلب الصفحات التي يديرها المستخدم
    const pagesRes = await fetch(
      `https://graph.facebook.com/v21.0/me/accounts?fields=id,name,picture&access_token=${tokenJson.access_token}`
    );
    const pagesJson: any = await pagesRes.json();
    const pages: any[] = pagesJson.data ?? [];

    let facebookSaved = 0;
    for (const p of pages) {
      if (!p?.id) continue;
      const picture = typeof p.picture?.data?.url === "string" ? p.picture.data.url : null;
      const { error } = await db.from("channel_accounts").upsert(
        {
          tenant_id: parsed.tenantId,
          channel: "facebook",
          external_id: String(p.id),
          display_name: p.name ?? null,
          avatar_url: picture,
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
      else facebookSaved += 1;
    }

    /* Instagram: لكل صفحة مرتبطة — جلب الحساب الاحترافي المؤهل عبر edge_to_ig */
    let instagramSaved = 0;
    if (parsed.channel === "instagram") {
      for (const p of pages) {
        if (!p?.id) continue;
        try {
          const igRes = await fetch(
            `https://graph.facebook.com/v21.0/${p.id}?fields=instagram_type_v3,instagram_user_account&access_token=${tokenJson.access_token}`
          );
          const ig: any = await igRes.json();
          const igId = ig?.instagram_user_account?.id ?? ig?.instagram_business_account?.id;
          if (!igId) continue; // الصفحة غير مرتبطة بحساب إنستغرام احترافي مؤهل
          const username = ig?.instagram_user_account?.username ?? ig?.instagram_business_account?.username ?? null;
          const { error } = await db.from("channel_accounts").upsert(
            {
              tenant_id: parsed.tenantId,
              channel: "instagram",
              external_id: String(igId),
              display_name: username ?? ig?.name ?? String(igId),
              avatar_url: typeof ig?.instagram_user_account?.picture?.data?.url === "string"
                ? ig.instagram_user_account.picture.data.url
                : null,
              status: "active",
              access_token_encrypted: encryptField(p.access_token ?? tokenJson.access_token),
              token_expires_at: tokenJson.expires_in
                ? new Date(Date.now() + Number(tokenJson.expires_in) * 1000).toISOString()
                : null,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "tenant_id,channel,external_id" }
          );
          if (error) console.error("[channels] ig upsert failed:", error);
          else instagramSaved += 1;
        } catch (e) {
          console.error("[channels] ig lookup failed for page", p.id, e);
        }
      }
    }

    const q = new URLSearchParams({
      tab: "channels",
      connected: "1",
      fb: String(facebookSaved),
      ig: String(instagramSaved),
    });
    res.redirect(`/#/dashboard?${q.toString()}`);
  } catch (err) {
    console.error("[channels] oauth callback error:", err);
    res.redirect("/#/dashboard?error=oauth_failed");
  }
});

/** حالة إعداد تطبيق Meta على الخادم — بدون كشف أي أسرار */
channelsRouter.get("/meta/status", (_req, res) => {
  const configured = Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET);
  res.json({
    configured,
    appReviewNote:
      "حالة مراجعة صلاحيات Meta تُتابَع يدويًا من لوحة Meta Developers — المنصة لا تدّعي موافقة تلقائية.",
    developersUrl: "https://developers.facebook.com/apps",
  });
});

/* ═══════════════ Webhooks رسمية لـ Messenger / Instagram ═══════════════ */

/** التحقق الابتدائي من webhook (تُضاف في Meta Developers لنفس المسار) */
channelsRouter.get("/meta/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  const expected = process.env.META_WEBHOOK_VERIFY_TOKEN;
  if (mode === "subscribe" && expected && token === expected) {
    return res.status(200).send(String(challenge ?? ""));
  }
  return res.sendStatus(403);
});

/** استخراج نص رسالة واردة من payload من Messenger/Instagram */
function extractText(m: any): string {
  if (typeof m?.text === "string") return m.text;
  const atts = Array.isArray(m?.attachments) ? m.attachments : [];
  const parts = atts
    .map((a: any) => (typeof a?.title === "string" ? a.title : ""))
    .filter(Boolean);
  return parts.join(" ") || "[رسالة غير نصية]";
}

/**
 * استقبال رسائل Messenger و Instagram Messaging الرسمية.
 * نفس بنية payload للقناتين (entry[].messaging[]).
 */
channelsRouter.post("/meta/webhook", async (req: Request, res: Response) => {
  try {
    // تحقق من التوقيع إن وُجد META_APP_SECRET (توقيعات Messenger/IG بنفس آلية X-Hub-Signature-256)
    const secret = process.env.META_APP_SECRET;
    const sig = String(req.headers["x-hub-signature-256"] ?? "");
    const rawBody: Buffer | undefined = (req as any).rawBody;
    if (secret && rawBody) {
      const expected =
        "sha256=" +
        crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
      if (!sig || !timingSafeEqualStr(sig, expected)) {
        return res.sendStatus(401);
      }
    }

    const body: any = req.body ?? {};
    const entries: any[] = Array.isArray(body.entry) ? body.entry : [];

    // رد سريع — المعالجة تتم asynchronously مثل مسار واتساب
    res.sendStatus(200);

    for (const entry of entries) {
      for (const ev of Array.isArray(entry.messaging) ? entry.messaging : []) {
        try {
          await handleMetaMessagingEvent(ev);
        } catch (e) {
          console.error("[channels] messaging event failed:", e);
        }
      }
    }
  } catch (err) {
    console.error("[channels] webhook error:", err);
    if (!res.headersSent) res.sendStatus(500);
  }
});

function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

async function handleMetaMessagingEvent(ev: any) {
  const item = ev?.message;
  if (!item || item.is_echo) return; // تجاهل صدى ردودنا
  const text = extractText(item);
  if (!text) return;

  const senderId: string = String(ev.sender?.id ?? "");
  const recipientId: string = String(ev.recipient?.id ?? "");
  if (!senderId || !recipientId) return;

  // منع تكرار الـ webhook عبر المعرّف الخارجي للرسالة
  const externalMessageId: string | null =
    typeof item.mid === "string" ? item.mid : null;
  if (externalMessageId) {
    const { data: dup } = await db
      .from("messages")
      .select("id")
      .eq("external_message_id", externalMessageId)
      .limit(1);
    if (dup && dup.length > 0) return;
  }

  // تحديد الحساب المضيف (صفحة فيسبوك أو حساب إنستغرام احترافي)
  const { data: account } = await db
    .from("channel_accounts")
    .select("id, tenant_id, channel, external_id, status, agent_enabled, auto_reply")
    .eq("external_id", recipientId)
    .in("channel", ["facebook", "instagram"])
    .maybeSingle();

  if (!account) {
    console.warn("[channels] webhook for unknown page id:", recipientId);
    return;
  }
  if (account.status !== "active") return;

  const channel = account.channel as "facebook" | "instagram";
  const chatId = `${channel}:${senderId}`;

  const { data: tenant } = await db
    .from("tenants")
    .select("id, business_name, credits_remaining")
    .eq("id", account.tenant_id)
    .maybeSingle();
  if (!tenant) return;

  // إنشاء/تحديث المحادثة
  let conv = (
    await db
      .from("conversations")
      .select("*")
      .eq("tenant_id", tenant.id)
      .eq("wa_chat_id", chatId)
      .maybeSingle()
  ).data;

  // محاولة جلب اسم/صورة المرسل من Meta (اختياري — لا يوقف المعالجة عند الفشل)
  let senderName: string | null = null;
  let senderAvatar: string | null = null;
  try {
    const full: any = await fetchAccountWithToken(account.id);
    const token = decryptField(full?.access_token_encrypted);
    if (token) {
      const profileEndpoint =
        channel === "instagram"
          ? `https://graph.facebook.com/v21.0/${senderId}?fields=name,profile_picture&access_token=${token}`
          : `https://graph.facebook.com/v21.0/${senderId}?fields=name,picture&access_token=${token}`;
      const pres = await fetch(profileEndpoint);
      if (pres.ok) {
        const pj: any = await pres.json();
        senderName = pj?.name ?? null;
        senderAvatar = pj?.profile_picture ?? pj?.picture?.data?.url ?? null;
      }
    }
  } catch {
    /* تجاهل — الاسم اختياري */
  }

  if (!conv) {
    const { data } = await db
      .from("conversations")
      .insert({
        tenant_id: tenant.id,
        wa_chat_id: chatId,
        customer_phone_encrypted: encryptField(chatId),
        channel,
        account_id: account.id,
        customer_name: senderName,
        customer_avatar: senderAvatar,
        last_message_at: new Date().toISOString(),
      })
      .select("*")
      .single();
    conv = data;
  } else {
    const patch: any = {};
    if (conv.account_id !== account.id) patch.account_id = account.id;
    if (conv.channel !== channel) patch.channel = channel;
    if (senderName && !conv.customer_name) patch.customer_name = senderName;
    if (senderAvatar && !conv.customer_avatar) patch.customer_avatar = senderAvatar;
    if (Object.keys(patch).length > 0) {
      await db.from("conversations").update(patch).eq("id", conv.id);
    }
  }
  if (!conv) return;

  // حفظ الرسالة الواردة
  await db.from("messages").insert({
    conversation_id: conv.id,
    tenant_id: tenant.id,
    direction: "in",
    body_encrypted: encryptField(text),
    kind: "text",
    is_auto: false,
    external_message_id: externalMessageId,
  });

  await db
    .from("conversations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", conv.id);

  // تشغيل الوكيل الذكي إذا كان مفعلاً على الحساب والمحادثة ليست لبشري
  const shouldReply =
    account.agent_enabled &&
    account.auto_reply &&
    !conv.transferred &&
    Number(tenant.credits_remaining ?? 0) > 0;

  if (!shouldReply) return;

  try {
    const result = await answerFromKnowledge(tenant.id, tenant.business_name ?? "", text);
    const replyText =
      result.confident && result.answer?.trim()
        ? result.answer.trim()
        : "شكراً لتواصلك — سيعاود فريقنا الرد قريباً.";

    // إرسال الرد أولاً عبر Graph API الرسمي
    await sendMetaMessage(channel, account, senderId, replyText);

    await db.from("messages").insert({
      conversation_id: conv.id,
      tenant_id: tenant.id,
      direction: "out",
      body_encrypted: encryptField(replyText),
      kind: result.confident ? "answer" : "refusal",
      is_auto: true,
    });

    await db
      .from("conversations")
      .update({ last_message_at: new Date().toISOString() })
      .eq("id", conv.id);
  } catch (e) {
    console.error("[channels] AI reply failed:", e);
  }
}

/** إرسال رد عبر Graph API الرسمي — الرموز تبقى على الخادم فقط ولا تُكشف للواجهة */
async function sendMetaMessage(
  channel: "facebook" | "instagram",
  account: any,
  recipientId: string,
  text: string
) {
  const full: any = await fetchAccountWithToken(account.id);
  const token = decryptField(full?.access_token_encrypted);
  if (!token) throw new Error("رمز الوصول غير متوفر — أعد الربط");

  const endpoint =
    channel === "instagram"
      ? `https://graph.facebook.com/v21.0/${account.external_id}/messages`
      : "https://graph.facebook.com/v21.0/me/messages";

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text },
      access_token: token,
    }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
}

/** جلب صف الحساب كاملاً مع الرمز المشفر (service role فقط داخل الخادم) */
async function fetchAccountWithToken(accountId: string) {
  const { data } = await db
    .from("channel_accounts")
    .select("id, channel, external_id, access_token_encrypted, status")
    .eq("id", accountId)
    .maybeSingle();
  return data;
}
