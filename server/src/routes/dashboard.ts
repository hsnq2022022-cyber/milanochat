/**
 * لوحة التحكم — كل المسارات تتطلب توكن Supabase Auth صالح.
 * تشمل: الملخص، المحادثات، الرد اليدوي، الأسئلة العالقة، مصادر المعرفة، ربط الحساب.
 *
 * ملاحظات النسخة:
 * - تمت إضافة human_agent_expires_at إلى رد قائمة المحادثات.
 * - تمت إضافة GET /conversations/:id لجلب محادثة واحدة.
 * - تمت إضافة GET /conversations/summary لتحديث خفيف بديل عن polling ثقيل.
 * - تمت إضافة POST /conversations/:id/mark-read.
 * - شكل رد /reply موحَّد ليُقرأ مباشرة في الواجهة عبر result.message.
 */

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { authClient, db } from "../db.js";
import { decryptField } from "../crypto.js";
import { addKnowledgeSnippet, ingestSource } from "../rag/ingest.js";
import { readConversationMessages, sendManualReply } from "../rag/reply.js";
import { waStatus, ensureSession } from "../wa/sessionManager.js";

export const dashboardRouter = Router();

type AuthedRequest = Request & {
  userId?: string;
};

/** التحقق من توكن الوصول عبر Supabase Auth */
async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ")
    ? header.slice(7)
    : null;

  if (!token) {
    return res.status(401).json({ error: "غير مصرح" });
  }

  const { data, error } = await authClient.auth.getUser(token);

  if (error || !data?.user) {
    return res.status(401).json({ error: "جلسة غير صالحة" });
  }

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

  const { data } = await db
    .from("tenants")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  return data;
}

/**
 * تُستخدم داخليًا: تنسيق صف محادثة واحد من قاعدة البيانات
 * إلى الشكل الموحَّد الذي تتوقعه الواجهة.
 */
function shapeConversation(c: any) {
  // آخر رسالة (إن وُجدت عبر join)
  const lastMsg =
    Array.isArray(c.messages) && c.messages.length > 0
      ? c.messages[0]
      : null;

  let lastMessageBody: string | null = null;

  if (lastMsg?.body_encrypted) {
    try {
      lastMessageBody = decryptField(lastMsg.body_encrypted);
    } catch {
      lastMessageBody = null;
    }
  }

  // حساب حالة Human Agent
  const now = new Date();
  const expiresAt = c.human_agent_expires_at
    ? new Date(c.human_agent_expires_at)
    : null;

  const humanAgentActive = Boolean(
    c.transferred && expiresAt && expiresAt > now
  );

  const remainingSeconds =
    humanAgentActive && expiresAt
      ? Math.max(
          0,
          Math.floor((expiresAt.getTime() - now.getTime()) / 1000)
        )
      : 0;

  return {
    id: c.id,
    customerPhone: decryptField(c.customer_phone_encrypted),
    transferred: c.transferred,
    autoPausedReason: c.auto_paused_reason,
    humanAgentExpiresAt: c.human_agent_expires_at ?? null,
    humanAgentActive,
    remainingSeconds,
    lastMessageAt: c.last_message_at,
    lastMessageBody,
  };
}

/** ضم حساب أُنشئ في الصفحة الرئيسية إلى حساب لوحة التحكم عبر claimToken */
dashboardRouter.post("/claim", async (req, res) => {
  const userId = (req as AuthedRequest).userId!;
  const { claimToken } = req.body ?? {};

  if (!claimToken) {
    return res.status(400).json({ error: "رمز الضم ناقص" });
  }

  const { data, error } = await db
    .from("tenants")
    .update({ user_id: userId })
    .eq("claim_token", claimToken)
    .is("user_id", null)
    .select("id")
    .maybeSingle();

  if (error || !data) {
    return res.status(404).json({ error: "رمز غير صالح أو مستخدم" });
  }

  res.json({ tenantId: data.id });
});

