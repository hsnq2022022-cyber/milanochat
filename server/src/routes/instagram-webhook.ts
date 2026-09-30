/**
 * Instagram Messaging Webhook — مسار التحقق والاستقبال على النطاق المخصص للـ webhook.
 *
 * - GET  /api/webhooks/instagram  → تحقق Meta (hub.verify_token = INSTAGRAM_VERIFY_TOKEN)
 * - POST /api/webhooks/instagram  → أحداث entry[].messaging[] لحسابات Instagram
 *   الاحترافية المرتبطة عبر channel_accounts (external_id = IG account id أو page id).
 *
 * المعالجة تُمرَّر إلى نفس محرك الرد الآلي (handleIncomingMessage) بحيث تعمل
 * قاعدة المعرفة والتحويل لبشري وخصم الرصيد كما في واتساب، والإرسال يتم عبر
 * Graph API Conversations من الخادم فقط.
 */
import { Router } from "express";
import type { Request, Response } from "express";
import crypto from "node:crypto";
import { db } from "../db.js";
import { handleIncomingMessage } from "../rag/reply.js";

export const instagramWebhookRouter = Router();

const VERIFY_TOKEN = process.env.INSTAGRAM_VERIFY_TOKEN || "";

// ─── 1. التحقق من Webhook (GET) ───
instagramWebhookRouter.get("/instagram", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("[Instagram Webhook] Verification request:", {
    mode,
    token: token ? "present" : "missing",
    challenge: challenge ? "present" : "missing",
  });

  if (mode === "subscribe" && VERIFY_TOKEN && token === VERIFY_TOKEN) {
    console.log("[Instagram Webhook] ✓ Verified successfully");
    return res.status(200).send(challenge);
  }

  console.error("[Instagram Webhook] ✗ Verification failed", {
    expected: VERIFY_TOKEN ? "set" : "empty",
  });
  return res.status(403).send("Verify failed");
});

/* تحقق توقيع X-Hub-Signature-256 إن كان META_APP_SECRET مضبوطاً */
function verifySignature(req: Request): boolean {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return true; // لم يُضبط السر بعد — لا نكسر التدفق الحالي
  const sig = String(req.headers["x-hub-signature-256"] ?? "");
  const rawBody: Buffer | undefined = (req as any).rawBody;
  if (!sig || !rawBody) return false;
  const expected =
    "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ─── 2. استقبال الرسائل (POST) ───
instagramWebhookRouter.post("/instagram", async (req: Request, res: Response) => {
  // رد 200 فورًا لـ Meta (خلال 5 ثوانٍ)
  res.status(200).send("EVENT_RECEIVED");

  try {
    if (!verifySignature(req)) {
      console.error("[Instagram Webhook] Invalid signature — ignored");
      return;
    }

    const body: any = req.body;
    console.log(
      "[Instagram Webhook] Received:",
      JSON.stringify(body).slice(0, 300)
    );

    if (!body || (body.object !== "instagram" && body.object !== "page")) {
      return;
    }

    for (const entry of body.entry || []) {
      const platformId = String(entry.id || "");
      if (!platformId) continue;

      // ابحث عن القناة المرتبطة (channel_accounts) — قد يكون entry.id هو
      // معرّف حساب IG نفسه أو معرّف صفحة Facebook المرتبطة به
      let { data: account } = await db
        .from("channel_accounts")
        .select("tenant_id, channel, external_id, status, agent_enabled, auto_reply")
        .eq("external_id", platformId)
        .in("channel", ["instagram", "facebook"])
        .maybeSingle();

      if (!account) {
        const { data: byPage } = await db
          .from("channel_accounts")
          .select("tenant_id, channel, external_id, status, agent_enabled, auto_reply")
          .eq("external_id", platformId)
          .eq("channel", "facebook")
          .maybeSingle();
        account = byPage;
      }

      if (!account) {
        console.warn(
          `[Instagram Webhook] No tenant bound for external_id: ${platformId}`
        );
        continue;
      }
      if (account.status !== "active") continue;

      const channel = account.channel === "facebook" ? "facebook" : "instagram";

      // معالجة messaging events
      const messaging = entry.messaging || [];

      for (const event of messaging) {
        // تجاهل رسائل الصدى (echo) الصادرة من التطبيق نفسه
        if (!event.message || event.message.is_echo) continue;

        const senderId = event.sender?.id;
        const text = event.message?.text;

        if (!senderId || !text) continue;

        // معرّف المحادثة يحمل بادئة القناة (منصة:معرّف العميل) — يمنع تصادم المعرفات بين القنوات
        const chatId = `${channel}:${senderId}`;

        // منع تكرار الـ webhook عبر المعرّف الخارجي للرسالة (mid)
        const msgId: string | null =
          typeof event.message?.mid === "string" ? event.message.mid : `ig_${Date.now()}`;

        if (event.message?.mid) {
          const { data: dup } = await db
            .from("messages")
            .select("id")
            .eq("wa_message_id", msgId)
            .limit(1);
          if (dup && dup.length > 0) {
            console.log(`[Instagram Webhook] Duplicate skipped: ${msgId}`);
            continue;
          }
        }

        // أنشئ/حدّث المحادثة وادفع الرسالة إلى محرك الرد الآلي الموحد
        // (handleIncomingMessage يتكفل بالحفظ والقناة والوكيل والإرسال)
        try {
          await handleIncomingMessage(account.tenant_id, chatId, text, msgId, {
            channel: channel as "instagram" | "facebook",
          });
        } catch (e) {
          console.error("[Instagram Webhook] AI reply error:", e);
        }
      }
    }
  } catch (e: any) {
    console.error("[Instagram Webhook] Fatal error:", e);
  }
});
