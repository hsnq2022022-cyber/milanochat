// ═══════════════════════════════════════════════════════════════════
// Edge Function: agent-prompt
// GET  → { prompt }           قراءة رسالة توجيه الوكيل
// POST → { ok: true }         حفظها (body: { prompt })
// المصادقة: Bearer توكن Supabase Auth، والـ tenant من tenants.user_id
// ═══════════════════════════════════════════════════════════════════

import { createClient } from "npm:@supabase/supabase-js@2";
import { withCors, trustedCorsPolicy } from "../_shared/cors.ts";

// T5-D2: Access-Control-Allow-Origin only for the trusted application origins
// (exact match, Vary: Origin, never credentials): ../_shared/cors.ts.
const cors: Record<string, string> = {
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const MAX_LEN = 8000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
  });

// أخطاء آمنة: لا يصل نص خطأ قاعدة البيانات / الاستثناء إلى العميل أو السجلات
const DB_ERROR_MESSAGE = "تعذر إتمام العملية — حاول مرة أخرى";
const INTERNAL_ERROR_MESSAGE = "خطأ داخلي";

/** Coarse, value-free code: SQLSTATE (5 chars) or PGRSTnnn, else "unknown". */
function safeErrCode(error: unknown): string {
  try {
    const c = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    if (typeof c === "string" && /^(?:[0-9A-Z]{5}|PGRST\d{3})$/.test(c)) return c;
  } catch {
    /* hostile error object */
  }
  return "unknown";
}

Deno.serve(withCors(() => trustedCorsPolicy((k) => Deno.env.get(k)), async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: cors });
  }

  try {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) return json({ error: "إعدادات الخادم ناقصة" }, 500);

    const sb = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const header = req.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) return json({ error: "غير مصرح" }, 401);

    const { data: userData, error: userErr } = await sb.auth.getUser(token);
    if (userErr || !userData?.user) {
      return json({ error: "جلسة غير صالحة" }, 401);
    }

    const { data: tenant } = await sb
      .from("tenants")
      .select("id, agent_system_prompt")
      .eq("user_id", userData.user.id)
      .maybeSingle();

    if (!tenant) return json({ error: "لا يوجد حساب مرتبط" }, 404);

    if (req.method === "GET") {
      return json({ prompt: tenant.agent_system_prompt ?? null });
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const prompt = body?.prompt;

      if (typeof prompt !== "string") {
        return json({ error: "prompt يجب أن يكون نصًا" }, 400);
      }
      if (prompt.length > MAX_LEN) {
        return json({ error: `prompt يتجاوز الحد الأقصى (${MAX_LEN} حرف)` }, 400);
      }

      const { error } = await sb
        .from("tenants")
        .update({ agent_system_prompt: prompt.trim() || null })
        .eq("id", tenant.id);

      if (error) {
        console.error("[agent-prompt] db error", { tag: "prompt_update", code: safeErrCode(error) });
        return json({ error: DB_ERROR_MESSAGE }, 500);
      }
      return json({ ok: true });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (e) {
    console.error("[agent-prompt] fatal", { code: safeErrCode(e) });
    return json({ error: INTERNAL_ERROR_MESSAGE }, 500);
  }
}));
