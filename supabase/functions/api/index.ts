import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAdminClient } from "../_shared/db.ts";

// Safe errors: DB / exception text never reaches the response or a log line.
const DB_TEST_FAILED = "Database test failed";

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

// /db-test is an operator-only endpoint (api is deployed with verify_jwt=false).
// Credential: `Authorization: Bearer <API_DB_TEST_SECRET>`. Fail closed: an
// unset/empty secret never grants access. Every rejection returns the same
// generic 401; neither the secret nor the presented credential is ever logged.
const DB_TEST_UNAUTHORIZED_BODY = JSON.stringify({ error: "Unauthorized" });
const MAX_AUTH_HEADER_LENGTH = 8192;

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/** Constant-time compare of fixed-length (SHA-256) digests; no early exit. */
function digestsEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

async function isDbTestAuthorized(req: Request): Promise<boolean> {
  try {
    const secret = Deno.env.get("API_DB_TEST_SECRET") ?? "";
    const header = req.headers.get("authorization") ?? "";
    const wellFormed = header.length <= MAX_AUTH_HEADER_LENGTH && header.startsWith("Bearer ");
    const presented = wellFormed ? header.slice("Bearer ".length) : "";
    // Both digests are always computed, so the work does not depend on which check fails.
    const [expectedDigest, presentedDigest] = await Promise.all([sha256(secret), sha256(presented)]);
    const match = digestsEqual(expectedDigest, presentedDigest);
    return secret.length > 0 && presented.length > 0 && wellFormed && match;
  } catch {
    return false;
  }
}

function dbTestUnauthorized(): Response {
  return new Response(DB_TEST_UNAUTHORIZED_BODY, {
    status: 401,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

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
    // Operator auth runs before any database client is created or queried.
    if (!(await isDbTestAuthorized(req))) {
      console.warn("[DB Test] unauthorized");
      return dbTestUnauthorized();
    }

    try {
      const supabase = getAdminClient();

      const { data, error } = await supabase
        .from("channel_accounts")
        .select("id")
        .limit(1);

      if (error) {
        console.error("[DB Test] db error", { code: safeErrCode(error) });

        return new Response(
          JSON.stringify({
            ok: false,
            database: false,
            error: DB_TEST_FAILED,
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
      console.error("[DB Test] fatal", { code: safeErrCode(error) });

      return new Response(
        JSON.stringify({
          ok: false,
          database: false,
          error: DB_TEST_FAILED,
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
