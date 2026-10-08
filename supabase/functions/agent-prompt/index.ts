// ═══════════════════════════════════════════════════════════════════
// Edge Function: agent-prompt
// GET  → { prompt }           قراءة رسالة توجيه الوكيل
// POST → { ok: true }         حفظها (body: { prompt })
// المصادقة: Bearer توكن Supabase Auth، والـ tenant من tenants.user_id
// ═══════════════════════════════════════════════════════════════════

import { createClient } from "npm:@supabase/supabase-js@2";

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
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

Deno.serve(async (req: Request) => {
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

      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (e) {
    console.error("[agent-prompt]", e);
    return json({ error: e instanceof Error ? e.message : "خطأ داخلي" }, 500);
  }
});
