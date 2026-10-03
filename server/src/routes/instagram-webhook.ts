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
 */
import { Router } from "express";
import type { Request, Response } from "express";
import crypto from "node:crypto";
import { db } from "../db.js";
import { handleIncomingMessage } from "../rag/reply.js";

export const instagramWebhookRouter = Router();

/**
 * قبول أي من أسماء المتغيرات الموجودة فعليًا:
 * - META_WEBHOOK_VERIFY_TOKEN  (المستخدم في channels.ts — المسار الأساسي)
 * - INSTAGRAM_VERIFY_TOKEN     (اسم بديل متوافق معه)
 */
const VERIFY_TOKENS = Array.from(
  new Set(
    [process.env.META_WEBHOOK_VERIFY_TOKEN, process.env.INSTAGRAM_VERIFY_TOKEN].filter(
      (t): t is string => Boolean(t && t.length > 0)
    )
  )
);

// ─── 1. التحقق من Webhook (GET) ───
instagramWebhookRouter.get("/instagram", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("[Instagram Webhook] Verification request:", {
    mode,
    token: token ? "present" : "missing",
  });

  if (mode === "subscribe" && VERIFY_TOKENS.length > 0 && token && VERIFY_TOKENS.includes(String(token))) {
    console.log("[Instagram Webhook] ✓ Verified successfully");
    return res.status(200).send(challenge);
  }

  console.warn(
    "[Instagram Webhook] Verification failed",
    `| configuredTokens=${VERIFY_TOKENS.length}`,
    `| incomingToken=${token ? "present" : "missing"}`
  );
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

// ─── 2. استقبال الرسائل (POST) ───
instagramWebhookRouter.post("/instagram", async (req: Request, res: Response) => {
  console.log("[Instagram Webhook] POST received");
  // رد 200 فورًا لـ Meta
  res.status(200).send("EVENT_RECEIVED");

  try {
    const sigResult = verifySignature(req);
    console.log(
      `[Instagram Webhook] Signature verification: ${sigResult.ok ? "passed" : "failed"}`,
      `| tried=${sigResult.tried}`,
      `| rawBody=${sigResult.rawLen}b`
    );
    if (!sigResult.ok) {
      console.error("[Instagram Webhook] Invalid signature — ignored");
      return;
    }

    const body: any = req.body;
    console.log(
      "[Instagram Webhook] Received:",
      JSON.stringify(body).slice(0, 300)
    );

    if (!body || (body.object !== "instagram" && body.object !== "page")) {
      console.warn(
        "[Instagram Webhook] Unexpected object type — skipped",
        `| object=${body?.object ?? "missing"}`
      );
      return;
    }

    console.log(
      `[Instagram Webhook] object: ${body.object}`,
      `| entries: ${(body.entry || []).length}`
    );

    for (const entry of body.entry || []) {
      const entryId = String(entry.id || "");
      console.log(`[Instagram Webhook] entry received — id=${entryId}`);

      // استخرج كل الرسائل من entry — يدعم البنيتين
      const messages = extractMessagesFromEntry(entry);

      if (messages.length === 0) {
        console.log(`[Instagram Webhook] entry.id=${entryId} — no messages extracted`);
        continue;
      }

      for (const msg of messages) {
        console.log(
          `[Instagram Webhook] message event received`,
          `| sender=${msg.senderId}`,
          `| recipient=${msg.recipientId}`,
          `| mid=${msg.mid ?? "n/a"}`,
          `| textLen=${msg.text.length}`
        );

        // ابحث عن الحساب المضيف — نجرب entryId أولًا، ثم recipientId
        const candidates = [entryId, msg.recipientId].filter((x) => x && x !== "0");

        console.log("[Instagram Webhook] Looking for account", {
          candidateIds: candidates,
          channel: "instagram",
        });

        let account: any = null;
        for (const candidate of candidates) {
          const { data } = await db
            .from("channel_accounts")
            .select("tenant_id, channel, external_id, status, agent_enabled, auto_reply")
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
            `[Instagram Webhook] No matching Instagram channel account`,
            `| entryId=${entryId} recipientId=${msg.recipientId}`,
            `| external_id searched: ${candidates.join(", ")}`
          );
          continue;
        }
        console.log(
          "[Instagram Webhook] account found: true",
          `| tenant=${account.tenant_id} channel=${account.channel} status=${account.status}`
        );
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
      }
    }
  } catch (e: any) {
    console.error("[Instagram Webhook] Fatal error:", e);
  }
});
