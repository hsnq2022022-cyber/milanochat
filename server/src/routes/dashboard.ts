/**
 * لوحة التحكم — كل المسارات تتطلب توكن Supabase Auth صالح.
 * تشمل: الملخص، المحادثات، الرد اليدوي، الأسئلة العالقة، مصادر المعرفة، ربط الحساب.
 *
 * ملاحظات النسخة (v5):
 * - dashboardRouter فقط (channelsRouter انتقل إلى channels.ts).
 * - human_agent_expires_at في رد قائمة المحادثات.
 * - GET /conversations/:id لجلب محادثة واحدة.
 * - GET /conversations/summary لتحديث خفيف.
 * - POST /conversations/:id/mark-read.
 * - عرض customer_name في قائمة المحادثات.
 * - POST /claim لضم الحساب.
 */

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { authClient, db } from "../db.js";
import { decryptField } from "../crypto.js";
import { addKnowledgeSnippet, ingestSource } from "../rag/ingest.js";
import { readConversationMessages, sendManualReply } from "../rag/reply.js";
import { waStatus, ensureSession } from "../wa/sessionManager.js";

/* ═══════════════════════════════════════════════════════════
   Middleware المصادقة
   ═══════════════════════════════════════════════════════════ */

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

/* مساعد: تحميل tenant يملكه المستخدم */
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

/* ═══════════════════════════════════════════════════════════
   dashboardRouter — /api/dashboard/*
   ═══════════════════════════════════════════════════════════ */

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

/* ─── شكل موحَّد للمحادثة ─── */
function shapeConversation(c: any) {
  const lastMsg =
    Array.isArray(c.messages) && c.messages.length > 0 ? c.messages[0] : null;

  let lastMessageBody: string | null = null;
  if (lastMsg?.body_encrypted) {
    try {
      lastMessageBody = decryptField(lastMsg.body_encrypted);
    } catch {
      lastMessageBody = null;
    }
  }

  const now = new Date();
  const expiresAt = c.human_agent_expires_at
    ? new Date(c.human_agent_expires_at)
    : null;
  const humanAgentActive = Boolean(c.transferred && expiresAt && expiresAt > now);
  const remainingSeconds =
    humanAgentActive && expiresAt
      ? Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000))
      : 0;

  return {
    id: c.id,
    customerPhone: c.customer_phone_encrypted
      ? (() => {
          try {
            return decryptField(c.customer_phone_encrypted);
          } catch {
            return null;
          }
        })()
      : null,
    customerName: c.customer_name || null,
    customerAvatar: c.customer_avatar || null,
    channel: ["whatsapp", "instagram", "facebook"].includes(c.channel)
      ? c.channel
      : "whatsapp",
    accountId: c.account_id ?? null,
    transferred: c.transferred,
    autoPausedReason: c.auto_paused_reason,
    humanAgentExpiresAt: c.human_agent_expires_at ?? null,
    humanAgentActive,
    remainingSeconds,
    lastMessageAt: c.last_message_at,
    lastMessageBody,
  };
}

/* ─── /claim ─── */
dashboardRouter.post("/claim", async (req, res) => {
  const userId = (req as AuthedRequest).userId!;
  const { claimToken } = req.body ?? {};
  if (!claimToken) return res.status(400).json({ error: "رمز الضم ناقص" });

  const { data, error } = await db
    .from("tenants")
    .update({ user_id: userId })
    .eq("claim_token", claimToken)
    .is("user_id", null)
    .select("id")
    .maybeSingle();

  if (error || !data)
    return res.status(404).json({ error: "رمز غير صالح أو مستخدم" });
  res.json({ tenantId: data.id });
});

/* ─── /wa/bind ─── */
dashboardRouter.post("/wa/bind", async (req, res) => {
  const userId = (req as AuthedRequest).userId!;
  const tenant = await ownedTenant(userId, req.body?.tenantId);
  if (!tenant) return res.status(404).json({ error: "لا يوجد حساب مرتبط" });

  const { phoneNumberId } = req.body ?? {};
  if (!phoneNumberId) return res.status(400).json({ error: "phoneNumberId مطلوب" });

  await db.from("wa_bindings").delete().eq("phone_id", phoneNumberId);

  const { data, error } = await db
    .from("wa_bindings")
    .insert({ phone_id: phoneNumberId, tenant_id: tenant.id })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, phoneNumberId, tenantId: tenant.id });
});

