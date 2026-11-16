// Edge Function: conversation-previews
// POST -> { previews: { [conversationId]: "last message text" } }
// Auth: Bearer Supabase Auth token; tenant from tenants.user_id
// Decryption matches decryptField in milan-api (AES-GCM / FIELD_ENCRYPTION_KEY)

import { createClient } from "npm:@supabase/supabase-js@2";
import { withCors, trustedCorsPolicy } from "../_shared/cors.ts";

// T5-D2: Access-Control-Allow-Origin only for the trusted application origins
// (exact match, Vary: Origin, never credentials): ../_shared/cors.ts.
const cors: Record<string, string> = {
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
  });

// Safe errors: DB / exception text never reaches the response or a log line.
const INTERNAL_ERROR_MESSAGE = "internal error";

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

const enc = new TextEncoder();
const dec = new TextDecoder();

let _key: CryptoKey | null = null;

async function aesKey(): Promise<CryptoKey> {
  if (_key) return _key;

  const mat = await crypto.subtle.digest(
    "SHA-256",
    enc.encode(Deno.env.get("FIELD_ENCRYPTION_KEY") ?? ""),
  );

  _key = await crypto.subtle.importKey("raw", mat, "AES-GCM", false, ["decrypt"]);
  return _key;
}

const fromHex = (h: string) =>
  Uint8Array.from((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));

async function decryptField(stored: string | null | undefined): Promise<string> {
  if (!stored) return "";
  if (!stored.startsWith("enc:v1:")) return stored;

  const [, , ivH, tagH, dataH] = stored.split(":");

  const data = fromHex(dataH ?? "");
  const tag = fromHex(tagH ?? "");

  const buf = new Uint8Array(data.length + tag.length);
  buf.set(data, 0);
  buf.set(tag, data.length);

  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromHex(ivH ?? "") as BufferSource },
    await aesKey(),
    buf as BufferSource,
  );

  return dec.decode(pt);
}

Deno.serve(withCors(() => trustedCorsPolicy((k) => Deno.env.get(k)), async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: cors });
  }

  try {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) return json({ error: "server config missing" }, 500);

    const sb = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const header = req.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) return json({ error: "unauthorized" }, 401);

    const { data: userData, error: userErr } = await sb.auth.getUser(token);
    if (userErr || !userData?.user) {
      return json({ error: "invalid session" }, 401);
    }

    const { data: tenant } = await sb
      .from("tenants")
      .select("id")
      .eq("user_id", userData.user.id)
      .maybeSingle();

    if (!tenant) return json({ error: "no linked account" }, 404);

    const { data: convs, error: convErr } = await sb
      .from("conversations")
      .select("id")
      .eq("tenant_id", tenant.id)
      .order("last_message_at", { ascending: false })
      .limit(50);

    if (convErr) {
      console.error("[conversation-previews] db error", { tag: "conversations_select", code: safeErrCode(convErr) });
      return json({ error: INTERNAL_ERROR_MESSAGE }, 500);
    }

    const entries = await Promise.all(
      (convs ?? []).map(async (c: { id: string }): Promise<[string, string | null]> => {
        try {
          const { data: m } = await sb
            .from("messages")
            .select("body_encrypted")
            .eq("conversation_id", c.id)
            .eq("tenant_id", tenant.id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

          return [c.id, m?.body_encrypted ? await decryptField(m.body_encrypted) : null];
        } catch {
          return [c.id, null];
        }
      }),
    );

    const previews: Record<string, string> = {};
    for (const [id, body] of entries) {
      if (body) previews[id] = body;
    }

    return json({ previews });
  } catch (e) {
    console.error("[conversation-previews] fatal", { code: safeErrCode(e) });
    return json({ error: INTERNAL_ERROR_MESSAGE }, 500);
  }
}));
