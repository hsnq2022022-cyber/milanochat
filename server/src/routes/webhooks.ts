/**
 * Meta WhatsApp Cloud API Webhook Handler
 * 
 * يستقبل الرسائل الواردة وتحديثات الحالة من Meta
 * 
 * GET  /api/webhooks/whatsapp - Webhook verification
 * POST /api/webhooks/whatsapp - Incoming messages & status updates
 * 
 * ملاحظات الإصلاح:
 * - الرد 200 يحدث فورًا قبل المعالجة (لمنع إعادة إرسال Meta).
 * - فحص wa_message_id قبل الحفظ (منع التكرار).
 * - معالجة خطأ 23505 كتكرار.
 */

import type { Request, Response } from "express";
import { Router } from "express";
import { db } from "../db.js";
import { metaCloudAPI } from "../wa/metaCloudAPI.js";
import { handleIncomingMessage } from "../rag/reply.js";
import { encryptField } from "../crypto.js";

export const whatsappWebhookRouter = Router();

/**
 * GET /api/webhooks/whatsapp
 * Webhook verification من Meta
 */
whatsappWebhookRouter.get("/whatsapp", async (req: Request, res: Response) => {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("[Webhook GET] verification request received");
  console.log("[Webhook GET] Query parameters:", JSON.stringify(req.query));

  const mode = req.query["hub.mode"] as string | undefined;
  const token = req.query["hub.verify_token"] as string | undefined;
  const challenge = req.query["hub.challenge"] as string | undefined;

  if (!mode || !token || !challenge) {
    console.error("[Webhook] Missing required query parameters");
    return res.status(400).send("Missing required parameters");
  }

  if (mode !== "subscribe") {
    console.error(`[Webhook] Invalid mode: ${mode}`);
    return res.status(400).send("Invalid mode");
  }

  const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN;
  if (!expectedToken) {
    console.error("[Webhook] WHATSAPP_VERIFY_TOKEN not configured");
    return res.status(500).send("Server configuration error");
  }

  const result = metaCloudAPI.handleWebhookVerification(mode, token, challenge);

  if (result) {
    console.log("[Webhook] Verification successful");
    res.status(200).send(result);
  } else {
    console.error("[Webhook] Verification failed - token mismatch");
    res.status(403).send("Verification failed");
  }
});

/**
 * POST /api/webhooks/whatsapp
 * Incoming messages & status updates من Meta
 * 
 * ⚠️ مهم: نرد 200 فورًا، ثم نعالج بشكل async.
 * هذا يمنع Meta من إعادة إرسال نفس الرسالة.
 */
whatsappWebhookRouter.post("/whatsapp", async (req: Request, res: Response) => {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("[Webhook POST] request received");
  console.log("[Webhook POST] Body.object:", req.body?.object || 'undefined');

  // ═══════════════════════════════════════════════════════════
  // 1) الرد 200 فورًا — قبل أي معالجة
  // ═══════════════════════════════════════════════════════════
  res.status(200).send("EVENT_RECEIVED");

  // ═══════════════════════════════════════════════════════════
  // 2) المعالجة الفعلية — بشكل async في الخلفية
  // ═══════════════════════════════════════════════════════════
  try {
    const { messages, statuses, phoneNumberId } =
      metaCloudAPI.parseIncomingWebhook(req.body);

    if (!phoneNumberId) {
      console.error("[Webhook] Missing phone_number_id");
      return;
    }

    console.log(`[Webhook] Phone Number ID: ${phoneNumberId}`);

    const tenantId = await findTenantByPhoneNumberId(phoneNumberId);

    if (!tenantId) {
      console.error(`[Webhook] No tenant for phone_number_id: ${phoneNumberId}`);
      return;
    }

    console.log(`[Webhook] Found tenant: ${tenantId}`);

    // معالجة الرسائل الواردة
    for (const message of messages) {
      try {
        console.log(`[Webhook] Processing message ${message.messageId}`);

        message.tenantId = tenantId;

        // حفظ الرسالة (مع فحص التكرار)
        const saved = await saveIncomingMessage(message);
        if (!saved) {
          console.log(`[Webhook] Skipped duplicate ${message.messageId}`);
          continue;
        }

        // معالجة الرسالة عبر AI Agent (فقط إن لم تكن مكررة)
        await handleIncomingMessage(
          tenantId,
          message.chatId,
          message.text,
          message.messageId
        );

        console.log(`[Webhook] Message processed: ${message.messageId}`);
      } catch (error) {
        console.error("[Webhook] Error processing message:", error);
      }
    }

    // معالجة تحديثات الحالة
    for (const status of statuses) {
      try {
        await updateMessageStatus(status.messageId, status.status);
      } catch (error) {
        console.error("[Webhook] Error processing status:", error);
      }
    }
  } catch (error) {
    console.error("[Webhook] Error handling webhook:", error);
  }
});

