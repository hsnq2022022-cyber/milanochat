/**
 * مسارات Widgets — CRUD + تشغيل الـ widget (إرسال/استقبال رسائل)
 */
import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { authClient, db } from "../db.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { answerFromKnowledge } from "../rag/qa.js";
import { chatCompletion } from "../llm.js";

export const widgetsRouter = Router();

type AuthedRequest = Request & { userId?: string };

/** التحقق من توكن Supabase Auth */
async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "غير مصرح" });
  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ error: "جلسة غير صالحة" });
  (req as AuthedRequest).userId = data.user.id;
  next();
}

/** تحميل tenant يملكه المستخدم */
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

// ═══════════ مسارات لوحة التحكم (محمية بـ Auth) ═══════════

widgetsRouter.use("/dashboard", requireAuth);

/** قائمة widgets */
widgetsRouter.get("/dashboard", async (req, res) => {
  const userId = (req as AuthedRequest).userId!;
  let tenant = await ownedTenant(userId, req.query.tenantId as string);
  
  // إذا لم يكن لدى المستخدم tenant، أنشئ واحد تلقائياً
  if (!tenant) {
    const { data: newTenant, error } = await db
      .from("tenants")
      .insert({
        user_id: userId,
        business_name: "مشروعي",
        source_type: "manual",
        credits_remaining: 1000,
        is_active: true,
        activated_at: new Date().toISOString(),
      })
      .select()
      .single();
    
    if (error || !newTenant) {
      return res.status(500).json({ error: "تعذر إنشاء حساب" });
    }
    tenant = newTenant;
  }

  const { data, error } = await db
    .from("widgets")
    .select("*")
    .eq("tenant_id", tenant.id)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
});

