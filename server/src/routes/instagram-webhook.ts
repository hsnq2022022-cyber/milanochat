/**
 * Instagram Messaging Webhook — مسار التحقق والاستقبال.
 *
 * يدعم بنيتين مختلفتين للـ payload:
 *
 * 1) Messenger-style (Instagram via Facebook Login):
 *    entry[].messaging[] = [{ sender, recipient, message }]
 *    entry[].id = Instagram Business Account ID (رقم طويل)
 *
 * 2) Instagram Login API (البنية الجديدة — 2024):
 *    entry[].changes[] = [{ field: "messages", value: {...} }]
 *    entry[].id = "0" (في اختبارات Meta) أو IG Account ID (في الإنتاج)
 *    entry[].changes[].value.recipient.id = IG Business Account ID
 *
 * الكود يستخرج الرسائل من كلا البنيتين، ويبحث عن الحساب بـ:
 *   - entry.id
 *   - أو changes[].value.recipient.id
 *
 * ملاحظة مهمة: نكتب الاسم والصورة في أعمدة `customer_name` و `customer_avatar`
 * لأن الـ API (Dashboard) يقرأ منهما لعرض اسم المرسل في الواجهة.
 */
import { Router } from "express";
import type { Request, Response } from "express";
import crypto from "node:crypto";
import { db } from "../db.js";
import { handleIncomingMessage } from "../rag/reply.js";
import { senderProfileUrl, parseSenderProfile } from "../metaSend.js";
import { decryptField } from "../crypto.js";

export const instagramWebhookRouter = Router();

const VERIFY_TOKEN = process.env.INSTAGRAM_VERIFY_TOKEN || "";

// ─── 1. التحقق من Webhook (GET) ───
instagramWebhookRouter.get("/instagram", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("[Instagram Webhook] Verification request:", {
    mode,
    token: token ? "present" : "missing",
  });

  if (mode === "subscribe" && VERIFY_TOKEN && token === VERIFY_TOKEN) {
    console.log("[Instagram Webhook] ✓ Verified successfully");
    return res.status(200).send(challenge);
  }

  return res.status(403).send("Verify failed");
});

/**
 * تحقق التوقيع مع تجربة كل الأسرار المتاحة.
 */
function verifySignature(req: Request): { ok: boolean; tried: number; rawLen: number } {
  const rawBody: Buffer | undefined = (req as any).rawBody;
  const sig = String(req.headers["x-hub-signature-256"] ?? "");

  const secrets = Array.from(
    new Set(
      [
        process.env.INSTAGRAM_APP_SECRET,
        process.env.META_APP_SECRET,
        process.env.FACEBOOK_APP_SECRET,
      ].filter((s): s is string => Boolean(s && s.length > 0))
    )
  );

  if (secrets.length === 0) {
    return { ok: true, tried: 0, rawLen: rawBody?.length ?? 0 };
  }

  if (!rawBody || !sig) {
    return { ok: false, tried: secrets.length, rawLen: rawBody?.length ?? 0 };
  }

  for (const secret of secrets) {
    const expected =
      "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return { ok: true, tried: secrets.length, rawLen: rawBody.length };
    }
  }

  return { ok: false, tried: secrets.length, rawLen: rawBody.length };
}

/**
 * استخراج كل الرسائل من entry — من كلا البنيتين.
 * يعيد [{ sender, text, mid, recipientId }]
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

  // 1) البنية القديمة: entry.messaging[]
  if (Array.isArray(entry.messaging)) {
    for (const ev of entry.messaging) {
      if (!ev?.message || ev.message.is_echo) continue;
      const senderId = String(ev.sender?.id ?? "");
      const recipientId = String(ev.recipient?.id ?? "");
      const text = typeof ev.message.text === "string" ? ev.message.text : "";
      const mid = typeof ev.message.mid === "string" ? ev.message.mid : null;
      if (senderId && text) {
        out.push({ senderId, recipientId, text, mid });
      }
    }
  }

  // 2) البنية الجديدة: entry.changes[].value (field = "messages")
  if (Array.isArray(entry.changes)) {
    for (const change of entry.changes) {
      if (change?.field !== "messages") continue;
      const value = change.value;
      if (!value) continue;

      // بعض الحالات: value.messaging[] موجود
      if (Array.isArray(value.messaging)) {
        for (const ev of value.messaging) {
          if (!ev?.message || ev.message.is_echo) continue;
          const senderId = String(ev.sender?.id ?? "");
          const recipientId = String(ev.recipient?.id ?? "");
          const text = typeof ev.message.text === "string" ? ev.message.text : "";
          const mid = typeof ev.message.mid === "string" ? ev.message.mid : null;
          if (senderId && text) {
            out.push({ senderId, recipientId, text, mid });
          }
        }
        continue;
      }

      // الحالة الشائعة: value نفسه يحتوي sender/recipient/message
      if (value.message && !value.message.is_echo) {
        const senderId = String(value.sender?.id ?? "");
        const recipientId = String(value.recipient?.id ?? "");
        const text = typeof value.message.text === "string" ? value.message.text : "";
        const mid = typeof value.message.mid === "string" ? value.message.mid : null;
        if (senderId && text) {
          out.push({ senderId, recipientId, text, mid });
        }
      }
    }
  }

  return out;
}

/**
 * جلب بيانات المرسل (الاسم + الصورة) من Graph API.
 * يفشل بهدوء: إن لم تنجح العملية تُعاد قيم null.
 */
