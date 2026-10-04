import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAdminClient } from "../_shared/db.ts";

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);

  if (corsResponse) {
    return corsResponse;
  }

  const url = new URL(req.url);

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
