// ═══════════════════════════════════════════════════════════════════
// Edge Function: create-payment
// POST { orderId, items?: [{ name, price }] }  (Bearer: Supabase user JWT)
// → { checkoutUrl, code, orderId }
//
// - يتحقق من المستخدم ومن أن الطلب ملكه وحالته pending
// - يأخذ المبلغ من قاعدة البيانات فقط (لا يثق بما يرسله العميل)
// - ينشئ رابط دفع في Wayl ويحفظ wayl_code / wayl_url
// - المنطق الكامل في handler.ts (قابل للاختبار)
//
// Secrets: WAYL_TOKEN, WAYL_WEBHOOK_SECRET, WAYL_ENV (test|live، الافتراضي test)،
//          SITE_URL (اختياري، مثال https://example.com — يُستخدم لرابط العودة
//          ويُضاف أصله إلى أصول CORS المسموح بها)
// ═══════════════════════════════════════════════════════════════════

import { createClient } from "npm:@supabase/supabase-js@2";
import { handleCreatePayment } from "./handler.ts";

Deno.serve((req: Request) =>
  handleCreatePayment(req, {
    env: (name) => Deno.env.get(name),
    db: (url, key) =>
      createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } }),
    authUser: async (sb, jwt) => {
      const { data, error } = await sb.auth.getUser(jwt);
      return error || !data?.user ? null : { id: data.user.id };
    },
    fetch: (input, init) => fetch(input, init),
  })
);
