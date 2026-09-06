/**
 * Milano Auto Reply Engine
 *
 * WhatsApp message
 *      ↓
 * tenant validation
 *      ↓
 * conversation
 *      ↓
 * policies
 *      ↓
 * RAG
 *      ↓
 * grounded answer
 *      ↓
 * WhatsApp
 *      ↓
 * save message
 *      ↓
 * consume credit
 */

import {
  db,
  type Conversation,
  type Tenant,
} from "../db.js";

import {
  decryptField,
  encryptField,
} from "../crypto.js";

import { answerFromKnowledge } from "./qa.js";

import { sendText } from "../wa/sessionManager.js";

const REFUSAL_TEXT =
  "عذرًا، ما عندي معلومات مؤكدة عن هذا الموضوع. لو تحتاج شيء ثاني أنا موجود، وأقدر أحوّلك لأحد الموظفين لو حبيت.";

const HANDOFF_TEXT =
  "وصلتني رسالتك، وحوّلت محادثتك لأحد الموظفين — بيرد عليك في أقرب وقت إن شاء الله.";

const HANDOFF_PATTERN =
  /(بشري|إنسان|موظف|مسؤول|مدير|شكوى|شكاوى|استرجاع|استرداد|تعويض|مشكلة كبيرة)/;

const sleep = (ms: number) =>
  new Promise((resolve) =>
    setTimeout(resolve, ms)
  );

/**
 * معالجة رسالة واردة من واتساب.
 */
export async function handleIncomingMessage(
  tenantId: string,
  chatId: string,
  customerText: string,
  waMessageId: string | null
): Promise<void> {
  console.log(
    `[WA] incoming tenant=${tenantId} chat=${chatId} text="${customerText.slice(
      0,
      100
    )}"`
  );

  try {
    /**
     * 1. تحميل tenant.
     */
    const {
      data: tenant,
      error: tenantError,
    } = await db
      .from("tenants")
      .select("*")
      .eq("id", tenantId)
      .single();

    if (tenantError) {
      console.error(
        "[WA] tenant query failed:",
        tenantError.message
      );
      return;
    }

    if (!tenant) {
      console.error(
        `[WA] tenant not found: ${tenantId}`
      );
      return;
    }

    const t = tenant as Tenant;

    /**
     * 2. التحقق من نشاط الحساب.
     */
    if (!t.is_active) {
      console.log(
        `[WA] tenant inactive: ${tenantId}`
      );
      return;
    }

    /**
     * 3. البحث عن المحادثة.
     */
    let conv: Conversation | null =
      null;

    const phoneEnc = encryptField(
      chatId.replace(
        /@s\.whatsapp\.net$/,
        ""
      )
    );

    const {
      data: found,
      error: findError,
    } = await db
      .from("conversations")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("wa_chat_id", chatId)
      .maybeSingle();

    if (findError) {
      console.error(
        "[WA] conversation lookup failed:",
        findError.message
      );
      return;
    }

    if (found) {
      conv = found as Conversation;

      const {
        error: updateError,
      } = await db
        .from("conversations")
        .update({
          last_message_at:
            new Date().toISOString(),
        })
        .eq("id", conv.id);

      if (updateError) {
        console.error(
          "[WA] conversation timestamp update failed:",
          updateError.message
        );
      }
    } else {
      const {
        data: insertedConversation,
        error: insertError,
      } = await db
        .from("conversations")
        .insert({
          tenant_id: tenantId,
          wa_chat_id: chatId,
          customer_phone_encrypted:
            phoneEnc,
        })
        .select()
        .single();

      if (insertError) {
        console.error(
          "[WA] conversation creation failed:",
          insertError.message
        );
        return;
      }

      conv =
        insertedConversation as Conversation;
    }

    if (!conv) {
      console.error(
        "[WA] conversation is null"
      );
      return;
    }

    /**
     * 4. حفظ رسالة العميل.
     */
    const {
      error: incomingInsertError,
    } = await db
      .from("messages")
      .insert({
        conversation_id: conv.id,
        tenant_id: tenantId,
        direction: "in",
        body_encrypted:
          encryptField(customerText),
        kind: "customer",
        is_auto: false,
        wa_message_id: waMessageId,
      });

    if (incomingInsertError) {
      console.error(
        "[WA] failed to save incoming message:",
        incomingInsertError.message
      );
    }

    /**
     * 5. المحادثة محولة لبشري.
     */
    if (conv.transferred) {
      console.log(
        `[WA] conversation transferred: ${conv.id}`
      );
      return;
    }

    /**
     * 6. متوقفة بسبب الرصيد.
     */
    if (
      conv.auto_paused_reason ===
      "credits"
    ) {
      console.log(
        `[WA] conversation paused because of credits: ${conv.id}`
      );
      return;
    }

    /**
     * 7. لا يوجد رصيد.
     */
    if (t.credits_remaining <= 0) {
      console.log(
        `[WA] tenant has no credits: ${tenantId}`
      );

      await db
        .from("conversations")
        .update({
          auto_paused_reason: "credits",
        })
        .eq("id", conv.id);

      return;
    }

    /**
     * 8. نية التحويل لبشري.
     */
    const wantsHuman =
      HANDOFF_PATTERN.test(
        customerText
      );

    let kind:
      | "answer"
      | "refusal"
      | "handoff" =
      "answer";

    let replyText = "";

    let bestScore = 0;

    if (wantsHuman) {
      kind = "handoff";
      replyText = HANDOFF_TEXT;
    } else {
      /**
       * 9. RAG.
       *
       * مهم جدًا:
       * أي خطأ في Gemini أو match_knowledge
       * لن يؤدي إلى توقف handler بالكامل.
       */
      try {
        console.log(
          `[RAG] starting for tenant=${tenantId}`
        );

        const result =
          await answerFromKnowledge(
            tenantId,
            t.business_name,
            customerText
          );

        bestScore =
          result.bestSimilarity;

        console.log(
          `[RAG] result confident=${result.confident} best=${result.bestSimilarity} matches=${result.matches.length}`
        );

        if (
          result.confident &&
          result.answer
        ) {
          replyText =
            result.answer;
        } else {
          kind = "refusal";
          replyText = REFUSAL_TEXT;
        }
      } catch (error: any) {
        /**
         * لا تجعل خطأ RAG يمنع WhatsApp من إرسال رد.
         */
        console.error(
          "[RAG] FAILED:",
          error?.message ?? error
        );

        kind = "refusal";
        replyText = REFUSAL_TEXT;
      }
    }

    /**
     * حماية أخيرة.
     */
    if (!replyText.trim()) {
      console.error(
        "[WA] replyText is empty"
      );
      return;
    }

    /**
     * 10. تأخير بسيط قبل الإرسال.
     */
    await sleep(
      700 + Math.random() * 900
    );

    /**
     * 11. إرسال الرد الحقيقي إلى WhatsApp.
     */
    console.log(
      `[WA] sending reply kind=${kind} text="${replyText.slice(
        0,
        120
      )}"`
    );

    await sendText(
      tenantId,
      chatId,
      replyText
    );

    console.log(
      `[WA] reply sent tenant=${tenantId} chat=${chatId}`
    );

    /**
     * 12. تسجيل الرد.
     */
    const {
      data: msgIns,
      error: msgInsertError,
    } = await db
      .from("messages")
      .insert({
        conversation_id: conv.id,
        tenant_id: tenantId,
        direction: "out",
        body_encrypted:
          encryptField(replyText),
        kind,
        is_auto: true,
      })
      .select()
      .single();

    if (msgInsertError) {
      console.error(
        "[WA] failed to save outgoing message:",
        msgInsertError.message
      );
    }

    /**
     * 13. خصم credit بعد الإرسال.
     */
    if (msgIns) {
      const {
        error: creditError,
      } = await db.rpc(
        "consume_reply",
        {
          p_tenant_id: tenantId,
          p_message_id: msgIns.id,
        }
      );

      if (creditError) {
        console.error(
          "[WA] consume_reply failed:",
          creditError.message
        );
      }
    }

    /**
     * 14. تسجيل التحويل لبشري.
     */
    if (kind === "handoff") {
      await db
        .from("conversations")
        .update({
          transferred: true,
        })
        .eq("id", conv.id);
    }

    /**
     * 15. تسجيل السؤال غير المحلول.
     */
    if (kind === "refusal") {
      const {
        error: unresolvedError,
      } = await db
        .from("unresolved_questions")
        .insert({
          tenant_id: tenantId,
          conversation_id: conv.id,
          best_similarity: bestScore,
          question_encrypted:
            encryptField(customerText),
        });

      if (unresolvedError) {
        console.error(
          "[WA] unresolved question insert failed:",
          unresolvedError.message
        );
      }
    }

    console.log(
      `[WA] processing complete tenant=${tenantId}`
    );
  } catch (error: any) {
    /**
     * حارس أخير:
     * أي خطأ غير متوقع لن يسبب crash للـ process.
     */
    console.error(
      "[WA] handleIncomingMessage FAILED:",
      error?.stack ??
        error?.message ??
        error
    );
  }
}