/** إنشاء widget */
widgetsRouter.post("/dashboard", rateLimit({ windowMs: 60_000, max: 10 }), async (req, res) => {
  const userId = (req as AuthedRequest).userId!;
  let tenant = await ownedTenant(userId, req.body?.tenantId);
  
  // إذا لم يكن لدى المستخدم tenant، أنشئ واحد تلقائياً
  if (!tenant) {
    const { data: newTenant, error } = await db
      .from("tenants")
      .insert({
        user_id: userId,
        business_name: "مشروعي",
        source_type: "manual",
        credits_remaining: 1000,
        is_active: true,
        activated_at: new Date().toISOString(),
      })
      .select()
      .single();
    
    if (error || !newTenant) {
      return res.status(500).json({ error: "تعذر إنشاء حساب" });
    }
    tenant = newTenant;
  }

  const { name, settings } = req.body ?? {};
  if (!name?.trim()) return res.status(400).json({ error: "اسم الـ widget مطلوب" });

  const { data, error } = await db
    .from("widgets")
    .insert({
      tenant_id: tenant.id,
      name: name.trim(),
      welcome_message: settings?.welcomeMessage ?? "مرحباً! كيف يمكنني مساعدتك؟",
      primary_color: settings?.primaryColor ?? "#2ec27e",
      position: settings?.position ?? "left",
      language: settings?.language ?? "ar",
      rtl: settings?.rtl ?? true,
      avatar_url: settings?.avatarUrl ?? null,
      show_branding: settings?.showBranding ?? true,
      placeholder: settings?.placeholder ?? "اكتب رسالتك...",
      suggested_questions: settings?.suggestedQuestions ?? [],
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/** تحديث widget */
widgetsRouter.put("/dashboard/:id", async (req, res) => {
  const userId = (req as AuthedRequest).userId!;
  let tenant = await ownedTenant(userId, req.body?.tenantId);
  
  // إذا لم يكن لدى المستخدم tenant، أنشئ واحد تلقائياً
  if (!tenant) {
    const { data: newTenant, error } = await db
      .from("tenants")
      .insert({
        user_id: userId,
        business_name: "مشروعي",
        source_type: "manual",
        credits_remaining: 1000,
        is_active: true,
        activated_at: new Date().toISOString(),
      })
      .select()
      .single();
    
    if (error || !newTenant) {
      return res.status(500).json({ error: "تعذر إنشاء حساب" });
    }
    tenant = newTenant;
  }

  const { settings, name, enabled } = req.body ?? {};
  const patch: Record<string, any> = {};

  if (name !== undefined) patch.name = name.trim();
  if (enabled !== undefined) patch.enabled = enabled;
  if (settings) {
    if (settings.welcomeMessage !== undefined) patch.welcome_message = settings.welcomeMessage;
    if (settings.primaryColor !== undefined) patch.primary_color = settings.primaryColor;
    if (settings.position !== undefined) patch.position = settings.position;
    if (settings.language !== undefined) patch.language = settings.language;
    if (settings.rtl !== undefined) patch.rtl = settings.rtl;
    if (settings.avatarUrl !== undefined) patch.avatar_url = settings.avatarUrl;
    if (settings.showBranding !== undefined) patch.show_branding = settings.showBranding;
    if (settings.placeholder !== undefined) patch.placeholder = settings.placeholder;
    if (settings.suggestedQuestions !== undefined) patch.suggested_questions = settings.suggestedQuestions;
  }

  const { data, error } = await db
    .from("widgets")
    .update(patch)
    .eq("id", req.params.id)
    .eq("tenant_id", tenant.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/** حذف widget */
widgetsRouter.delete("/dashboard/:id", async (req, res) => {
  const userId = (req as AuthedRequest).userId!;
  let tenant = await ownedTenant(userId, req.body?.tenantId);
  
  // إذا لم يكن لدى المستخدم tenant، أنشئ واحد تلقائياً
  if (!tenant) {
    const { data: newTenant, error } = await db
      .from("tenants")
      .insert({
        user_id: userId,
        business_name: "مشروعي",
        source_type: "manual",
        credits_remaining: 1000,
        is_active: true,
        activated_at: new Date().toISOString(),
      })
      .select()
      .single();
    
    if (error || !newTenant) {
      return res.status(500).json({ error: "تعذر إنشاء حساب" });
    }
    tenant = newTenant;
  }

  const { error } = await db
    .from("widgets")
    .delete()
    .eq("id", req.params.id)
    .eq("tenant_id", tenant.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ═══════════ مسارات الـ Widget العام (بدون Auth) ═══════════

/** جلب إعدادات widget (عام — يُستدعى من widget.js) */
widgetsRouter.get("/public/:token", async (req, res) => {
  const { data: widget, error } = await db
    .from("widgets")
    .select("id, name, enabled, welcome_message, primary_color, position, language, rtl, avatar_url, show_branding, placeholder, suggested_questions, tenant_id")
    .eq("public_token", req.params.token)
    .maybeSingle();

  if (error || !widget) return res.status(404).json({ error: "Widget غير موجود" });
  if (!widget.enabled) return res.status(403).json({ error: "Widget معطّل" });

  // جلب اسم النشاط من tenant
  const { data: tenant } = await db
    .from("tenants")
    .select("business_name")
    .eq("id", widget.tenant_id)
    .single();

  res.json({
    widgetId: widget.id,
    name: widget.name,
    businessName: tenant?.business_name ?? "ميلانو",
    welcomeMessage: widget.welcome_message,
    primaryColor: widget.primary_color,
    position: widget.position,
    language: widget.language,
    rtl: widget.rtl,
    avatarUrl: widget.avatar_url,
    showBranding: widget.show_branding,
    placeholder: widget.placeholder,
    suggestedQuestions: widget.suggested_questions,
  });
});

/** إنشاء/استرجاع جلسة */
widgetsRouter.post("/public/:token/session", rateLimit({ windowMs: 60_000, max: 20 }), async (req, res) => {
  const { data: widget } = await db
    .from("widgets")
    .select("id, tenant_id, enabled")
    .eq("public_token", req.params.token)
    .maybeSingle();

  if (!widget || !widget.enabled) return res.status(404).json({ error: "Widget غير موجود أو معطّل" });

  const { visitorId } = req.body ?? {};
  if (!visitorId) return res.status(400).json({ error: "visitorId مطلوب" });

  // استرجاع جلسة موجودة أو إنشاء جديدة
  const { data: existing } = await db
    .from("widget_sessions")
    .select("*")
    .eq("widget_id", widget.id)
    .eq("visitor_id", visitorId)
    .maybeSingle();

  if (existing) {
    // تحميل الرسائل السابقة
    const { data: messages } = await db
      .from("widget_messages")
      .select("id, direction, body, kind, created_at")
      .eq("session_id", existing.id)
      .order("created_at", { ascending: true })
      .limit(50);

    return res.json({
      sessionId: existing.id,
      messages: messages ?? [],
    });
  }

  // إنشاء جلسة جديدة
  const { data: session, error } = await db
    .from("widget_sessions")
    .insert({
      widget_id: widget.id,
      tenant_id: widget.tenant_id,
      visitor_id: visitorId,
      visitor_ip: req.ip ?? null,
      visitor_ua: (req.headers["user-agent"] ?? "").slice(0, 200),
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // إرسال رسالة الترحيب
  const { data: welcomeWidget } = await db
    .from("widgets")
    .select("welcome_message")
    .eq("id", widget.id)
    .single();

  if (welcomeWidget?.welcome_message) {
    await db.from("widget_messages").insert({
      session_id: session.id,
      widget_id: widget.id,
      tenant_id: widget.tenant_id,
      direction: "out",
      body: welcomeWidget.welcome_message,
      kind: "answer",
    });
  }

  res.json({
    sessionId: session.id,
    messages: welcomeWidget?.welcome_message
      ? [{ id: "welcome", direction: "out", body: welcomeWidget.welcome_message, kind: "answer", created_at: new Date().toISOString() }]
      : [],
  });
});

/** إرسال رسالة والحصول على رد */
widgetsRouter.post("/public/:token/message", rateLimit({ windowMs: 60_000, max: 30 }), async (req, res) => {
  const { data: widget } = await db
    .from("widgets")
    .select("id, tenant_id, enabled")
    .eq("public_token", req.params.token)
    .maybeSingle();

  if (!widget || !widget.enabled) return res.status(404).json({ error: "Widget غير موجود أو معطّل" });

  const { sessionId, message } = req.body ?? {};
  if (!sessionId || !message?.trim()) {
    return res.status(400).json({ error: "sessionId و message مطلوبان" });
  }

  // التحقق من الجلسة
  const { data: session } = await db
    .from("widget_sessions")
    .select("*")
    .eq("id", sessionId)
    .eq("widget_id", widget.id)
    .maybeSingle();

  if (!session) return res.status(404).json({ error: "جلسة غير موجودة" });

  // حفظ رسالة المستخدم
  await db.from("widget_messages").insert({
    session_id: session.id,
    widget_id: widget.id,
    tenant_id: widget.tenant_id,
    direction: "in",
    body: message.trim(),
    kind: "customer",
  });

  // تحديث last_message_at
  await db
    .from("widget_sessions")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", session.id);

  // التحقق من الرصيد
  const { data: tenant } = await db
    .from("tenants")
    .select("credits_remaining, business_name")
    .eq("id", widget.tenant_id)
    .single();

  if (!tenant || tenant.credits_remaining <= 0) {
    const replyText = "عذرًا، الخدمة غير متاحة حاليًا. يرجى المحاولة لاحقًا.";
    await db.from("widget_messages").insert({
      session_id: session.id,
      widget_id: widget.id,
      tenant_id: widget.tenant_id,
      direction: "out",
      body: replyText,
      kind: "error",
    });
    return res.json({ reply: replyText, kind: "error" });
  }

  // توليد الرد باستخدام RAG
  try {
    const result = await answerFromKnowledge(widget.tenant_id, tenant.business_name, message.trim());

    let replyText: string;
    let kind: string;

    if (result.confident && result.answer) {
      replyText = result.answer;
      kind = "answer";
    } else {
      replyText = "عذرًا، ما عندي معلومات مؤكدة عن هذا الموضوع. هل تقدر توضح أكثر؟";
      kind = "refusal";

      // تسجيل السؤال العالق
      await db.from("unresolved_questions").insert({
        tenant_id: widget.tenant_id,
        question_encrypted: message.trim(), // في الإنتاج يجب تشفيره
        best_similarity: result.bestSimilarity,
      });
    }

    // حفظ الرد
    await db.from("widget_messages").insert({
      session_id: session.id,
      widget_id: widget.id,
      tenant_id: widget.tenant_id,
      direction: "out",
      body: replyText,
      kind,
    });

    // خصم الرصيد
    await db.rpc("consume_reply", {
      p_tenant_id: widget.tenant_id,
      p_message_id: (await db.from("widget_messages").select("id").eq("session_id", session.id).order("created_at", { ascending: false }).limit(1)).data?.[0]?.id,
    });

    res.json({ reply: replyText, kind });
  } catch (err: any) {
    console.error("[widget] reply error:", err);
    const replyText = "عذرًا، حدث خطأ. يرجى المحاولة مرة أخرى.";
    await db.from("widget_messages").insert({
      session_id: session.id,
      widget_id: widget.id,
      tenant_id: widget.tenant_id,
      direction: "out",
      body: replyText,
      kind: "error",
    });
    res.json({ reply: replyText, kind: "error" });
  }
});