/** ربط WhatsApp Cloud API phone_number_id بالـ tenant */
dashboardRouter.post("/wa/bind", async (req, res) => {
  const userId = (req as AuthedRequest).userId!;
  const tenant = await ownedTenant(userId, req.body?.tenantId);

  if (!tenant) {
    return res.status(404).json({ error: "لا يوجد حساب مرتبط" });
  }

  const { phoneNumberId } = req.body ?? {};

  if (!phoneNumberId) {
    return res.status(400).json({ error: "phoneNumberId مطلوب" });
  }

  // حذف الربط القديم إن وجد
  await db
    .from("wa_bindings")
    .delete()
    .eq("phone_id", phoneNumberId);

  // إنشاء الربط الجديد
  const { data, error } = await db
    .from("wa_bindings")
    .insert({
      phone_id: phoneNumberId,
      tenant_id: tenant.id,
    })
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  console.log(
    `[Dashboard] Bound phone_number_id ${phoneNumberId} to tenant ${tenant.id}`
  );

  res.json({
    success: true,
    phoneNumberId,
    tenantId: tenant.id,
  });
});

/** الحصول على bindings الحالية للـ tenant */
dashboardRouter.get("/wa/bindings", async (req, res) => {
  const userId = (req as AuthedRequest).userId!;

  const tenant = await ownedTenant(
    userId,
    req.query.tenantId as string
  );

  if (!tenant) {
    return res.status(404).json({ error: "لا يوجد حساب مرتبط" });
  }

  const { data, error } = await db
    .from("wa_bindings")
    .select("*")
    .eq("tenant_id", tenant.id);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(data || []);
});

/** ملخص: الرصيد، الاتصال، العدادات */
dashboardRouter.get("/summary", async (req, res) => {
  const tenant = await ownedTenant(
    (req as AuthedRequest).userId!,
    req.query.tenantId as string
  );

  if (!tenant) {
    return res.status(404).json({ error: "لا يوجد حساب مرتبط" });
  }

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
    wa: {
      status: wa.status,
    },
    openUnresolved: openQ.count ?? 0,
    conversations: convCount.count ?? 0,
  });
});

/**
 * ملخص خفيف لتحديث الواجهة عند فشل Realtime.
 * يعيد فقط معرّفات المحادثات مع آخر وقت + آخر معاينة،
 * بدون جلب الرسائل الكاملة.
 */
dashboardRouter.get("/conversations/summary", async (req, res) => {
  const tenant = await ownedTenant(
    (req as AuthedRequest).userId!,
    req.query.tenantId as string
  );

  if (!tenant) {
    return res.status(404).json({ error: "لا يوجد حساب مرتبط" });
  }

  const { data, error } = await db
    .from("conversations")
    .select(`
      id,
      transferred,
      auto_paused_reason,
      human_agent_expires_at,
      last_message_at,
      messages (
        body_encrypted,
        direction,
        created_at
      )
    `)
    .eq("tenant_id", tenant.id)
    .order("last_message_at", { ascending: false })
    .order("created_at", {
      referencedTable: "messages",
      ascending: false,
    })
    .limit(1, { referencedTable: "messages" })
    .limit(50);

  if (error) {
    console.error("[Dashboard] Failed to load conversations summary:", error);
    return res.status(500).json({ error: error.message });
  }

  res.json(
    (data ?? []).map((c: any) => {
      const lastMsg =
        Array.isArray(c.messages) && c.messages.length > 0
          ? c.messages[0]
          : null;

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
        transferred: c.transferred,
        autoPausedReason: c.auto_paused_reason,
        humanAgentExpiresAt: c.human_agent_expires_at ?? null,
        lastMessageAt: c.last_message_at,
        lastMessageBody,
      };
    })
  );
});

/** قائمة المحادثات */
dashboardRouter.get("/conversations", async (req, res) => {
  const tenant = await ownedTenant(
    (req as AuthedRequest).userId!,
    req.query.tenantId as string
  );

  if (!tenant) {
    return res.status(404).json({ error: "لا يوجد حساب مرتبط" });
  }

  const { data, error } = await db
    .from("conversations")
    .select(`
      id,
      customer_phone_encrypted,
      transferred,
      auto_paused_reason,
      human_agent_expires_at,
      last_message_at,
      messages (
        body_encrypted,
        direction,
        created_at
      )
    `)
    .eq("tenant_id", tenant.id)
    .order("last_message_at", { ascending: false })
    .order("created_at", {
      referencedTable: "messages",
      ascending: false,
    })
    .limit(1, { referencedTable: "messages" })
    .limit(50);

  if (error) {
    console.error("[Dashboard] Failed to load conversations:", error);

    return res.status(500).json({
      error: error.message,
    });
  }

  res.json((data ?? []).map(shapeConversation));
});

