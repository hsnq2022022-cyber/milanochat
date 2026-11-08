/**
 * generate-flow Edge entry. NOT deployed; not in any deploy workflow.
 * Default OFF (FLOW_AI_BUILDER_ENABLED). Credit RPCs come from migration
 * 20261029310000_flow_ai_generations; until it is applied requests fail closed.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { handleGenerateFlow } from "./handler.ts";
import { supabaseCreditPort } from "./credits.ts";
import { createGeminiCall } from "./gemini.ts";
import { createLimiter } from "../milan-api/abuseGuards.ts";

const env = (k: string) => Deno.env.get(k) ?? "";

export function serve(req: Request): Promise<Response> {
  const url = env("SUPABASE_URL"), serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) {
    return Promise.resolve(new Response(JSON.stringify({ ok: false, error: "ai_unavailable",
      message: "خدمة الذكاء الاصطناعي غير متاحة مؤقتًا، لم يتم خصم أي رصيد" }),
      { status: 503, headers: { "Content-Type": "application/json; charset=utf-8" } }));
  }
  const client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const apiKey = env("GEMINI_API_KEY");
  return handleGenerateFlow(req, {
    env,
    authUser: async (jwt) => {
      const { data, error } = await client.auth.getUser(jwt);
      return error || !data.user ? null : { id: data.user.id };
    },
    tenantForUser: async (userId) => {
      const { data, error } = await client.from("tenants").select("id,user_id")
        .eq("user_id", userId).maybeSingle();
      if (error) throw new Error("tenant_lookup");
      return data && data.user_id === userId ? { id: String(data.id) } : null;
    },
    limiter: createLimiter({ rpc: client }),
    credits: supabaseCreditPort(client),
    llm: apiKey ? createGeminiCall({ apiKey, model: env("FLOW_AI_BUILDER_MODEL") || env("GEMINI_MODEL") }) : null,
  });
}

if (import.meta.main) Deno.serve(serve);
