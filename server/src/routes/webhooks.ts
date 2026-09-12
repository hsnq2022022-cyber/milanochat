/**
 * Meta WhatsApp Cloud API Webhook Handler
 * 
 * يستقبل الرسائل الواردة وتحديثات الحالة من Meta
 * 
 * GET  /api/webhooks/whatsapp - Webhook verification
 * POST /api/webhooks/whatsapp - Incoming messages & status updates
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
  const mode = req.query["hub.mode"] as string;
  const token = req.query["hub.verify_token"] as string;
  const challenge = req.query["hub.challenge"] as string;

  console.log("[Webhook] Verification request received:", { mode, token: token?.substring(0, 10) + "..." });

  const result = metaCloudAPI.handleWebhookVerification(mode, token, challenge);
  
  if (result) {
    console.log("[Webhook] Verification successful");
    res.status(200).send(result);
  } else {
    console.error("[Webhook] Verification failed");
    res.status(403).send("Verification failed");
  }
});

/**
 * POST /api/webhooks/whatsapp
 * Incoming messages & status updates من Meta
 */
whatsappWebhookRouter.post("/whatsapp", async (req: Request, res: Response) => {
  try {
    console.log("[Webhook] Received webhook payload");

    // معالجة الرسائل الواردة وتحديثات الحالة
    const { messages, statuses } = metaCloudAPI.parseIncomingWebhook(req.body);

    // معالجة الرسائل الواردة
    for (const message of messages) {
      try {
        console.log(`[Webhook] Processing message from ${message.chatId}: ${message.text.substring(0, 50)}...`);

        // البحث عن tenant بناءً على رقم الهاتف
        // في الإنتاج، يجب ربط أرقام الهواتف بـ tenants
        // حالياً نستخدم tenant الافتراضي
        const tenantId = await findTenantByPhoneNumber(message.chatId);
        
        if (!tenantId) {
          console.warn(`[Webhook] No tenant found for phone number ${message.chatId}`);
          continue;
        }

        // تحديث message tenantId
        message.tenantId = tenantId;

        // حفظ الرسالة في قاعدة البيانات
        await saveIncomingMessage(message);

        // معالجة الرسالة عبر AI Agent
        await handleIncomingMessage(
          tenantId,
          message.chatId,
          message.text,
          message.messageId
        );

        console.log(`[Webhook] Message processed successfully for tenant ${tenantId}`);
      } catch (error) {
        console.error("[Webhook] Error processing message:", error);
      }
    }

    // معالجة تحديثات الحالة
    for (const status of statuses) {
      try {
        console.log(`[Webhook] Processing status update for message ${status.messageId}: ${status.status}`);
        await updateMessageStatus(status.messageId, status.status);
      } catch (error) {
        console.error("[Webhook] Error processing status:", error);
      }
    }

    // Meta يتطلب الرد 200 OK فوراً
    res.status(200).send("EVENT_RECEIVED");
  } catch (error) {
    console.error("[Webhook] Error handling webhook:", error);
    res.status(500).send("Internal server error");
  }
});

/**
 * البحث عن tenant بناءً على رقم الهاتف
 * في الإنتاج، يجب إنشاء جدول لربط أرقام الهواتف بـ tenants
 */
async function findTenantByPhoneNumber(phoneNumber: string): Promise<string | null> {
  // حالياً نستخدم tenant الافتراضي
  // في الإنتاج، يجب البحث في جدول phone_numbers أو tenant_phones
  const { data } = await db
    .from("tenants")
    .select("id")
    .limit(1)
    .maybeSingle();

  return data?.id ?? null;
}

/**
 * حفظ الرسالة الواردة في قاعدة البيانات
 */
async function saveIncomingMessage(message: any): Promise<void> {
  // البحث عن conversation موجود
  const { data: existingConv } = await db
    .from("conversations")
    .select("id")
    .eq("tenant_id", message.tenantId)
    .eq("wa_chat_id", message.chatId)
    .maybeSingle();

  let conversationId = existingConv?.id;

  // إنشاء conversation جديد إذا لم يوجد
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

  // حفظ الرسالة
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
}

/**
 * تحديث حالة الرسالة
 */
async function updateMessageStatus(messageId: string, status: string): Promise<void> {
  // في الإنتاج، يجب تحديث حقل status في جدول messages
  // حالياً لا يوجد حقل status، يمكن إضافته لاحقاً
  console.log(`[Webhook] Message ${messageId} status: ${status}`);
}