/**
 * إرسال رد يدوي من لوحة التحكم.
 */
export async function sendManualReply(
  tenantId: string,
  conversationId: string,
  text: string,
  resumeAuto: boolean
): Promise<void> {
  const {
    data: conv,
    error,
  } = await db
    .from("conversations")
    .select("*")
    .eq("id", conversationId)
    .eq("tenant_id", tenantId)
    .single();

  if (error) {
    throw new Error(
      "فشل تحميل المحادثة: " +
        error.message
    );
  }

  if (!conv) {
    throw new Error(
      "المحادثة غير موجودة"
    );
  }

  await sendText(
    tenantId,
    (conv as Conversation)
      .wa_chat_id,
    text
  );

  await db
    .from("messages")
    .insert({
      conversation_id: conversationId,
      tenant_id: tenantId,
      direction: "out",
      body_encrypted: encryptField(text),
      kind: "manual",
      is_auto: false,
    });

  const patch: Record<
    string,
    unknown
  > = {
    last_message_at:
      new Date().toISOString(),
  };

  if (resumeAuto) {
    patch.transferred = false;
    patch.auto_paused_reason = null;
  }

  await db
    .from("conversations")
    .update(patch)
    .eq("id", conversationId);
}

/**
 * قراءة رسائل المحادثة.
 */
export async function readConversationMessages(
  tenantId: string,
  conversationId: string
) {
  const {
    data,
    error,
  } = await db
    .from("messages")
    .select(
      "id,direction,body_encrypted,kind,is_auto,created_at"
    )
    .eq("tenant_id", tenantId)
    .eq(
      "conversation_id",
      conversationId
    )
    .order("created_at", {
      ascending: true,
    })
    .limit(200);

  if (error) {
    throw new Error(
      "فشل قراءة رسائل المحادثة: " +
        error.message
    );
  }

  return (data ?? []).map(
    (m: any) => ({
      ...m,
      body: decryptField(
        m.body_encrypted
      ),
    })
  );
}
