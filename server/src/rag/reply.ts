/**
 * محرك الرد الآلي المتقدم:
 * - دعم اللهجات العربية
 * - ذاكرة المحادثة
 * - منع الهلوسة
 * - Hybrid RAG
 */
import { db, type Conversation, type Tenant } from "../db.js";
import { decryptField, encryptField } from "../crypto.js";
import { answerFromKnowledge } from "./qa.js";
import { sendText } from "../wa/sessionManager.js";

const REFUSAL_TEXT =
  "عذرًا، ما عندي معلومات مؤكدة عن هذا الموضوع. لو تحتاج شيء ثاني أنا موجود، وأقدر أحوّلك لأحد الموظفين لو حبيت.";

const HANDOFF_TEXT = "وصلتني رسالتك، وحوّلت محادثتك لأحد الموظفين — بيرد عليك في أقرب وقت إن شاء الله.";

/** نية تحويل صريحة أو حالة حساسة */
const HANDOFF_PATTERN =
  /(بشري|إنسان|موظف|مسؤول|مدير|شكوى|شكاوى|استرجاع|استرداد|تعويض|مشكلة كبيرة)/;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** جلب آخر N رسائل من المحادثة */
async function getConversationHistory(conversationId: string, limit = 5): Promise<string> {
  const { data: messages } = await db
    .from("messages")
    .select("direction, body_encrypted, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (!messages || messages.length === 0) return "";

  // عكس الترتيب ليكون من الأقدم للأحدث
  const reversed = messages.reverse();
  
  const history = reversed.map(m => {
    const body = decryptField(m.body_encrypted);
    const role = m.direction === "in" ? "العميل" : "المساعد";
    return `${role}: ${body}`;
  }).join("\n");

  return history;
}

export async function handleIncomingMessage(
  tenantId: string,
  chatId: string,
  customerText: string,
  waMessageId: string | null
): Promise<void> {
  const { data: tenant } = await db.from("tenants").select("*").eq("id", tenantId).single();
  if (!tenant) return;
  const t = tenant as Tenant;

  // حساب غير مفعل
  if (!t.is_active) return;

  // ── المحادثة ──
  let conv: Conversation | null = null;
  const phoneEnc = encryptField(chatId.replace(/@s.whatsapp.net$/, ""));
  const found = await db
    .from("conversations")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("wa_chat_id", chatId)
    .maybeSingle();
  
  if (found.data) {
    conv = found.data as Conversation;
    await db.from("conversations").update({ last_message_at: new Date().toISOString() }).eq("id", conv.id);
  } else {
    const ins = await db
      .from("conversations")
      .insert({ tenant_id: tenantId, wa_chat_id: chatId, customer_phone_encrypted: phoneEnc })
      .select()
      .single();
    conv = ins.data as Conversation;
  }
  if (!conv) return;

  // تسجيل رسالة العميل
  await db.from("messages").insert({
    conversation_id: conv.id,
    tenant_id: tenantId,
    direction: "in",
    body_encrypted: encryptField(customerText),
    kind: "customer",
    is_auto: false,
    wa_message_id: waMessageId,
  });

  // ── سياسات الإيقاف ──
  if (conv.transferred) return;
  if (conv.auto_paused_reason === "credits") return;
  if (t.credits_remaining <= 0) {
    await db.from("conversations").update({ auto_paused_reason: "credits" }).eq("id", conv.id);
    return;
  }

  // ── نية تحويل ──
  const wantsHuman = HANDOFF_PATTERN.test(customerText);

  let kind: "answer" | "refusal" | "handoff" = "answer";
  let replyText = "";
  let bestScore = 0;

  if (wantsHuman) {
    kind = "handoff";
    replyText = HANDOFF_TEXT;
  } else {
    // جلب تاريخ المحادثة للسياق
    const conversationHistory = await getConversationHistory(conv.id, 5);
    
    // RAG متقدم مع دعم اللهجات وذاكرة المحادثة
    const result = await answerFromKnowledge(
      tenantId, 
      t.business_name, 
      customerText,
      conversationHistory
    );
    
    bestScore = result.bestSimilarity;
    
    if (result.confident && result.answer) {
      replyText = result.answer;
    } else {
      kind = "refusal";
      replyText = REFUSAL_TEXT;
    }
  }

  // أنسنة الإيقاع
  await sleep(700 + Math.random() * 900);

  // ── الإرسال ثم الخصم ──
  await sendText(tenantId, chatId, replyText);

  const msgIns = await db
    .from("messages")
    .insert({
      conversation_id: conv.id,
      tenant_id: tenantId,
      direction: "out",
      body_encrypted: encryptField(replyText),
      kind,
      is_auto: true,
    })
    .select()
    .single();

  if (msgIns.data) {
    await db.rpc("consume_reply", { p_tenant_id: tenantId, p_message_id: msgIns.data.id });
  }

  if (kind === "handoff") {
    await db.from("conversations").update({ transferred: true }).eq("id", conv.id);
  }

  if (kind === "refusal") {
    await db.from("unresolved_questions").insert({
      tenant_id: tenantId,
      conversation_id: conv.id,
      best_similarity: bestScore,
      question_encrypted: encryptField(customerText),
    });
  }
}

/** إرسال رد يدوي */
export async function sendManualReply(
  tenantId: string,
  conversationId: string,
  text: string,
  resumeAuto: boolean
): Promise<void> {
  const { data: conv } = await db
    .from("conversations")
    .select("*")
    .eq("id", conversationId)
    .eq("tenant_id", tenantId)
    .single();

  if (!conv) throw new Error("المحادثة غير موجودة");

  await sendText(tenantId, conv.wa_chat_id, text);

  await db.from("messages").insert({
    conversation_id: conversationId,
    tenant_id: tenantId,
    direction: "out",
    body_encrypted: encryptField(text),
    kind: "manual",
    is_auto: false,
  });

  const patch: Record<string, unknown> = { last_message_at: new Date().toISOString() };
  if (resumeAuto) {
    patch.transferred = false;
    patch.auto_paused_reason = null;
  }
  await db.from("conversations").update(patch).eq("id", conversationId);
}

/** قراءة رسائل محادثة */
export async function readConversationMessages(tenantId: string, conversationId: string) {
  const { data } = await db
    .from("messages")
    .select("id,direction,body_encrypted,kind,is_auto,created_at")
    .eq("tenant_id", tenantId)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(200);
  return (data ?? []).map((m: any) => ({ ...m, body: decryptField(m.body_encrypted) }));
}