/**
 * البحث عن tenant باستخدام phone_number_id
 */
async function findTenantByPhoneNumberId(phoneNumberId: string): Promise<string | null> {
  const { data, error } = await db
    .from("wa_bindings")
    .select("tenant_id")
    .eq("phone_id", phoneNumberId)
    .maybeSingle();

  if (error) {
    console.error("[Webhook] Error searching wa_bindings:", error);
    return null;
  }

  return data?.tenant_id ?? null;
}

/**
 * حفظ الرسالة الواردة في قاعدة البيانات.
 * 
 * ✅ يتحقق من wa_message_id قبل الحفظ لمنع التكرار.
 * ✅ إذا وُجدت مسبقًا، يُعيد false (تجاهل).
 * ✅ إذا فشل الحفظ بخطأ 23505 (unique violation)، يُعيد false.
 */
async function saveIncomingMessage(message: any): Promise<boolean> {
  // ── 1) فحص التكرار ──
  if (message.messageId) {
    const { data: existing } = await db
      .from("messages")
      .select("id")
      .eq("wa_message_id", message.messageId)
      .maybeSingle();

    if (existing) {
      console.log(`[Webhook] Duplicate detected: ${message.messageId}`);
      return false;
    }
  }

  // ── 2) البحث عن conversation موجود ──
  const { data: existingConv } = await db
    .from("conversations")
    .select("id")
    .eq("tenant_id", message.tenantId)
    .eq("wa_chat_id", message.chatId)
    .maybeSingle();

  let conversationId = existingConv?.id;

  // ── 3) إنشاء conversation جديد إن لم يوجد ──
  if (!conversationId) {
    const { data: newConv } = await db
      .from("conversations")
      .insert({
        tenant_id: message.tenantId,
        wa_chat_id: message.chatId,
        customer_phone_encrypted: encryptField(message.chatId),
        last_message_at: new Date(message.timestamp).toISOString(),
      })
      .select("id")
      .single();

    conversationId = newConv?.id;
  }

  if (!conversationId) {
    throw new Error("Failed to create or find conversation");
  }

  // ── 4) حفظ الرسالة مع حماية try/catch ──
  try {
    await db.from("messages").insert({
      conversation_id: conversationId,
      tenant_id: message.tenantId,
      direction: "in",
      body_encrypted: encryptField(message.text),
      kind: "customer",
      is_auto: false,
      wa_message_id: message.messageId,
      created_at: new Date(message.timestamp).toISOString(),
    });
    return true;
  } catch (e: any) {
    // خطأ 23505 = unique violation = مكرر
    if (e?.code === "23505") {
      console.log(`[Webhook] Unique violation (duplicate): ${message.messageId}`);
      return false;
    }
    throw e;
  }
}

/**
 * تحديث حالة الرسالة
 */
async function updateMessageStatus(messageId: string, status: string): Promise<void> {
  console.log(`[Webhook] Message ${messageId} status: ${status}`);
}
