/**
 * مسارات القنوات والحسابات — Omnichannel
 * v3 — /meta/status عام (بدون auth)، باقي المسارات محمية.
 */
import { sendMetaDirectMessage, senderProfileUrl, parseSenderProfile } from "../metaSend.js";
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

type ChannelId = "whatsapp" | "instagram" | "facebook";
const VALID_CHANNELS = ["whatsapp", "instagram", "facebook"];

/* ═══════════════════════════════════════════════════
   Instagram Login المباشر — ثوابت
   ═══════════════════════════════════════════════════ */
const IG_AUTHORIZE = "https://www.instagram.com/oauth/authorize";
const IG_TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const IG_GRAPH_HOST = "https://graph.instagram.com";
const IG_GRAPH_V = `${IG_GRAPH_HOST}/v21.0`;

const IG_LOGIN_SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_messages",
];

function instagramDirectLoginEnabled(): boolean {
  return (
    process.env.USE_INSTAGRAM_DIRECT_LOGIN === "true" &&
    Boolean(process.env.INSTAGRAM_APP_ID) &&
    Boolean(process.env.INSTAGRAM_APP_SECRET)
  );
}

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

/* ═══════════════════════════════════════════════════
   مسارات عامة (بدون auth) — تُسجَّل قبل requireAuth
   ═══════════════════════════════════════════════════ */