/* ─── /wa/bindings ─── */
dashboardRouter.get("/wa/bindings", async (req, res) => {
  const userId = (req as AuthedRequest).userId!;
  const tenant = await ownedTenant(userId, req.query.tenantId as string);
  if (!tenant) return res.status(404).json({ error: "لا يوجد حساب مرتبط" });

  const { data, error } = await db
    .from("wa_bindings")
    .select("*")
    .eq("tenant_id", tenant.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

/* ─── /summary ─── */
dashboardRouter.get("/summary", async (req, res) => {
  const tenant = await ownedTenant(
    (req as AuthedRequest).userId!,
    req.query.tenantId as string
  );
  if (!tenant) return res.status(404).json({ error: "لا يوجد حساب مرتبط" });

  const [openQ, convCount, wa] = await Promise.all([
    db
      .from("unresolved_questions")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenant.id)
      .eq("status", "open"),
    db
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenant.id),
    waStatus(tenant.id),
  ]);

  res.json({
    tenant: {
      id: tenant.id,
      businessName: tenant.business_name,
      isActive: tenant.is_active,
      creditsRemaining: tenant.credits_remaining,
      phone: wa.phoneMasked,
    },
    wa: { status: wa.status },
    openUnresolved: openQ.count ?? 0,
    conversations: convCount.count ?? 0,
  });
});

/* ─── /agent-prompt (رسالة توجيه الوكيل) ─── */
dashboardRouter.get("/agent-prompt", async (req, res) => {
  const userId = (req as AuthedRequest).userId!;
  const tenant = await ownedTenant(userId, req.query.tenantId as string);
  if (!tenant) return res.status(404).json({ error: "لا يوجد حساب مرتبط" });

  res.json({ prompt: tenant.agent_system_prompt ?? null });
});

dashboardRouter.post("/agent-prompt", async (req, res) => {
  const userId = (req as AuthedRequest).userId!;
  const { prompt } = req.body ?? {};
  if (typeof prompt !== "string")
    return res.status(400).json({ error: "prompt يجب أن يكون نصًا" });
  if (prompt.length > 8000)
    return res.status(400).json({ error: "prompt يتجاوز الحد الأقصى (8000 حرف)" });

  const tenant = await ownedTenant(userId, req.body?.tenantId);
  if (!tenant) return res.status(404).json({ error: "لا يوجد حساب مرتبط" });

  const { error } = await db
    .from("tenants")
    .update({ agent_system_prompt: prompt })
    .eq("id", tenant.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

/* ─── /conversations/summary ─── */
dashboardRouter.get("/conversations/summary", async (req, res) => {
  const tenant = await ownedTenant(
    (req as AuthedRequest).userId!,
    req.query.tenantId as string
  );
  if (!tenant) return res.status(404).json({ error: "لا يوجد حساب مرتبط" });

  const { data, error } = await db
    .from("conversations")
    .select(`
      id,
      customer_name,
      customer_avatar,
      channel,
      account_id,
      transferred,
      auto_paused_reason,
      human_agent_expires_at,
      last_message_at,
      messages ( body_encrypted, direction, created_at )
    `)
    .eq("tenant_id", tenant.id)
    .order("last_message_at", { ascending: false })
    .order("created_at", { referencedTable: "messages", ascending: false })
    .limit(1, { referencedTable: "messages" })
    .limit(50);

  if (error) {
    console.error("[Dashboard] summary error:", error);
    return res.status(500).json({ error: error.message });
  }

  res.json(
    (data ?? []).map((c: any) => {
      const lastMsg =
        Array.isArray(c.messages) && c.messages.length > 0 ? c.messages[0] : null;
      let lastMessageBody: string | null = null;
      if (lastMsg?.body_encrypted) {
        try {
          lastMessageBody = decryptField(lastMsg.body_encrypted);
        } catch {
          lastMessageBody = null;
        }
      }
      return {
        id: c.id,
        customerName: c.customer_name || null,
        customerAvatar: c.customer_avatar || null,
        channel: ["whatsapp", "instagram", "facebook"].includes(c.channel)
          ? c.channel
          : "whatsapp",
        accountId: c.account_id ?? null,
        transferred: c.transferred,
        autoPausedReason: c.auto_paused_reason,
        humanAgentExpiresAt: c.human_agent_expires_at ?? null,
        lastMessageAt: c.last_message_at,
        lastMessageBody,
      };
    })
  );
});

/* ─── /conversations ─── */
dashboardRouter.get("/conversations", async (req, res) => {
  const tenant = await ownedTenant(
    (req as AuthedRequest).userId!,
    req.query.tenantId as string
  );
  if (!tenant) return res.status(404).json({ error: "لا يوجد حساب مرتبط" });

  const { data, error } = await db
    .from("conversations")
    .select(`
      id,
      channel,
      account_id,
      customer_phone_encrypted,
      customer_name,
      customer_avatar,
      transferred,
      auto_paused_reason,
      human_agent_expires_at,
      last_message_at,
      messages ( body_encrypted, direction, created_at )
    `)
    .eq("tenant_id", tenant.id)
    .order("last_message_at", { ascending: false })
    .order("created_at", { referencedTable: "messages", ascending: false })
    .limit(1, { referencedTable: "messages" })
    .limit(50);

  if (error) {
    console.error("[Dashboard] conversations error:", error);
    return res.status(500).json({ error: error.message });
  }

  res.json((data ?? []).map(shapeConversation));
});

/* ─── /conversations/:id ─── */
dashboardRouter.get("/conversations/:id", async (req, res) => {
  const tenant = await ownedTenant(
    (req as AuthedRequest).userId!,
    req.query.tenantId as string
  );
  if (!tenant) return res.status(404).json({ error: "لا يوجد حساب مرتبط" });

  const { data, error } = await db
    .from("conversations")
    .select(`
      id,
      channel,
      account_id,
      customer_phone_encrypted,
      customer_name,
      customer_avatar,
      transferred,
      auto_paused_reason,
      human_agent_expires_at,
      last_message_at,
      messages ( body_encrypted, direction, created_at )
    `)
    .eq("id", req.params.id)
    .eq("tenant_id", tenant.id)
    .order("created_at", { referencedTable: "messages", ascending: false })
    .limit(1, { referencedTable: "messages" })
    .maybeSingle();

  if (error) {
    console.error("[Dashboard] conversation error:", error);
    return res.status(500).json({ error: error.message });
  }
  if (!data) return res.status(404).json({ error: "المحادثة غير موجودة" });
  res.json(shapeConversation(data));
});

/* ─── /conversations/:id/messages ─── */
dashboardRouter.get("/conversations/:id/messages", async (req, res) => {
  const tenant = await ownedTenant(
    (req as AuthedRequest).userId!,
    req.query.tenantId as string
  );
  if (!tenant) return res.status(404).json({ error: "لا يوجد حساب مرتبط" });

  try {
    const msgs = await readConversationMessages(tenant.id, req.params.id);
    res.json(msgs);
  } catch (error: any) {
    console.error("[Dashboard] messages error:", error);
    res.status(500).json({ error: error?.message || "فشل تحميل الرسائل" });
  }
});

/* ─── /conversations/:id/mark-read ─── */
dashboardRouter.post("/conversations/:id/mark-read", async (req, res) => {
  const tenant = await ownedTenant(
    (req as AuthedRequest).userId!,
    req.body?.tenantId
  );
  if (!tenant) return res.status(404).json({ error: "لا يوجد حساب مرتبط" });

  const { error } = await db
    .from("conversations")
    .update({ unread_count: 0 })
    .eq("id", req.params.id)
    .eq("tenant_id", tenant.id);

  if (error) return res.json({ ok: true, note: "unread_count not persisted" });
  res.json({ ok: true });
});

/* ─── /conversations/:id/reply ─── */
dashboardRouter.post("/conversations/:id/reply", async (req, res) => {
  const tenant = await ownedTenant(
    (req as AuthedRequest).userId!,
    req.body?.tenantId
  );
  if (!tenant) return res.status(404).json({ error: "لا يوجد حساب مرتبط" });

  const { text, resumeAuto } = req.body ?? {};
  if (!text?.trim()) return res.status(400).json({ error: "نص الرد فارغ" });

  try {
    const message = await sendManualReply(
      tenant.id,
      req.params.id,
      text.trim(),
      Boolean(resumeAuto)
    );
    res.json({ ok: true, message });
  } catch (e: any) {
    console.error("[Dashboard] reply error:", e);
    res.status(400).json({ error: e?.message || "فشل إرسال الرد" });
  }
});

/* ─── /conversations/:id/takeover ─── */
dashboardRouter.post("/conversations/:id/takeover", async (req, res) => {
  const tenant = await ownedTenant(
    (req as AuthedRequest).userId!,
    req.body?.tenantId
  );
  if (!tenant) return res.status(404).json({ error: "لا يوجد حساب مرتبط" });

  const userId = (req as AuthedRequest).userId!;
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  const { error } = await db
    .from("conversations")
    .update({
      transferred: true,
      auto_paused_reason: "manual_takeover",
      human_agent_expires_at: expiresAt,
      human_agent_activated_by: userId,
    })
    .eq("id", req.params.id)
    .eq("tenant_id", tenant.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, expiresAt });
});

/* ─── /conversations/:id/release ─── */
dashboardRouter.post("/conversations/:id/release", async (req, res) => {
  const tenant = await ownedTenant(
    (req as AuthedRequest).userId!,
    req.body?.tenantId
  );
  if (!tenant) return res.status(404).json({ error: "لا يوجد حساب مرتبط" });

  const { error } = await db
    .from("conversations")
    .update({
      transferred: false,
      auto_paused_reason: null,
      human_agent_expires_at: null,
      human_agent_activated_by: null,
    })
    .eq("id", req.params.id)
    .eq("tenant_id", tenant.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

/* ─── /conversations/:id/human-status ─── */
dashboardRouter.get("/conversations/:id/human-status", async (req, res) => {
  const tenant = await ownedTenant(
    (req as AuthedRequest).userId!,
    req.query.tenantId as string
  );
  if (!tenant) return res.status(404).json({ error: "لا يوجد حساب مرتبط" });

  const { data, error } = await db
    .from("conversations")
    .select(
      "transferred, auto_paused_reason, human_agent_expires_at, human_agent_activated_by"
    )
    .eq("id", req.params.id)
    .eq("tenant_id", tenant.id)
    .single();

  if (error) return res.status(500).json({ error: error.message });

  const now = new Date();
  const expiresAt = data?.human_agent_expires_at
    ? new Date(data.human_agent_expires_at)
    : null;
  const isActive = Boolean(data?.transferred && expiresAt && expiresAt > now);
  const remainingSeconds =
    isActive && expiresAt
      ? Math.floor((expiresAt.getTime() - now.getTime()) / 1000)
      : 0;

  res.json({
    isActive,
    transferred: data?.transferred || false,
    expiresAt: data?.human_agent_expires_at,
    activatedBy: data?.human_agent_activated_by,
    remainingSeconds,
  });
});

/* ─── /unresolved ─── */
dashboardRouter.get("/unresolved", async (req, res) => {
  const tenant = await ownedTenant(
    (req as AuthedRequest).userId!,
    req.query.tenantId as string
  );
  if (!tenant) return res.status(404).json({ error: "لا يوجد حساب مرتبط" });

  const { data } = await db
    .from("unresolved_questions")
    .select(
      "id, question_encrypted, status, manual_answer, added_to_kb, created_at, conversation_id, best_similarity"
    )
    .eq("tenant_id", tenant.id)
    .order("created_at", { ascending: false })
    .limit(100);

  res.json(
    (data ?? []).map((q: any) => ({
      id: q.id,
      question: decryptField(q.question_encrypted),
      status: q.status,
      manualAnswer: q.manual_answer,
      addedToKb: q.added_to_kb,
      createdAt: q.created_at,
      conversationId: q.conversation_id,
      bestSimilarity: q.best_similarity ?? null,
    }))
  );
});

/* ─── /unresolved/:id/resolve ─── */
dashboardRouter.post("/unresolved/:id/resolve", async (req, res) => {
  const tenant = await ownedTenant(
    (req as AuthedRequest).userId!,
    req.body?.tenantId
  );
  if (!tenant) return res.status(404).json({ error: "لا يوجد حساب مرتبط" });

  const { answer, saveToKb, sendToCustomer } = req.body ?? {};
  if (!answer?.trim()) return res.status(400).json({ error: "الإجابة فارغة" });

  const { data: q } = await db
    .from("unresolved_questions")
    .select("*")
    .eq("id", req.params.id)
    .eq("tenant_id", tenant.id)
    .maybeSingle();

  if (!q) return res.status(404).json({ error: "السؤال غير موجود" });

  if (saveToKb) {
    const question = decryptField((q as any).question_encrypted);
    await addKnowledgeSnippet(tenant.id, `س: ${question}\nج: ${answer.trim()}`);
  }

  await db
    .from("unresolved_questions")
    .update({
      status: "resolved",
      manual_answer: answer.trim(),
      added_to_kb: Boolean(saveToKb),
      resolved_at: new Date().toISOString(),
    })
    .eq("id", q.id);

  if (sendToCustomer && (q as any).conversation_id) {
    try {
      await sendManualReply(
        tenant.id,
        (q as any).conversation_id,
        answer.trim(),
        false
      );
    } catch {
      /* الواتساب غير متصل — تُحفظ الإجابة على الأقل */
    }
  }

  res.json({ ok: true });
});

/* ─── /knowledge ─── */
dashboardRouter.get("/knowledge", async (req, res) => {
  const tenant = await ownedTenant(
    (req as AuthedRequest).userId!,
    req.query.tenantId as string
  );
  if (!tenant) return res.status(404).json({ error: "لا يوجد حساب مرتبط" });

  const { data } = await db
    .from("knowledge_sources")
    .select("id, kind, url, status, error, chunks_count, created_at")
    .eq("tenant_id", tenant.id)
    .order("created_at", { ascending: false });

  res.json(data ?? []);
});

dashboardRouter.post("/knowledge", async (req, res) => {
  const tenant = await ownedTenant(
    (req as AuthedRequest).userId!,
    req.body?.tenantId
  );
  if (!tenant) return res.status(404).json({ error: "لا يوجد حساب مرتبط" });

  const { url, text } = req.body ?? {};
  try {
    const result = url?.trim()
      ? await ingestSource(tenant.id, { kind: "url", url: url.trim() })
      : await ingestSource(tenant.id, {
          kind: "text",
          text: String(text ?? ""),
        });

    res.json(result);
  } catch (e: any) {
    console.error("[Dashboard] knowledge ingest failed:", e);
    res.status(500).json({ error: e?.message || "فشلت الفهرسة" });
  }
});

dashboardRouter.delete("/knowledge/:sourceId", async (req, res) => {
  const tenant = await ownedTenant(
    (req as AuthedRequest).userId!,
    req.body?.tenantId
  );
  if (!tenant) return res.status(404).json({ error: "لا يوجد حساب مرتبط" });

  await db
    .from("knowledge_sources")
    .delete()
    .eq("id", req.params.sourceId)
    .eq("tenant_id", tenant.id);

  res.json({ ok: true });
});

dashboardRouter.post("/wa/connect", async (req, res) => {
  const tenant = await ownedTenant(
    (req as AuthedRequest).userId!,
    req.body?.tenantId
  );
  if (!tenant) return res.status(404).json({ error: "لا يوجد حساب مرتبط" });

  const snap = await ensureSession(tenant.id);
  res.json({ status: snap.state });
});
