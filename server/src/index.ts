/**
 * Milano Server — Express entry
 * التشغيل: cd server && npm install && cp .env.example .env && npm run dev
 */
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { tenantsRouter } from "./routes/tenants.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { paymentsRouter, webhooksRouter } from "./routes/payments.js";
import { handleIncomingMessage } from "./rag/reply.js";
import { initWa, restorePersistedSessions } from "./wa/sessionManager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable("x-powered-by");
app.use(cors({ origin: config.frontendOrigin, credentials: false }));

// نحتفظ بالنص الخام للتحقق من توقيع الـ webhooks
app.use(
  express.json({
    limit: "1mb",
    verify: (req: any, _res, buf) => {
      if (req.originalUrl?.startsWith("/api/webhooks")) req.rawBody = buf;
    },
  })
);

// ── المسارات ──
app.get("/health", (_req, res) => res.json({ ok: true, service: "milano-server" }));

app.get("/privacy", (_req, res) =>
  res.sendFile(path.join(__dirname, "..", "PRIVACY_POLICY_ar.md"))
);

app.use("/api/tenants", tenantsRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/payments", paymentsRouter);
app.use("/api/webhooks", webhooksRouter);

// معالج أخطاء عام
app.use((err: any, _req: any, res: any, _next: any) => {
  console.error("[server] unhandled:", err);
  res.status(500).json({ error: "خطأ داخلي" });
});

// ── الإقلاع ──
initWa(handleIncomingMessage);

app.listen(config.port, () => {
  console.log(`\n  Milano server يعمل على المنفذ ${config.port}`);
  console.log(`  الواجهة المسموحة: ${config.frontendOrigin}\n`);
  restorePersistedSessions().catch((e) => console.error("[boot] restore failed:", e));
});