/* GET /api/channels/meta/status — حالة Meta (عام) */
channelsRouter.get("/meta/status", async (req, res) => {
  const configured = Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET);

  let perChannel: { whatsapp: boolean; instagram: boolean; facebook: boolean } | null = null;

  const header = String(req.headers.authorization ?? "");
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (bearer) {
    try {
      const { data: userData } = await authClient.auth.getUser(bearer);
      const userId = userData?.user?.id;
      if (userId) {
        const tenant = await ownedTenant(userId, req.query.tenantId as string);
        if (tenant) {
          const { data } = await db.from("channels").select("*").eq("tenant_id", tenant.id);
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
      /* تجاهل — نُعيد configured فقط */
    }
  }

  res.json({
    configured,
    channels: perChannel,
    appReviewNote: "حالة مراجعة صلاحيات Meta تُتابَع يدويًا من لوحة Meta Developers.",
    developersUrl: "https://developers.facebook.com/apps",
  });
});

/* GET /api/channels/meta/webhook — التحقق من Webhook (عام) */
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

/* POST /api/channels/meta/webhook — استقبال رسائل (عام) */
function extractText(m: any): string {
  if (typeof m?.text === "string") return m.text;
  const atts = Array.isArray(m?.attachments) ? m.attachments : [];
  const parts = atts
    .map((a: any) => (typeof a?.title === "string" ? a.title : ""))
    .filter(Boolean);
  return parts.join(" ") || "[رسالة غير نصية]";
}

/**
 * استخراج موحّد لكل الرسائل من entry — يدعم البنيتين:
 *  1) entry.messaging[]   (Facebook Page / Messenger / Instagram via FB Login)
 *  2) entry.changes[]     (Instagram Login API)
 * يعيد [{ senderId, recipientId, text, mid }]
 */
function extractMessagesFromEntry(entry: any): Array<{
  senderId: string;
  recipientId: string;
  text: string;
  mid: string | null;
}> {
  const out: Array<{
    senderId: string;
    recipientId: string;
    text: string;
    mid: string | null;
  }> = [];

  // 1) entry.messaging[]
  if (Array.isArray(entry.messaging)) {
    for (const ev of entry.messaging) {
      if (!ev?.message || ev.message.is_echo) continue;
      const senderId = String(ev.sender?.id ?? "");
      const recipientId = String(ev.recipient?.id ?? "");
      const text = extractText(ev.message);
      const mid = typeof ev.message.mid === "string" ? ev.message.mid : null;
      if (senderId && text) out.push({ senderId, recipientId, text, mid });
    }
  }

  // 2) entry.changes[].value (Instagram Login)
  if (Array.isArray(entry.changes)) {
    for (const change of entry.changes) {
      if (change?.field !== "messages") continue;
      const value = change.value;
      if (!value) continue;

      if (Array.isArray(value.messaging)) {
        for (const ev of value.messaging) {
          if (!ev?.message || ev.message.is_echo) continue;
          const senderId = String(ev.sender?.id ?? "");
          const recipientId = String(ev.recipient?.id ?? "");
          const text = extractText(ev.message);
          const mid = typeof ev.message.mid === "string" ? ev.message.mid : null;
          if (senderId && text) out.push({ senderId, recipientId, text, mid });
        }
        continue;
      }

      if (value.message && !value.message.is_echo) {
        const senderId = String(value.sender?.id ?? "");
        const recipientId = String(value.recipient?.id ?? "");
        const text = extractText(value.message);
        const mid = typeof value.message.mid === "string" ? value.message.mid : null;
        if (senderId && text) out.push({ senderId, recipientId, text, mid });
      }
    }
  }

  return out;
}

channelsRouter.post("/meta/webhook", async (req: Request, res: Response) => {
  try {
    const secret = process.env.META_APP_SECRET;
    const sig = String(req.headers["x-hub-signature-256"] ?? "");
    const rawBody: Buffer | undefined = (req as any).rawBody;
    if (secret && rawBody) {
      const expected =
        "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
      if (!sig || !timingSafeEqualStr(sig, expected)) {
        return res.sendStatus(401);
      }
    }

    const body: any = req.body ?? {};
    const entries: any[] = Array.isArray(body.entry) ? body.entry : [];

    res.sendStatus(200);

    for (const entry of entries) {
      const entryId = String(entry.id ?? "");
      const messages = extractMessagesFromEntry(entry);
      for (const msg of messages) {
        try {
          await handleMetaMessagingEvent({
            senderId: msg.senderId,
            recipientId: msg.recipientId,
            text: msg.text,
            mid: msg.mid,
            entryId,
          });
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

/**
 * معالجة حدث رسالة وارد.
 * يقبل القيم المستخرجة مسبقًا بدل الاعتماد على شكل payload واحد.
 */
async function handleMetaMessagingEvent(opts: {
  senderId: string;
  recipientId: string;
  text: string;
  mid: string | null;
  entryId?: string;
}) {
  const { senderId, recipientId, text, mid, entryId } = opts;
  if (!senderId || !recipientId || !text) return;

  const externalMessageId = mid;

  if (externalMessageId) {
    const { data: dup } = await db
      .from("messages")
      .select("id")
      .eq("external_message_id", externalMessageId)
      .limit(1);
    if (dup && dup.length > 0) return;
  }

  // ابحث عن الحساب بـ entryId أولًا ثم recipientId
  const candidates = [entryId, recipientId].filter((x) => x && x !== "0");

  let account: any = null;
  for (const candidate of candidates) {
    const { data } = await db
      .from("channel_accounts")
      .select("*")
      .eq("external_id", candidate)
      .in("channel", ["instagram", "facebook"])
      .maybeSingle();
    if (data) {
      account = data;
      break;
    }
  }

  if (!account) {
    console.warn("[channels] webhook for unknown page id:", recipientId);
    return;
  }
  if ((account as any).status && (account as any).status !== "active") return;

  const channel = ((account as any).channel ?? "facebook") as "facebook" | "instagram";
  const chatId = `${channel}:${senderId}`;

  const { data: tenant } = await db
    .from("tenants")
    .select("id, business_name, credits_remaining")
    .eq("id", (account as any).tenant_id)
    .maybeSingle();
  if (!tenant) return;

  let conv = (
    await db
      .from("conversations")
      .select("*")
      .eq("tenant_id", tenant.id)
      .eq("wa_chat_id", chatId)
      .maybeSingle()
  ).data;

  // جلب بيانات المرسل (اسم + صورة) باستخدام parseSenderProfile
  let senderName: string | null = null;
  let senderAvatar: string | null = null;
  try {
    const full: any = await fetchAccountWithToken((account as any).id);
    const token = decryptField(full?.access_token_encrypted);
    if (token) {
      const profileEndpoint = senderProfileUrl(channel, senderId, token);
      const pres = await fetch(profileEndpoint);
      if (pres.ok) {
        const pj: any = await pres.json();
        const parsed = parseSenderProfile(pj);
        senderName = parsed.name;
        senderAvatar = parsed.avatar;
        console.log("[channels] Sender profile fetched:", {
          senderId,
          name: senderName,
          avatar: senderAvatar ? "present" : "missing",
        });
      } else {
        console.warn("[channels] Profile fetch HTTP:", pres.status, "for", senderId);
      }
    }
  } catch (e: any) {
    console.warn("[channels] Profile fetch error:", e?.message ?? String(e));
  }

  if (!conv) {
    const { data } = await db
      .from("conversations")
      .insert({
        tenant_id: tenant.id,
        wa_chat_id: chatId,
        customer_phone_encrypted: encryptField(chatId),
        channel,
        account_id: (account as any).id,
        customer_name: senderName,
        customer_avatar: senderAvatar,
        last_message_at: new Date().toISOString(),
      })
      .select("*")
      .single();
    conv = data;
  } else {
    const patch: any = {};
    if ((conv as any).account_id !== (account as any).id) patch.account_id = (account as any).id;
    if ((conv as any).channel !== channel) patch.channel = channel;
    // حدّث الاسم/الصورة إن توفّرا ولم يكونا محفوظين
    if (senderName && !(conv as any).customer_name) patch.customer_name = senderName;
    if (senderAvatar && !(conv as any).customer_avatar) patch.customer_avatar = senderAvatar;
    if (Object.keys(patch).length > 0) {
      await db.from("conversations").update(patch).eq("id", (conv as any).id);
      if (senderName || senderAvatar) {
        console.log("[channels] Sender profile saved to conversation:", chatId);
      }
    }
  }
  if (!conv) return;

  await db.from("messages").insert({
    conversation_id: (conv as any).id,
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
    .eq("id", (conv as any).id);

  const shouldReply =
    (account as any).agent_enabled !== false &&
    (account as any).auto_reply !== false &&
    !(conv as any).transferred &&
    Number(tenant.credits_remaining ?? 0) > 0;

  if (!shouldReply) return;

  try {
    const result = await answerFromKnowledge(tenant.id, tenant.business_name ?? "", text);
    const replyText =
      result.confident && result.answer?.trim()
        ? result.answer.trim()
        : "شكراً لتواصلك — سيعاود فريقنا الرد قريباً.";

    await sendMetaMessage(channel, account, senderId, replyText);

    await db.from("messages").insert({
      conversation_id: (conv as any).id,
      tenant_id: tenant.id,
      direction: "out",
      body_encrypted: encryptField(replyText),
      kind: result.confident ? "answer" : "refusal",
      is_auto: true,
    });

    await db
      .from("conversations")
      .update({ last_message_at: new Date().toISOString() })
      .eq("id", (conv as any).id);
  } catch (e) {
    console.error("[channels] AI reply failed:", e);
  }
}

async function sendMetaMessage(
  channel: "facebook" | "instagram",
  account: any,
  recipientId: string,
  text: string
) {
  const full: any = await fetchAccountWithToken(account.id);
  const token = decryptField(full?.access_token_encrypted);
  if (!token) throw new Error("رمز الوصول غير متوفر — أعد الربط");

  await sendMetaDirectMessage({
    channel,
    externalId: String(account.external_id),
    token,
    recipientId,
    text,
  });
}

async function fetchAccountWithToken(accountId: string) {
  const { data } = await db
    .from("channel_accounts")
    .select("id, channel, external_id, access_token_encrypted, status")
    .eq("id", accountId)
    .maybeSingle();
  return data;
}

/* ═══════════════════════════════════════════════════
   من هنا فصاعدًا — كل المسارات محمية بـ auth
   ═══════════════════════════════════════════════════ */

/* GET /api/channels/accounts */
channelsRouter.get("/accounts", requireAuth, async (req, res) => {
  const userId = (req as any).userId as string;
  const tenant = await ownedTenant(userId, req.query.tenantId as string);
  if (!tenant) return res.status(404).json({ error: "لا يوجد حساب مرتبط" });

  const { data, error } = await db
    .from("channel_accounts")
    .select("*")
    .eq("tenant_id", tenant.id)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[Channels] accounts select error:", error);
    return res.json([]);
  }

  res.json((data ?? []).map(normalizeAccount));
});

/* GET /api/channels/summary */
channelsRouter.get("/summary", requireAuth, async (req, res) => {
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

  res.json(summary);
});

/* PATCH /api/channels/accounts/:id */
channelsRouter.patch("/accounts/:id", requireAuth, async (req, res) => {
  const userId = (req as any).userId as string;
  const tenant = await ownedTenant(userId, req.query.tenantId as string);
  if (!tenant) return res.status(404).json({ error: "لا يوجد حساب مرتبط" });

  const allowed = [
    "agent_enabled", "auto_reply", "language", "handoff_rules",
    "agent_config", "display_name", "status",
  ];
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
    .eq("tenant_id", tenant.id)
    .select("*")
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "الحساب غير موجود" });
  res.json(normalizeAccount(data));
});

/* DELETE /api/channels/accounts/:id */
channelsRouter.delete("/accounts/:id", requireAuth, async (req, res) => {
  const userId = (req as any).userId as string;
  const tenant = await ownedTenant(userId, req.query.tenantId as string);
  if (!tenant) return res.status(404).json({ error: "لا يوجد حساب مرتبط" });

  const { error } = await db
    .from("channel_accounts")
    .update({
      status: "disconnected",
      access_token_encrypted: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", req.params.id)
    .eq("tenant_id", tenant.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

/* GET /api/channels/meta/oauth-url */
channelsRouter.get("/meta/oauth-url", requireAuth, async (req, res) => {
  const userId = (req as any).userId as string;
  const tenant = await ownedTenant(userId, req.query.tenantId as string);
  if (!tenant) return res.status(404).json({ error: "لا يوجد حساب مرتبط" });

  const channel = String(req.query.channel ?? "facebook") as ChannelId;
  if (!VALID_CHANNELS.includes(channel)) return res.status(400).json({ error: "قناة غير صالحة" });

  /* ═══════════════════════════════════════════
     Instagram Login المباشر (جديد)
     ═══════════════════════════════════════════ */
  if (channel === "instagram" && instagramDirectLoginEnabled()) {
    const igAppId = process.env.INSTAGRAM_APP_ID!;
    const igRedirectUri = process.env.INSTAGRAM_REDIRECT_URI;

    if (!igRedirectUri) {
      return res.status(503).json({
        error: "instagram_oauth_not_configured",
        message: "INSTAGRAM_REDIRECT_URI غير مُعرّف على الخادم.",
      });
    }

    const state = Buffer.from(
      JSON.stringify({ tenantId: tenant.id, userId, channel, ts: Date.now() })
    ).toString("base64url");

    const url =
      `${IG_AUTHORIZE}?force_reauth=true` +
      `&client_id=${encodeURIComponent(igAppId)}` +
      `&redirect_uri=${encodeURIComponent(igRedirectUri)}` +
      `&response_type=code` +
      `&scope=${encodeURIComponent(IG_LOGIN_SCOPES.join(","))}` +
      `&state=${encodeURIComponent(state)}`;

    return res.json({ url, scopes: IG_LOGIN_SCOPES, provider: "instagram" });
  }

  /* ═══════════════════════════════════════════
     Facebook Login (كما كان — بدون تغيير)
     ═══════════════════════════════════════════ */
  const appId = process.env.META_APP_ID;
  if (!appId) {
    return res.status(503).json({ error: "تطبيق Meta غير مُهيّأ على الخادم بعد." });
  }

  const scopes =
    channel === "instagram"
      ? ["instagram_basic", "instagram_manage_messages", "pages_read_engagement",
         "pages_show_list", "business_management", "pages_manage_metadata", "pages_messaging"]
      : ["pages_show_list", "pages_messaging", "pages_manage_metadata", "pages_read_engagement"];

  const redirect = `${buildServerBaseUrl()}/api/channels/meta/callback`;
  const state = Buffer.from(
    JSON.stringify({ tenantId: tenant.id, userId, channel, ts: Date.now() })
  ).toString("base64url");

  const url =
    `https://www.facebook.com/v21.0/dialog/oauth` +
    `?client_id=${encodeURIComponent(appId)}` +
    `&redirect_uri=${encodeURIComponent(redirect)}` +
    `&scope=${encodeURIComponent(scopes.join(","))}` +
    `&state=${encodeURIComponent(state)}` +
    `&response_type=code`;

  res.json({ url, scopes, provider: "facebook" });
});

/* ═══════════════════════════════════════════════════
   GET /api/channels/instagram/callback — عام (Instagram Login)
   ═══════════════════════════════════════════════════ */
channelsRouter.get("/instagram/callback", async (req, res) => {
  try {
    const { code, state, error: igError } = req.query as Record<string, string>;

    const frontBase = (process.env.FRONTEND_ORIGIN ?? "").replace(/\/+$/, "");
    const fail = (code: string) =>
      res.redirect(`${frontBase}/#/dashboard?error=${encodeURIComponent(code)}`);

    if (igError) return fail(igError === "access_denied" ? "user_cancelled" : igError);
    if (!code || !state) return fail("oauth_missing");

    let parsed: { tenantId: string; userId: string; channel: string };
    try {
      parsed = JSON.parse(Buffer.from(state, "base64url").toString());
    } catch {
      return fail("oauth_state");
    }
    if (parsed.channel !== "instagram") return fail("oauth_channel");

    const igAppId = process.env.INSTAGRAM_APP_ID;
    const igSecret = process.env.INSTAGRAM_APP_SECRET;
    const igRedirectUri = process.env.INSTAGRAM_REDIRECT_URI;

    if (!igAppId || !igSecret || !igRedirectUri) return fail("oauth_not_configured");

    /* 1) استبدال الكود بـ short-lived token */
    const tRes = await fetch(IG_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: igAppId,
        client_secret: igSecret,
        grant_type: "authorization_code",
        redirect_uri: igRedirectUri,
        code,
      }),
    });
    const tJson: any = await tRes.json().catch(() => ({}));
    const first = Array.isArray(tJson?.data) ? tJson.data[0] : tJson;
    const shortToken: string | undefined = first?.access_token;

    if (!tRes.ok || !shortToken) return fail("oauth_token_exchange");

    /* 2) استبداله بـ long-lived token */
    let token = shortToken;
    let expiresIn = 3600;
    try {
      const lRes = await fetch(
        `${IG_GRAPH_HOST}/access_token?grant_type=ig_exchange_token` +
          `&client_secret=${encodeURIComponent(igSecret)}` +
          `&access_token=${encodeURIComponent(shortToken)}`
      );
      const lJson: any = await lRes.json().catch(() => ({}));
      if (lRes.ok && lJson?.access_token) {
        token = lJson.access_token;
        expiresIn = Number(lJson.expires_in ?? 5184000);
      }
    } catch {
      /* نكمل بالتوكن القصير */
    }

    /* 3) جلب بيانات الملف الشخصي */
    const pRes = await fetch(
      `${IG_GRAPH_V}/me?fields=user_id,username,name,profile_picture_url,account_type` +
        `&access_token=${encodeURIComponent(token)}`
    );
    const prof: any = await pRes.json().catch(() => ({}));
    const igId = String(prof?.user_id ?? prof?.id ?? first?.user_id ?? "");
    if (!pRes.ok || !igId) return fail("no_eligible_instagram");

    if (
      prof?.account_type &&
      !["BUSINESS", "MEDIA_CREATOR"].includes(prof.account_type)
    ) {
      return fail("no_eligible_instagram");
    }

    const username = prof?.username ? `@${prof.username}` : prof?.name ?? null;
    const avatarUrl =
      typeof prof?.profile_picture_url === "string" && prof.profile_picture_url.length > 0
        ? prof.profile_picture_url
        : null;

    /* 4) حفظ الحساب */
    const { error: upErr } = await db.from("channel_accounts").upsert(
      {
        tenant_id: parsed.tenantId,
        channel: "instagram",
        external_id: igId,
        display_name: username,
        avatar_url: avatarUrl,
        status: "active",
        access_token_encrypted: encryptField(token),
        token_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id,channel,external_id" }
    );

    if (upErr) return fail("db_save_failed");

    /* 5) الاشتراك في Webhooks */
    try {
      await fetch(
        `${IG_GRAPH_V}/me/subscribed_apps` +
          `?subscribed_fields=messages,messaging_postbacks,messaging_seen` +
          `&access_token=${encodeURIComponent(token)}`,
        { method: "POST" }
      );
    } catch {
      /* تجاهل — لا نُفشل العملية بسبب Webhook */
    }

    const q = new URLSearchParams({
      tab: "channels",
      connected: "1",
      ig: "1",
      name: username ?? "",
    });
    return res.redirect(`${frontBase}/#/dashboard?${q.toString()}`);
  } catch (err) {
    console.error("[channels] instagram callback error:", err);
    const frontBase = (process.env.FRONTEND_ORIGIN ?? "").replace(/\/+$/, "");
    return res.redirect(`${frontBase}/#/dashboard?error=oauth_failed`);
  }
});

/* GET /api/channels/meta/callback — عام لأن Meta تعود إليه */
channelsRouter.get("/meta/callback", async (req, res) => {
  try {
    const { code, state } = req.query as Record<string, string>;
    if (!code || !state) return res.redirect("/#/dashboard?error=oauth_missing");

    let parsed: { tenantId: string; userId: string; channel: string };
    try {
      parsed = JSON.parse(Buffer.from(state, "base64url").toString());
    } catch {
      return res.redirect("/#/dashboard?error=oauth_state");
    }
    if (!VALID_CHANNELS.includes(parsed.channel)) return res.redirect("/#/dashboard?error=oauth_channel");

    const appSecret = process.env.META_APP_SECRET;
    const appId = process.env.META_APP_ID;
    if (!appSecret || !appId) return res.redirect("/#/dashboard?error=oauth_not_configured");

    const redirect = `${buildServerBaseUrl()}/api/channels/meta/callback`;

    const tokenRes = await fetch(
      `https://graph.facebook.com/v21.0/oauth/access_token?` +
        `client_id=${appId}&client_secret=${appSecret}` +
        `&redirect_uri=${encodeURIComponent(redirect)}&code=${encodeURIComponent(code)}`
    );
    const tokenJson: any = await tokenRes.json();
    if (!tokenJson.access_token) return res.redirect("/#/dashboard?error=oauth_token");

    let accessToken
