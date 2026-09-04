/**
 * محرك الرد الآلي:
 * رسالة واردة ← تحقق (نشاط/رصيد/تحويل) ← بحث دلالي في معرفة العميل فقط ←
 * توليد رد مُقيّد بالسياق ← سياسة منع الاختلاق ← إرسال ← خصم ذرّي
 */
import { db, type Conversation, type Tenant } from "../db.js";
import { chatCompletion, embed, toPgVector } from "../llm.js";
import { decryptField, encryptField } from "../crypto.js";
import { sendText } from "../wa/sessionManager.js";

const REFUSAL_TEXT =
  "عذرًا، ما عندي معلومات مؤكدة عن هذا الموضوع. لو تحتاج شيء ثاني أنا موجود، وأقدر أحوّلك لأحد الموظفين لو حبيت.";

const HANDOFF_TEXT = "وصلتني رسالتك، وحوّلت محادثتك لأحد الموظفين — بيرد عليك في أقرب وقت إن شاء الله.";

/** نية تحويل صريحة أو حالة حساسة → إيقاف الرد الآلي فورًا */
const HANDOFF_PATTERN =
  /(بشري|إنسان|موظف|مسؤول|مدير|شكوى|شكاوى|استرجاع|استرداد|تعويض|مشكلة كبيرة)/;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function systemPrompt(businessName: string): string {
  return [
    `أنت موظف خدمة عملاء ودود لمشروع «${businessName}» يرد على العملاء عبر واتساب.`,
    "قواعد صارمة لا استثناء فيها:",
    "1) تجيب فقط من المعلومات الواردة داخل <context>. أي معلومة غير موجودة فيه = غير مؤكدة.",
    "2) ممنوع التخمين أو الاختراع إطلاقًا: لا أسعار ولا مواعيد ولا عناوين ولا وعود غير موجودة نصًا في السياق.",
    "3) إن كان السؤال لا يمكن التأكد منه من السياق، أعد grounded=false ولا تكتب إجابة تخمينية.",
    "4) الرد قصير (جملتان بحد أقصى) وبلهجة سعودية مهذبة، بدون رموز تعبيرية كثيرة.",
    "أعد JSON فقط بهذا الشكل: {\"answer\":\"...\",\"grounded\":true|false}",
  ].join("\n");
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

  // حساب غير مفعل (لم يكتمل الدفع) → لا رد آلي
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

  // تسجيل رسالة العميل (مشفرة)
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
  if (conv.transferred) return; // محوّلة لبشري: لا تدخل آلي حتى يستأنف المالك
  if (conv.auto_paused_reason === "credits") return;
  if (t.credits_remaining <= 0) {
    await db.from("conversations").update({ auto_paused_reason: "credits" }).eq("id", conv.id);
    return;
  }

  // ── نية تحويل صريحة أو حالة حساسة ──
  const wantsHuman = HANDOFF_PATTERN.test(customerText);

  let kind: "answer" | "refusal" | "handoff" = "answer";
  let replyText = "";

  if (wantsHuman) {
    kind = "handoff";
    replyText = HANDOFF_TEXT;
  } else {
    // بحث دلالي داخل معرفة هذا العميل فقط
    const [qv] = await embed([customerText]);
    const { data: hits } = await db.rpc("match_knowledge", {
      p_tenant_id: tenantId,
      p_query: toPgVector(qv),
      p_limit: 6,
      p_threshold: 0.25,
    });
    const context = (hits ?? []).map((h: any, i: number) => `[${i + 1}] ${h.content}`).join("\n");

    const raw = await chatCompletion(
      systemPrompt(t.business_name),
      `<context>\n${context || "(لا توجد معلومات متوفرة عن هذا المشروع بعد)"}\n</context>\n\nسؤال العميل:\n${customerText}`,
      { json: true }
    );

    let parsed: { answer?: string; grounded?: boolean } = {};
    try {
      parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    } catch {
      parsed = {};
    }

    if (!parsed.grounded || !parsed.answer?.trim()) {
      kind = "refusal";
      replyText = REFUSAL_TEXT;
    } else {
      replyText = parsed.answer.trim();
    }
  }

  // لمس أنسنة الإيقاع قبل الإرسال
  await sleep(700 + Math.random() * 900);

  // ── الإرسال ثم الخصم (الخصم بعد التسليم الفعلي فقط) ──
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
    // دالة ذرّية: لا خصم مكرر، ولا نزول تحت الصفر
    await db.rpc("consume_reply", { p_tenant_id: tenantId, p_message_id: msgIns.data.id });
  }

  if (kind === "handoff") {
    await db.from("conversations").update({ transferred: true }).eq("id", conv.id);
  }

  if (kind === "refusal") {
    // تسجيل السؤال العالق بدل اختلاق إجابة
    await db.from("unresolved_questions").insert({
      tenant_id: tenantId,
      conversation_id: conv.id,
      question_encrypted: encryptField(customerText),
    });
  }
}

/** إرسال رد يدوي من لوحة التحكم (يعطَّل الخصم الآلي؛ قرار المالك) */
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

  await sendText(tenantId, (conv as Conversation).wa_chat_id, text);

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

/** قراءة رسائل محادثة (تُفك التشفير للعرض في اللوحة فقط) */
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