/**
 * جلب محادثة واحدة بمعرّفها.
 * تُستخدم عند وصول إشعار Realtime لمحادثة جديدة
 * أو بعد الإرسال لإعادة تحميل محادثة معينة.
 */
dashboardRouter.get("/conversations/:id", async (req, res) => {
  const tenant = await ownedTenant(
    (req as AuthedRequest).userId!,
    req.query.tenantId as string
  );

  if (!tenant) {
    return res.status(404).json({ error: "لا يوجد حساب مرتبط" });
  }

  const { data, error } = await db
    .from("conversations")
    .select(`
      id,
      customer_phone_encrypted,
      transferred,
      auto_paused_reason,
      human_agent_expires_at,
      last_message_at,
      messages (
        body_encrypted,
        direction,
        created_at
      )
    `)
    .eq("id", req.params.id)
    .eq("tenant_id", tenant.id)
    .order("created_at", {
      referencedTable: "messages",
      ascending: false,
    })
    .limit(1, { referencedTable: "messages" })
    .maybeSingle();

  if (error) {
    console.error("[Dashboard] Failed to load conversation:", error);
    return res.status(500).json({ error: error.message });
  }

  if (!data) {
    return res.status(404).json({ error: "المحادثة غير موجودة" });
  }

  res.json(shapeConversation(data));
});

/** رسائل محادثة — تُفك التشفير للعرض فقط */
dashboardRouter.get(
  "/conversations/:id/messages",
  async (req, res) => {
    const tenant = await ownedTenant(
      (req as AuthedRequest).userId!,
      req.query.tenantId as string
    );

    if (!tenant) {
      return res.status(404).json({
        error: "لا يوجد حساب مرتبط",
      });
    }

    try {
      const msgs = await readConversationMessages(
        tenant.id,
        req.params.id
      );

      res.json(msgs);
    } catch (error: any) {
      console.error(
        "[Dashboard] Failed to load conversation messages:",
        error
      );

      res.status(500).json({
        error:
          error?.message ||
          "فشل تحميل رسائل المحادثة",
      });
    }
  }
);

/**
 * تصفير عدّاد غير المقروء لمحادثة معينة (اختياري).
 * لا يغيّر شيئًا في قاعدة البيانات إلا إذا كان لديك عمود unread_count.
 * إن لم يكن لديك العمود، يُعيد ok:true بدون أي أثر جانبي.
 */
dashboardRouter.post(
  "/conversations/:id/mark-read",
  async (req, res) => {
    const tenant = await ownedTenant(
      (req as AuthedRequest).userId!,
      req.body?.tenantId
    );

    if (!tenant) {
      return res.status(404).json({ error: "لا يوجد حساب مرتبط" });
    }

    // نحاول التحديث، وإذا لم يوجد العمود نتجاهل الخطأ بهدوء.
    const { error } = await db
      .from("conversations")
      .update({ unread_count: 0 })
      .eq("id", req.params.id)
      .eq("tenant_id", tenant.id);

    if (error) {
      // غالبًا العمود غير موجود — لا نُفشل الطلب.
      return res.json({ ok: true, note: "unread_count not persisted" });
    }

    res.json({ ok: true });
  }
);

/**
 * رد يدوي من المالك + خيار استئناف الرد الآلي.
 *
 * مهم:
 * sendManualReply يرجع الآن بيانات الرسالة التي تم حفظها،
 * لذلك نعيدها إلى Dashboard.tsx حتى تظهر الرسالة فورًا
 * دون الحاجة إلى Refresh أو إعادة فتح المحادثة.
 */
