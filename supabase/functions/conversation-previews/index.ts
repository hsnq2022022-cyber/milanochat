// Edge Function: conversation-previews
// POST -> { previews: { [conversationId]: "last message text" } }
// Auth: Bearer Supabase Auth token; tenant from tenants.user_id
// Decryption matches decryptField in milan-api (AES-GCM / FIELD_ENCRYPTION_KEY)

import { createClient } from "npm:@supabase/supabase-js@2";

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
  });

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

Deno.serve(async (req: Request) => {
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

    if (convErr) return json({ error: convErr.message }, 500);

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
    console.error("[conversation-previews]", e);
    return json({ error: e instanceof Error ? e.message : "internal error" }, 500);
  }
});
