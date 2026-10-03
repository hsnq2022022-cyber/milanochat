/**
 * Milano Server — Express entry
 * التشغيل: cd server && npm install && cp .env.example .env && npm run dev
 *
 * ملاحظات الإصدار (v4):
 * - تُسجَّل كل الراوترات على المسارات الصحيحة.
 * - نحتفظ بـ rawBody للتحقق من توقيع Meta Webhooks (X-Hub-Signature-256).
 * - نحتفظ بـ rawBody لـ webhooks WhatsApp و Instagram و Meta Messenger.
 * - NEW: logging middleware قبل الراوترات لتتبع وصول POST من Meta.
 */
import express from "express";
import cors, { type CorsOptions } from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, corsOrigins, corsOriginPatterns } from "./config.js";
import { tenantsRouter } from "./routes/tenants.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { whatsappRouter } from "./routes/whatsapp.js";
import { whatsappWebhookRouter } from "./routes/webhooks.js";
import { widgetsRouter } from "./routes/widgets.js";
import { paymentsRouter, webhooksRouter } from "./routes/payments.js";
import { channelsRouter } from "./routes/channels.js";
import { metaAuthRouter } from "./routes/auth-meta.js";
import { instagramWebhookRouter } from "./routes/instagram-webhook.js";
import { handleIncomingMessage } from "./rag/reply.js";
import { initWa, restorePersistedSessions } from "./wa/sessionManager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable("x-powered-by");

/* ═══════════════════════════════════════════════════════════
   CORS — قائمة صريحة + نمط للمعاينات السحابية + طلبات بلا Origin
   ═══════════════════════════════════════════════════════════ */
const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    if (
      !origin ||
      corsOrigins.includes(origin) ||
      corsOriginPatterns.some((re) => re.test(origin))
    ) {
      return callback(null, true);
    }
    callback(new Error(`CORS: الأصل غير مسموح: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Tenant-Token",
    "X-Requested-With",
    "Apikey",
    "X-Hub-Signature-256",
  ],
};
app.use(cors(corsOptions));

/* ═══════════════════════════════════════════════════════════
   Body parser — نحتفظ بـ rawBody للتحقق من توقيع Meta Webhooks
   ═══════════════════════════════════════════════════════════ */
app.use(
  express.json({
    limit: "1mb",
    verify: (req: any, _res, buf) => {
      const url = req.originalUrl ?? "";
      if (
        url.startsWith("/api/webhooks") ||
        url.startsWith("/api/channels/meta/webhook")
      ) {
        req.rawBody = buf;
      }
    },
  })
);

/* ═══════════════════════════════════════════════════════════
   [تشخيص] تسجيل كل طلب يصل لمسارات Webhooks — قبل الراوترات
   ═══════════════════════════════════════════════════════════
   هذا يساعد على كشف:
   - هل Meta ترسل أي POST أصلاً؟
   - هل يوجد X-Hub-Signature-256؟
   - ما نوع User-Agent الوارد؟
   - على أي URL بالضبط يصل الطلب؟
   ═══════════════════════════════════════════════════════════ */
app.use(
  ["/api/webhooks", "/api/channels/meta/webhook"],
  (req: any, _res, next) => {
    if (req.method === "POST" || req.method === "GET") {
      const sig = req.headers["x-hub-signature-256"];
      const ua = String(req.headers["user-agent"] ?? "").slice(0, 80);
      console.log(
        `[webhook-in] ${req.method} ${req.originalUrl}` +
          ` | sig=${sig ? "yes" : "no"}` +
          ` | rawBody=${req.rawBody ? `${req.rawBody.length}b` : "none"}` +
          ` | ua=${ua}`
      );
    }
    next();
  }
);

/* ═══════════════════════════════════════════════════════════
   مسارات عامة
   ═══════════════════════════════════════════════════════════ */
app.get("/health", (_req, res) =>
  res.json({ ok: true, service: "milano-server" })
);

app.get("/privacy", (_req, res) =>
  res.sendFile(path.join(__dirname, "..", "PRIVACY_POLICY_ar.md"))
);

/* تقديم widget.js */
app.get("/widget.js", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "widget.js"));
});

/* ═══════════════════════════════════════════════════════════
   الراوترات
   ═══════════════════════════════════════════════════════════ */

/* الفواتير والاشتراكات */
app.use("/api/tenants", tenantsRouter);

/* لوحة التحكم */
app.use("/api/dashboard", dashboardRouter);

/* WhatsApp Cloud API — إدارة الجلسات والإرسال */
app.use("/api/whatsapp", whatsappRouter);

/* WhatsApp Webhook (Meta Cloud API) */
app.use("/api/webhooks/meta", whatsappWebhookRouter);

/* Widgets (Chat Widget) */
app.use("/api/widgets", widgetsRouter);

/* القنوات الاجتماعية (Facebook / Instagram / WhatsApp) */
app.use("/api/channels", channelsRouter);

/* OAuth Flow لـ Meta (Facebook Login + Instagram) */
app.use("/api/auth", metaAuthRouter);

/* بوابات الدفع */
app.use("/api/payments", paymentsRouter);

/* Webhooks الدفع */
app.use("/api/webhooks", webhooksRouter);

/* Instagram Webhook (مسارات /api/webhooks/instagram) */
app.use("/api/webhooks", instagramWebhookRouter);

/* ═══════════════════════════════════════════════════════════
   معالج الأخطاء العام
   ═══════════════════════════════════════════════════════════ */
app.use((err: any, _req: any, res: any, _next: any) => {
  console.error("[server] unhandled:", err);
  res.status(500).json({ error: "خطأ داخلي" });
});

/* ═══════════════════════════════════════════════════════════
   الإقلاع
   ═══════════════════════════════════════════════════════════ */
initWa(handleIncomingMessage);

app.listen(config.port, () => {
  console.log(`\n  Milano server يعمل على المنفذ ${config.port}`);
  console.log(`  الواجهة المسموحة: ${config.frontendOrigin}\n`);
  console.log(`  [routes] /api/dashboard  ✓`);
  console.log(`  [routes] /api/channels   ✓`);
  console.log(`  [routes] /api/auth       ✓`);
  console.log(`  [routes] /api/webhooks   ✓`);
  console.log(`  [routes] /api/whatsapp   ✓`);
  console.log(`  [routes] /api/widgets    ✓`);
  console.log(`  [webhook-in] logging is ACTIVE\n`);
  restorePersistedSessions().catch((e) =>
    console.error("[boot] restore failed:", e)
  );
});

process.on("unhandledRejection", (reason: any) => {
  console.error("[Server] Unhandled rejection:", reason);
});

process.on("uncaughtException", (err: any) => {
  console.error("[Server] Uncaught exception:", err);
});
