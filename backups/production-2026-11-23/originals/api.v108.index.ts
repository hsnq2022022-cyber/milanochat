// ═══════════════════════════════════════════════════════════════════
// Edge Function: api (standalone — no external imports)
// ═══════════════════════════════════════════════════════════════════
// ملاحظة: هذا الملف مستقل تمامًا، لا يعتمد على _shared
// لأنه يُنشر عبر Supabase Editor (لا يدعم مجلدات)
// ═══════════════════════════════════════════════════════════════════

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ───────────────────────────────────────────────────────────
// من _shared/cors.ts
// ───────────────────────────────────────────────────────────
const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-hub-signature-256",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};

function handleCors(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: corsHeaders,
    });
  }
  return null;
}

// ───────────────────────────────────────────────────────────
// من _shared/db.ts
// ───────────────────────────────────────────────────────────
let _adminClient: ReturnType<typeof createClient> | null = null;

function getAdminClient() {
  if (_adminClient) return _adminClient;

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !key) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables",
    );
  }

  _adminClient = createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return _adminClient;
}

// ───────────────────────────────────────────────────────────
// المعالج الرئيسي
// ───────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);

  if (corsResponse) {
    return corsResponse;
  }

  const url = new URL(req.url);

  // ── /health ──
  if (url.pathname.endsWith("/health")) {
    return new Response(
      JSON.stringify({
        ok: true,
        service: "edge-api",
        timestamp: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  }

  // ── /db-test ──
  if (url.pathname.endsWith("/db-test")) {
    try {
      const supabase = getAdminClient();

      const { data, error } = await supabase
        .from("channel_accounts")
        .select("id")
        .limit(1);

      if (error) {
        console.error("[DB Test]", error.message);

        return new Response(
          JSON.stringify({
            ok: false,
            database: false,
            error: error.message,
          }),
          {
            status: 500,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json",
            },
          },
        );
      }

      return new Response(
        JSON.stringify({
          ok: true,
          database: true,
          rows: data?.length ?? 0,
        }),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    } catch (error) {
      return new Response(
        JSON.stringify({
          ok: false,
          database: false,
          error: error instanceof Error
            ? error.message
            : "Database test failed",
        }),
        {
          status: 500,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }
  }

  // ── 404 ──
  return new Response(
    JSON.stringify({
      error: "Not found",
    }),
    {
      status: 404,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    },
  );
});