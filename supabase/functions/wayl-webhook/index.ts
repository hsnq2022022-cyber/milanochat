// ═══════════════════════════════════════════════════════════════════
// Edge Function: wayl-webhook
// POST من Wayl عند تغيّر حالة الدفع.
// - يتحقق من التوقيع x-wayl-signature-256 (HMAC-SHA256 hex على الجسم الخام)
// - يحدّث حالة الطلب/الدفعة بانتقالات أمامية فقط (لا رجوع عن "paid")
// - المنطق الكامل في handler.ts (قابل للاختبار)
//
// Secrets: WAYL_WEBHOOK_SECRET
// ═══════════════════════════════════════════════════════════════════

import { createClient } from "npm:@supabase/supabase-js@2";
import { handleWaylWebhook } from "./handler.ts";

Deno.serve((req: Request) =>
  handleWaylWebhook(req, {
    env: (name) => Deno.env.get(name),
    db: (url, key) =>
      createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } }),
  })
);
