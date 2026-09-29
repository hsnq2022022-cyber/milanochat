import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../db.js";
import { handleIncomingMessage } from "../rag/reply.js";
import { encryptField } from "../crypto.js";

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
    challenge: challenge ? "present" : "missing",
  });

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("[Instagram Webhook] ✓ Verified successfully");
    return res.status(200).send(challenge);
  }

  console.error("[Instagram Webhook] ✗ Verification failed", {
    expected: VERIFY_TOKEN ? "set" : "empty",
    received: token,
  });
  return res.status(403).send("Verify failed");
});

// ─── 2. استقبال الرسائل (POST) ───
instagramWebhookRouter.post("/instagram", async (req: Request, res: Response) => {
  // رد 200 فورًا لـ Meta (خلال 5 ثوانٍ)
  res.status(200).send("EVENT_RECEIVED");

  try {
    const body = req.body;
    console.log(
      "[Instagram Webhook] Received:",
      JSON.stringify(body).slice(0, 300)
    );

    if (!body || (body.object !== "instagram" && body.object !== "page")) {
      return;
    }

    for (const entry of body.entry || []) {
      const platformId = String(entry.id || "");

      console.log("[Instagram Webhook] Entry ID:", platformId);

      // ابحث عن القناة المرتبطة (channel_accounts)
      const { data: channel } = await db
        .from("channel_accounts")
        .select("tenant_id, channel")
        .eq("external_id", platformId)
        .maybeSingle();

      if (!channel) {
        console.warn(
          `[Instagram Webhook] No tenant bound for external_id: ${platformId}`
        );
        continue;
      }

      console.log(
        `[Instagram Webhook] Found tenant: ${channel.tenant_id}, platform: ${channel.channel}`
      );

      // معالجة messaging events
      const messaging = entry.messaging || [];

      for (const event of messaging) {
        // تجاهل رسائل الصدى (echo) الصادرة من التطبيق نفسه
        if (!event.message || event.message.is_echo) continue;

        const senderId = event.sender?.id;
        const text = event.message?.text;

        if (!senderId || !text) continue;

        console.log(
          `[Instagram Webhook] Message from ${senderId}: ${text.slice(0, 50)}`
        );

        // معرّف المحادثة يحمل بادئة القناة (منصة:معرّف العميل) — يمنع تصادم المعرفات بين القنوات
        const chatId = `${channel.channel}:${senderId}`;

        // ابحث عن محادثة موجودة
        const { data: existing } = await db
          .from("conversations")
          .select("id")
          .eq("tenant_id", channel.tenant_id)
          .eq("wa_chat_id", chatId)
          .maybeSingle();

        let convId = existing?.id;

        // أنشئ محادثة جديدة إن لم توجد
        if (!convId) {
          const { data: newConv, error: convErr } = await db
            .from("conversations")
            .insert({
              tenant_id: channel.tenant_id,
              wa_chat_id: chatId,
              channel: channel.channel,
              customer_phone_encrypted: encryptField(senderId),
              last_message_at: new Date().toISOString(),
            })
            .select("id")
            .single();

          if (convErr) {
            console.error("[Instagram Webhook] Create conv error:", convErr);
            continue;
          }

          convId = newConv?.id;
          console.log(`[Instagram Webhook] Created new conv: ${convId}`);
        }

        if (!convId) continue;

        // احفظ الرسالة (منع التكرار عبر mid)
        const msgId = event.message?.mid || `ig_${Date.now()}`;

        const { data: existingMsg } = await db
          .from("messages")
          .select("id")
          .eq("wa_message_id", msgId)
          .maybeSingle();

        if (existingMsg) {
          console.log(`[Instagram Webhook] Duplicate skipped: ${msgId}`);
          continue;
        }

        try {
          await db.from("messages").insert({
            conversation_id: convId,
            tenant_id: channel.tenant_id,
            direction: "in",
            body_encrypted: encryptField(text),
            kind: "customer",
            is_auto: false,
            wa_message_id: msgId,
            created_at: new Date().toISOString(),
          });
          console.log(`[Instagram Webhook] Message saved: ${msgId}`);
        } catch (e: any) {
          if (e?.code === "23505") continue;
          console.error("[Instagram Webhook] Insert msg error:", e);
          continue;
        }

        // شغّل الرد الآلي
        try {
          await handleIncomingMessage(
            channel.tenant_id,
            senderId,
            text,
            msgId
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