dashboardRouter.post(
  "/conversations/:id/reply",
  async (req, res) => {
    const tenant = await ownedTenant(
      (req as AuthedRequest).userId!,
      req.body?.tenantId
    );

    if (!tenant) {
      return res.status(404).json({
        error: "لا يوجد حساب مرتبط",
      });
    }

    const { text, resumeAuto } = req.body ?? {};

    if (!text?.trim()) {
      return res.status(400).json({
        error: "نص الرد فارغ",
      });
    }

    try {
      const message = await sendManualReply(
        tenant.id,
        req.params.id,
        text.trim(),
        Boolean(resumeAuto)
      );

      res.json({
        ok: true,
        message,
      });
    } catch (e: any) {
      console.error(
        "[Dashboard] Manual reply failed:",
        e
      );

      res.status(400).json({
        error:
          e?.message ||
          "فشل إرسال الرد",
      });
    }
  }
);

/** تفعيل Human Agent */
dashboardRouter.post(
  "/conversations/:id/takeover",
  async (req, res) => {
    const tenant = await ownedTenant(
      (req as AuthedRequest).userId!,
      req.body?.tenantId
    );

    if (!tenant) {
      return res.status(404).json({
        error: "لا يوجد حساب مرتبط",
      });
    }

    // تفعيل Human Agent لمدة 15 دقيقة
    const userId = (req as AuthedRequest).userId!;

    const expiresAt = new Date(
      Date.now() + 15 * 60 * 1000
    ).toISOString();

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

    if (error) {
      return res.status(500).json({
        error: error.message,
      });
    }

    res.json({
      ok: true,
      expiresAt,
    });
  }
);

/** إلغاء Human Agent يدويًا */
dashboardRouter.post(
  "/conversations/:id/release",
  async (req, res) => {
    const tenant = await ownedTenant(
      (req as AuthedRequest).userId!,
      req.body?.tenantId
    );

    if (!tenant) {
      return res.status(404).json({
        error: "لا يوجد حساب مرتبط",
      });
    }

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

    if (error) {
      return res.status(500).json({
        error: error.message,
      });
    }

    res.json({
      ok: true,
    });
  }
);

/** الحصول على حالة Human Agent للمحادثة */
dashboardRouter.get(
  "/conversations/:id/human-status",
  async (req, res) => {
    const tenant = await ownedTenant(
      (req as AuthedRequest).userId!,
      req.query.tenantId as string
    );

    if (!tenant) {
      return res.status(404).json({
        error: "لا يوجد حساب مرتبط",
      });
    }

    const { data, error } = await db
      .from("conversations")
      .select(
        "transferred, auto_paused_reason, human_agent_expires_at, human_agent_activated_by"
      )
      .eq("id", req.params.id)
      .eq("tenant_id", tenant.id)
      .single();

    if (error) {
      return res.status(500).json({
        error: error.message,
      });
    }

    const now = new Date();

    const expiresAt = data?.human_agent_expires_at
      ? new Date(data.human_agent_expires_at)
      : null;

    const isActive = Boolean(
      data?.transferred &&
      expiresAt &&
      expiresAt > now
    );

    const remainingSeconds =
      isActive && expiresAt
        ? Math.floor(
            (expiresAt.getTime() - now.getTime()) /
              1000
          )
        : 0;

    res.json({
      isActive,
      transferred: data?.transferred || false,
      expiresAt: data?.human_agent_expires_at,
      activatedBy: data?.human_agent_activated_by,
      remainingSeconds,
    });
  }
);

/** الأسئلة العالقة المفتوحة */
dashboardRouter.get(
  "/unresolved",
  async (req, res) => {
    const tenant = await ownedTenant(
      (req as AuthedRequest).userId!,
      req.query.tenantId as string
    );

    if (!tenant) {
      return res.status(404).json({
        error: "لا يوجد حساب مرتبط",
      });
    }

    const { data } = await db
      .from("unresolved_questions")
      .select(
        "id, question_encrypted, status, manual_answer, added_to_kb, created_at, conversation_id, best_similarity"
      )
      .eq("tenant_id", tenant.id)
      .order("created_at", {
        ascending: false,
      })
      .limit(100);

    res.json(
      (data ?? []).map((q: any) => ({
        id: q.id,
        question: decryptField(
          q.question_encrypted
        ),
        status: q.status,
        manualAnswer: q.manual_answer,
        addedToKb: q.added_to_kb,
        createdAt: q.created_at,
        conversationId: q.conversation_id,
        bestSimilarity:
          q.best_similarity ?? null,
      }))
    );
  }
);