async function fetchSenderProfile(opts: {
  channel: "instagram" | "facebook";
  senderId: string;
  token: string | null;
}): Promise<{ name: string | null; avatar: string | null }> {
  const { channel, senderId, token } = opts;

  if (!token || !senderId) {
    return { name: null, avatar: null };
  }

  try {
    const url = senderProfileUrl(channel, senderId, token);
    const res = await fetch(url);

    if (!res.ok) {
      console.warn(
        "[Instagram Webhook] Profile fetch HTTP:",
        res.status,
        "for sender",
        senderId
      );
      return { name: null, avatar: null };
    }

    const pj: any = await res.json();
    const parsed = parseSenderProfile(pj);

    console.log("[Instagram Webhook] Sender profile fetched:", {
      senderId,
      name: parsed.name,
      avatar: parsed.avatar ? "present" : "missing",
    });

    return parsed;
  } catch (e: any) {
    console.warn(
      "[Instagram Webhook] Profile fetch error:",
      e?.message ?? String(e)
    );
    return { name: null, avatar: null };
  }
}

// ─── 2. استقبال الرسائل (POST) ───
instagramWebhookRouter.post("/instagram", async (req: Request, res: Response) => {
  // رد 200 فورًا لـ Meta
  res.status(200).send("EVENT_RECEIVED");

  try {
    const sigResult = verifySignature(req);
    if (!sigResult.ok) {
      console.error(
        "[Instagram Webhook] Invalid signature — ignored",
        `| tried=${sigResult.tried}`,
        `| rawBody=${sigResult.rawLen}b`
      );
      return;
    }

    const body: any = req.body;
    console.log(
      "[Instagram Webhook] Received:",
      JSON.stringify(body).slice(0, 300)
    );

    if (!body || (body.object !== "instagram" && body.object !== "page")) {
      return;
    }

    for (const entry of body.entry || []) {
      const entryId = String(entry.id || "");

      // استخرج كل الرسائل من entry — يدعم البنيتين
      const messages = extractMessagesFromEntry(entry);

      if (messages.length === 0) {
        console.log(`[Instagram Webhook] entry.id=${entryId} — no messages extracted`);
        continue;
      }

      for (const msg of messages) {
        // ابحث عن الحساب المضيف — نجرب entryId أولًا، ثم recipientId
        const candidates = [entryId, msg.recipientId].filter((x) => x && x !== "0");

        let account: any = null;
        for (const candidate of candidates) {
          const { data } = await db
            .from("channel_accounts")
            .select(
              "tenant_id, channel, external_id, status, agent_enabled, auto_reply, access_token_encrypted"
            )
            .eq("external_id", candidate)
            .in("channel", ["instagram", "facebook"])
            .maybeSingle();
          if (data) {
            account = data;
            break;
          }
        }

        if (!account) {
          console.warn(
            `[Instagram Webhook] No tenant bound for entryId=${entryId} recipientId=${msg.recipientId}`
          );
          continue;
        }
        if (account.status !== "active") continue;

        const channel = account.channel === "facebook" ? "facebook" : "instagram";
        const chatId = `${channel}:${msg.senderId}`;
        const msgId = msg.mid || `ig_${Date.now()}`;

        // منع التكرار
        if (msg.mid) {
          const { data: dup } = await db
            .from("messages")
            .select("id")
            .eq("wa_message_id", msgId)
            .limit(1);
          if (dup && dup.length > 0) {
            console.log(`[Instagram Webhook] Duplicate skipped: ${msgId}`);
            continue;
          }
        }

        console.log(
          `[Instagram Webhook] Processing: sender=${msg.senderId} channel=${channel} tenant=${account.tenant_id}`
        );

        // ─── جلب بيانات المرسل (الاسم + الصورة) ───
        let token: string | null = null;
        try {
          if (account.access_token_encrypted) {
            token = decryptField(account.access_token_encrypted) ?? null;
          }
        } catch (e: any) {
          console.warn(
            "[Instagram Webhook] Token decrypt failed:",
            e?.message ?? String(e)
          );
        }

        const profile = await fetchSenderProfile({
          channel: channel as "instagram" | "facebook",
          senderId: msg.senderId,
          token,
        });

        // ─── توليد الرد وإرساله ───
        try {
          await handleIncomingMessage(
            account.tenant_id,
            chatId,
            msg.text,
            msgId,
            { channel: channel as "instagram" | "facebook" }
          );
        } catch (e) {
          console.error("[Instagram Webhook] AI reply error:", e);
        }

        // ─── حفظ الاسم والصورة في المحادثة (إن توفّرا) ───
        // مهم: نكتب في customer_name و customer_avatar لأن الـ API يقرأ منهما
        if (profile.name || profile.avatar) {
          try {
            const patch: Record<string, string | null> = {};
            if (profile.name) patch.customer_name = profile.name;
            if (profile.avatar) patch.customer_avatar = profile.avatar;

            const { error: updErr } = await db
              .from("conversations")
              .update(patch)
              .eq("tenant_id", account.tenant_id)
              .eq("wa_chat_id", chatId);

            if (updErr) {
              console.warn(
                "[Instagram Webhook] Failed to update sender profile:",
                updErr.message
              );
            } else {
              console.log(
                "[Instagram Webhook] Sender profile saved to conversation:",
                chatId,
                patch
              );
            }
          } catch (e: any) {
            console.warn(
              "[Instagram Webhook] Sender profile update error:",
              e?.message ?? String(e)
            );
          }
        }
      }
    }
  } catch (e: any) {
    console.error("[Instagram Webhook] Fatal error:", e);
  }
});
