/**
 * WhatsApp Session API — Meta WhatsApp Cloud API (الرسمي من Meta):
 *   POST /api/whatsapp/session                  إنشاء/استرجاع جلسة (يتحقق من Meta Cloud API)
 *   GET  /api/whatsapp/session/:sessionId       الحالة الحالية
 *   POST /api/whatsapp/session/:sessionId/logout تسجيل خروج (في Cloud API: فقط تغيير الحالة)
 *   GET  /api/whatsapp/session/:sessionId/events بث SSE لحظي (حالة الاتصال)
 *
 * ملاحظة: QR endpoint لم يعد مستخدماً - Meta Cloud API لا يحتاج QR
 *
 * الأمان: كل طلب يمر عبر authorizeTenant — إما توكن Supabase (يُتحقق منه ثم يُبحث
 * عن الـ tenant المملوك للمستخدم) أو توكن جلسة المعالج (claim_token). معرّف الجلسة
 * في الرابط يجب أن يطابق الـ tenant المصرح به، فلا يستطيع مستخدم الوصول لجلسة غيره.
 * sessionId في هذا النظام = tenantId (جلسة مستقلة لكل Agent/Workspace).
 */
import type { Request, Response } from "express";
import { Router } from "express";
import { authClient, db } from "../db.js";
import { rateLimit } from "../middleware/rateLimit.js";
import {
  ensureSession,
  getSnapshot,
  logoutSession,
  subscribeSession,
  type SessionSnapshot,
} from "../wa/sessionManager.js";

export const whatsappRouter = Router();

/** لا نرسل النص الخام أو أي حقل داخلي — فقط ما تحتاجه الواجهة */
function publicSnap(s: SessionSnapshot) {
  return {
    sessionId: s.sessionId,
    state: s.state,
    qrDataUrl: s.qrDataUrl,
    phone: s.phone,
    error: s.error,
  };
}

/** التحقق من الهوية وإعادة tenantId المملوك للم caller أو null */
async function authorizeTenant(req: Request): Promise<string | null> {
  const header = req.headers.authorization ?? "";
  const token =
    (header.startsWith("Bearer ") ? header.slice(7) : "") ||
    ((req.headers["x-tenant-token"] as string) ?? "") ||
    ((req.query.token as string) ?? "");
  if (!token) return null;

  // 1) توكن Supabase Auth (لوحة التحكم)
  if (token.split(".").length === 3) {
    const { data } = await authClient.auth.getUser(token);
    if (data?.user) {
      const { data: t } = await db
        .from("tenants")
        .select("id")
        .eq("user_id", data.user.id)
        .maybeSingle();
      if (t) return t.id;
    }
  }

  // 2) توكن جلسة معالج الإنشاء (الصفحة الرئيسية قبل التسجيل)
  const { data } = await db
    .from("tenants")
    .select("id")
    .eq("claim_token", token)
    .maybeSingle();
  return data?.id ?? null;
}

/** حارس المسارات: يرفض أي طلب لا يملك الجلسة المطلوبة */
async function guard(req: Request, res: Response): Promise<string | null> {
  const owner = await authorizeTenant(req);
  if (!owner) {
    res.status(401).json({ error: "غير مصرح" });
    return null;
  }
  if (owner !== req.params.sessionId) {
    res.status(403).json({ error: "لا تملك صلاحية على هذه الجلسة" });
    return null;
  }
  return owner;
}

whatsappRouter.post(
  "/session",
  rateLimit({ windowMs: 60_000, max: 12 }),
  async (req, res) => {
    const owner = await authorizeTenant(req);
    const { tenantId } = req.body ?? {};
    if (!owner || tenantId !== owner) {
      return res.status(403).json({ error: "لا تملك صلاحية على هذه الجلسة" });
    }
    try {
      const snap = await ensureSession(owner);
      res.json(publicSnap(snap));
    } catch (e) {
      console.error("[wa] ensureSession failed:", e);
      res.status(500).json({ error: "تعذر إنشاء جلسة واتساب، تحقق من اتصال الخادم." });
    }
  }
);

whatsappRouter.get("/session/:sessionId", async (req, res) => {
  const owner = await guard(req, res);
  if (!owner) return;
  res.json(publicSnap(getSnapshot(owner)));
});

// QR endpoint لم يعد مستخدماً في Meta Cloud API
// whatsappRouter.get("/session/:sessionId/qr", ...)

whatsappRouter.post(
  "/session/:sessionId/logout",
  rateLimit({ windowMs: 60_000, max: 6 }),
  async (req, res) => {
    const owner = await guard(req, res);
    if (!owner) return;
    await logoutSession(owner);
    res.json({ ok: true });
  }
);

/**
 * بث SSE لحظي: لقطة فورية عند الفتح ثم كل تغيّر حالة،
 * مع نبض كل 25 ثانية لإبقاء الاتصال حيًا خلف الوكلاء.
 * 
 * ملاحظة: QR لم يعد مستخدماً في Meta Cloud API
 */
whatsappRouter.get("/session/:sessionId/events", async (req, res) => {
  const owner = await authorizeTenant(req);
  if (!owner || owner !== req.params.sessionId) {
    res.status(403).json({ error: "لا تملك صلاحية على هذه الجلسة" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // nginx: لا تجمع البث
  res.flushHeaders?.();

  const send = (snap: SessionSnapshot) => {
    res.write(`data: ${JSON.stringify(publicSnap(snap))}\n\n`);
  };

  send(getSnapshot(owner));
  const unsubscribe = subscribeSession(owner, send);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

/**
 * Test endpoint لإرسال رسالة اختبارية عبر Meta Cloud API
 * يستخدم للاختبار فقط - ليس للاستخدام في الإنتاج
 */
whatsappRouter.post(
  "/send-test",
  rateLimit({ windowMs: 60_000, max: 5 }),
  async (req, res) => {
    const { to, message } = req.body ?? {};
    
    if (!to || !message) {
      return res.status(400).json({ error: "الحقول المطلوبة: to, message" });
    }

    try {
      const { metaCloudAPI } = await import("../wa/metaCloudAPI.js");
      const messageId = await metaCloudAPI.sendMessage("test", to, message);
      
      res.json({ 
        success: true, 
        messageId,
        message: "تم إرسال الرسالة بنجاح عبر Meta Cloud API"
      });
    } catch (error: any) {
      console.error("[WhatsApp Test] Error:", error);
      res.status(500).json({ 
        success: false, 
        error: error.message || "فشل إرسال الرسالة"
      });
    }
  }
);