/**
 * حل سؤال عالق:
 * حفظ الإجابة، وإضافتها لقاعدة المعرفة،
 * وإرسالها للعميل اختياريًا.
 */
dashboardRouter.post(
  "/unresolved/:id/resolve",
  async (req, res) => {
    const tenant = await ownedTenant(
      (req as AuthedRequest).userId!,
      req.body?.tenantId
    );

    if (!tenant) {
      return res.status(404).json({
        error: "لا يوجد حساب مرتبط",
      });
    }

    const {
      answer,
      saveToKb,
      sendToCustomer,
    } = req.body ?? {};

    if (!answer?.trim()) {
      return res.status(400).json({
        error: "الإجابة فارغة",
      });
    }

    const { data: q } = await db
      .from("unresolved_questions")
      .select("*")
      .eq("id", req.params.id)
      .eq("tenant_id", tenant.id)
      .maybeSingle();

    if (!q) {
      return res.status(404).json({
        error: "السؤال غير موجود",
      });
    }

    if (saveToKb) {
      const question = decryptField(
        (q as any).question_encrypted
      );

      await addKnowledgeSnippet(
        tenant.id,
        `س: ${question}\nج: ${answer.trim()}`
      );
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

    if (
      sendToCustomer &&
      (q as any).conversation_id
    ) {
      try {
        await sendManualReply(
          tenant.id,
          (q as any).conversation_id,
          answer.trim(),
          false
        );
      } catch {
        /*
         * الواتساب غير متصل —
         * تُحفظ الإجابة على الأقل.
         */
      }
    }

    res.json({
      ok: true,
    });
  }
);

/** مصادر المعرفة: عرض */
dashboardRouter.get(
  "/knowledge",
  async (req, res) => {
    const tenant = await ownedTenant(
      (req as AuthedRequest).userId!,
      req.query.tenantId as string
    );

    if (!tenant) {
      return res.status(404).json({
        error: "لا يوجد حساب مرتبط",
      });
    }

    const { data } = await db
      .from("knowledge_sources")
      .select(
        "id, kind, url, status, error, chunks_count, created_at"
      )
      .eq("tenant_id", tenant.id)
      .order("created_at", {
        ascending: false,
      });

    res.json(data ?? []);
  }
);

/** إضافة مصدر معرفة */
dashboardRouter.post(
  "/knowledge",
  async (req, res) => {
    const tenant = await ownedTenant(
      (req as AuthedRequest).userId!,
      req.body?.tenantId
    );

    if (!tenant) {
      return res.status(404).json({
        error: "لا يوجد حساب مرتبط",
      });
    }

    const { url, text } = req.body ?? {};

    const result = url?.trim()
      ? await ingestSource(tenant.id, {
          kind: "url",
          url: url.trim(),
        })
      : await ingestSource(tenant.id, {
          kind: "text",
          text: String(text ?? ""),
        });

    res.json(result);
  }
);

/** حذف مصدر معرفة */
dashboardRouter.delete(
  "/knowledge/:sourceId",
  async (req, res) => {
    const tenant = await ownedTenant(
      (req as AuthedRequest).userId!,
      req.body?.tenantId
    );

    if (!tenant) {
      return res.status(404).json({
        error: "لا يوجد حساب مرتبط",
      });
    }

    await db
      .from("knowledge_sources")
      .delete()
      .eq("id", req.params.sourceId)
      .eq("tenant_id", tenant.id);

    res.json({
      ok: true,
    });
  }
);

/**
 * إعادة وصل واتساب من اللوحة.
 * يُفضَّل استخدام /api/whatsapp/session مع SSE.
 */
dashboardRouter.post(
  "/wa/connect",
  async (req, res) => {
    const tenant = await ownedTenant(
      (req as AuthedRequest).userId!,
      req.body?.tenantId
    );

    if (!tenant) {
      return res.status(404).json({
        error: "لا يوجد حساب مرتبط",
      });
    }

    const snap = await ensureSession(tenant.id);

    res.json({
      status: snap.state,
    });
  }
);
