/**
 * لوحة التحكم — كل المسارات تتطلب توكن Supabase Auth صالح.
 * تشمل: الملخص، المحادثات، الرد اليدوي، الأسئلة العالقة، مصادر المعرفة، ربط الحساب.
 */
import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { authClient, db } from "../db.js";
import { decryptField } from "../crypto.js";
import { addKnowledgeSnippet, ingestSource } from "../rag/ingest.js";
import { readConversationMessages, sendManualReply } from "../rag/reply.js";
import { waStatus, startSession } from "../wa/sessionManager.js";

export const dashboardRouter = Router();

type AuthedRequest = Request & { userId?: string };

/** التحقق من توكن الوصول عبر Supabase Auth */
async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "غير مصرح" });
  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ error: "جلسة غير صالحة" });
  (req as AuthedRequest).userId = data.user.id;
  next();
}

dashboardRouter.use(requireAuth);

/** تحميل عميل يملكه المستخدم الحالي */
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
  const { data } = await db.from("tenants").select("*").eq("user_id", userId).maybeSingle();
  return data;
}

/** ضم حساب أُنشئ في الصفحة الرئيسية إلى حساب لوحة التحكم (عبر claimToken) */
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
  if (error || !data) return res.status(404).json({ error: "رمز غير صالح أو مستخدم" });
  res.json({ tenantId: data.id });
});

/** ملخص: الرصيد، الاتصال، العدادات */
dashboardRouter.get("/summary", async (req, res) => {
  const tenant = await ownedTenant((req as AuthedRequest).userId!, req.query.tenantId as string);
  if (!tenant) return res.status(404).json({ error: "لا يوجد حساب مرتبط" });

  const [openQ, convCount, wa] = await Promise.all([
    db.from("unresolved_questions").select("id", { count: "exact", head: true }).eq("tenant_id", tenant.id).eq("status", "open"),
    db.from("conversations").select("id", { count: "exact", head: true }).eq("tenant_id", tenant.id),
    Promise.resolve(waStatus(tenant.id)),
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

/** قائمة المحادثات */
dashboardRouter.get("/conversations", async (req, res) => {
  const tenant = await ownedTenant((req as AuthedRequest).userId!, req.query.tenantId as string);
  if (!tenant) return res.status(404).json({ error: "لا يوجد حساب مرتبط" });
  const { data } = await db
    .from("conversations")
    .select("id, customer_phone_encrypted, transferred, auto_paused_reason, last_message_at")
    .eq("tenant_id", tenant.id)
    .order("last_message_at", { ascending: false })
    .limit(50);
  res.json(
    (data ?? []).map((c: any) => ({
      id: c.id,
      customerPhone: decryptField(c.customer_phone_encrypted),
      transferred: c.transferred,
      autoPausedReason: c.auto_paused_reason,
      lastMessageAt: c.last_message_at,
    }))
  );
});

/** رسائل محادثة (تُفك التشفير للعرض فقط) */
dashboardRouter.get("/conversations/:id/messages", async (req, res) => {
  const tenant = await ownedTenant((req as AuthedRequest).userId!, req.query.tenantId as string);
  if (!tenant) return res.status(404).json({ error: "لا يوجد حساب مرتبط" });
  const msgs = await readConversationMessages(tenant.id, req.params.id);
  res.json(msgs);
});

/** رد يدوي من المالك + خيار استئناف الرد الآلي */
dashboardRouter.post("/conversations/:id/reply", async (req, res) => {
  const tenant = await ownedTenant((req as AuthedRequest).userId!, req.body?.tenantId);
  if (!tenant) return res.status(404).json({ error: "لا يوجد حساب مرتبط" });
  const { text, resumeAuto } = req.body ?? {};
  if (!text?.trim()) return res.status(400).json({ error: "نص الرد فارغ" });
  try {
    await sendManualReply(tenant.id, req.params.id, text.trim(), Boolean(resumeAuto));
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ error: e?.message });
  }
});

/** الأسئلة العالقة المفتوحة */
dashboardRouter.get("/unresolved", async (req, res) => {
  const tenant = await ownedTenant((req as AuthedRequest).userId!, req.query.tenantId as string);
  if (!tenant) return res.status(404).json({ error: "لا يوجد حساب مرتبط" });
  const { data } = await db
    .from("unresolved_questions")
    .select("id, question_encrypted, status, manual_answer, added_to_kb, created_at, conversation_id")
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
    }))
  );
});

/**
 * حل سؤال عالق: حفظ الإجابة، وإضافتها لقاعدة المعرفة (فيتعلم الموظف)،
 * وإرسالها للعميل اختياريًا.
 */
dashboardRouter.post("/unresolved/:id/resolve", async (req, res) => {
  const tenant = await ownedTenant((req as AuthedRequest).userId!, req.body?.tenantId);
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
    .update({ status: "resolved", manual_answer: answer.trim(), added_to_kb: Boolean(saveToKb), resolved_at: new Date().toISOString() })
    .eq("id", q.id);

  if (sendToCustomer && (q as any).conversation_id) {
    try {
      await sendManualReply(tenant.id, (q as any).conversation_id, answer.trim(), false);
    } catch {
      /* الواتساب غير متصل — تُحفظ الإجابة على الأقل */
    }
  }
  res.json({ ok: true });
});

/** مصادر المعرفة: عرض / إضافة / حذف */
dashboardRouter.get("/knowledge", async (req, res) => {
  const tenant = await ownedTenant((req as AuthedRequest).userId!, req.query.tenantId as string);
  if (!tenant) return res.status(404).json({ error: "لا يوجد حساب مرتبط" });
  const { data } = await db
    .from("knowledge_sources")
    .select("id, kind, url, status, error, chunks_count, created_at")
    .eq("tenant_id", tenant.id)
    .order("created_at", { ascending: false });
  res.json(data ?? []);
});

dashboardRouter.post("/knowledge", async (req, res) => {
  const tenant = await ownedTenant((req as AuthedRequest).userId!, req.body?.tenantId);
  if (!tenant) return res.status(404).json({ error: "لا يوجد حساب مرتبط" });
  const { url, text } = req.body ?? {};
  const result = url?.trim()
    ? await ingestSource(tenant.id, { kind: "url", url: url.trim() })
    : await ingestSource(tenant.id, { kind: "text", text: String(text ?? "") });
  res.json(result);
});

dashboardRouter.delete("/knowledge/:sourceId", async (req, res) => {
  const tenant = await ownedTenant((req as AuthedRequest).userId!, req.body?.tenantId);
  if (!tenant) return res.status(404).json({ error: "لا يوجد حساب مرتبط" });
  await db.from("knowledge_sources").delete().eq("id", req.params.sourceId).eq("tenant_id", tenant.id);
  res.json({ ok: true });
});

/** إعادة وصل واتساب من اللوحة */
dashboardRouter.post("/wa/connect", async (req, res) => {
  const tenant = await ownedTenant((req as AuthedRequest).userId!, req.body?.tenantId);
  if (!tenant) return res.status(404).json({ error: "لا يوجد حساب مرتبط" });
  const status = await startSession(tenant.id);
  res.json({ status });
});
