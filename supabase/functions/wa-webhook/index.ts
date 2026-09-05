/**
 * ميلانو — محرك واتساب على Supabase (WhatsApp Cloud API الرسمية)
 *
 * يستقبل رسائل Meta → بحث دلالي في معرفة العميل → LLM → رد عبر Graph API
 * → خصم الرصيد → تسجيل الأسئلة العالقة. بدون أي خادم خارجي.
 *
 * - GET: تحقق Meta من الـ webhook (hub.challenge)
 * - POST {action:"ping"}: فحص الحالة من الواجهة
 * - POST من Meta: معالجة الرسالة الواردة
 *
 * الأسرار المطلوبة (Edge Functions → Secrets):
 * OPENAI_API_KEY, FIELD_ENCRYPTION_KEY, WA_ACCESS_TOKEN, WA_VERIFY_TOKEN
 * (SUPABASE_URL و SUPABASE_SERVICE_ROLE_KEY تُحقن تلقائيًا)
 */
import { createClient } from "npm:@supabase/supabase-js@2";

const enc = new TextEncoder();

const hex = (b: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(b instanceof Uint8Array ? b.buffer : b)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");

/* تشفير حقلي AES-256-GCM متوافق مع صيغة الخادم enc:v1:iv:tag:data */
async function encryptField(plain: string): Promise<string> {
  if (!plain) return "";
  const mat = await crypto.subtle.digest("SHA-256", enc.encode(Deno.env.get("FIELD_ENCRYPTION_KEY") ?? ""));
  const key = await crypto.subtle.importKey("raw", mat, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plain)));
  return `enc:v1:${hex(iv)}:${hex(ct.slice(-16))}:${hex(ct.slice(0, -16))}`;
}

const supabase = () =>
  createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function embed(texts: string[]): Promise<number[][]> {
  const res = await fetch(`${Deno.env.get("EMBED_BASE_URL") ?? "https://api.openai.com/v1"}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}` },
    body: JSON.stringify({
      model: Deno.env.get("EMBED_MODEL") ?? "text-embedding-3-small",
      input: texts,
    }),
  });
  if (!res.ok) throw new Error(`embedding failed ${res.status}`);
  const j = await res.json();
  return j.data.map((d: { embedding: number[] }) => d.embedding);
}

async function chat(system: string, user: string): Promise<{ answer: string; grounded: boolean }> {
  const res = await fetch(`${Deno.env.get("LLM_BASE_URL") ?? "https://api.openai.com/v1"}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}` },
    body: JSON.stringify({
      model: Deno.env.get("LLM_MODEL") ?? "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`llm failed ${res.status}`);
  const j = await res.json();
  try {
    const p = JSON.parse(j.choices[0].message.content);
    return { answer: String(p.answer ?? "").trim(), grounded: Boolean(p.grounded) };
  } catch {
    return { answer: "", grounded: false };
  }
}

async function sendWa(to: string, text: string, fromPhoneId: string): Promise<void> {
  const res = await fetch(
    `https://graph.facebook.com/v20.0/${fromPhoneId}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${Deno.env.get("WA_ACCESS_TOKEN")}` },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
    }
  );
  if (!res.ok) throw new Error(`wa send ${res.status}: ${await res.text()}`);
}

const REFUSAL =
  "عذرًا، ما عندي معلومات مؤكدة عن هذا الموضوع. لو تحتاج شيء ثاني أنا موجود، وأقدر أحوّلك لأحد الموظفين لو حبيت.";
const HANDOFF = "وصلتني رسالتك، وحوّلت محادثتك لأحد الموظفين — بيرد عليك في أقرب وقت إن شاء الله.";
const HANDOFF_RE = /(بشري|إنسان|موظف|مسؤول|مدير|شكوى|شكاوى|استرجاع|استرداد|تعويض)/;

async function handleIncoming(
  tenantId: string,
  from: string,
  text: string,
  waId: string | null,
  sendFromPhoneId: string
) {
  const sb = supabase();
  const { data: tenant } = await sb.from("tenants").select("*").eq("id", tenantId).maybeSingle();
  if (!tenant || !tenant.is_active) return;

  // حماية من التكرار (Meta يعيد الإرسال عند البطء)
  if (waId) {
    const { data: dup } = await sb.from("messages").select("id").eq("wa_message_id", waId).maybeSingle();
    if (dup) return;
  }

  // المحادثة
  let { data: conv } = await sb
    .from("conversations")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("wa_chat_id", from)
    .maybeSingle();
  if (!conv) {
    const ins = await sb
      .from("conversations")
      .insert({ tenant_id: tenantId, wa_chat_id: from, customer_phone_encrypted: await encryptField(from) })
      .select()
      .single();
    conv = ins.data;
  } else {
    await sb.from("conversations").update({ last_message_at: new Date().toISOString() }).eq("id", conv.id);
  }

  await sb.from("messages").insert({
    conversation_id: conv.id,
    tenant_id: tenantId,
    direction: "in",
    body_encrypted: await encryptField(text),
    kind: "customer",
    is_auto: false,
    wa_message_id: waId,
  });

  if (conv.transferred || conv.auto_paused_reason === "credits" || tenant.credits_remaining <= 0) {
    if (tenant.credits_remaining <= 0 && !conv.auto_paused_reason) {
      await sb.from("conversations").update({ auto_paused_reason: "credits" }).eq("id", conv.id);
    }
    return;
  }

  let kind: "answer" | "refusal" | "handoff" = "answer";
  let reply = "";
  let best = 0;

  if (HANDOFF_RE.test(text)) {
    kind = "handoff";
    reply = HANDOFF;
  } else {
    // استرجاع دلالي (تشابه وليس كلمات) ثم توليد مقيّد بالسياق
    const [qv] = await embed([text]);
    const { data: hits } = await sb.rpc("match_knowledge", {
      p_tenant_id: tenantId,
      p_query: `[${qv.join(",")}]`,
      p_limit: Number(Deno.env.get("RAG_TOP_K") ?? 5),
      p_threshold: 0,
    });
    const matches = (hits ?? []) as { content: string; similarity: number }[];
    best = matches[0]?.similarity ?? 0;
    const threshold = Number(Deno.env.get("SIMILARITY_THRESHOLD") ?? 0.25);

    if (!matches.length || best < threshold) {
      kind = "refusal";
      reply = REFUSAL;
    } else {
      const context = matches.map((m, i) => `[${i + 1}] ${m.content}`).join("\n");
      const system = [
        `أنت موظف خدمة عملاء لمشروع «${tenant.business_name}» يرد عبر واتساب.`,
        "أجب بناءً على السياق المرفق فقط، وبنفس لهجة وأسلوب المحتوى المتوفر.",
        "إذا لم تجد إجابة كافية في السياق، قل صراحة إنك غير متأكد ولا تختلق معلومة.",
        "الرد قصير (جملتان بحد أقصى) بلهجة سعودية مهذبة.",
        'أعد JSON فقط: {"answer":"...","grounded":true|false}',
      ].join("\n");
      const g = await chat(system, `<context>\n${context}\n</context>\n\nسؤال العميل:\n${text}`);
      if (g.grounded && g.answer) reply = g.answer;
      else {
        kind = "refusal";
        reply = REFUSAL;
      }
    }
  }

  await sendWa(from, reply, sendFromPhoneId);

  const out = await sb
    .from("messages")
    .insert({
      conversation_id: conv.id,
      tenant_id: tenantId,
      direction: "out",
      body_encrypted: await encryptField(reply),
      kind,
      is_auto: true,
    })
    .select()
    .single();

  if (out.data) await sb.rpc("consume_reply", { p_tenant_id: tenantId, p_message_id: out.data.id });
  if (kind === "handoff") await sb.from("conversations").update({ transferred: true }).eq("id", conv.id);
  if (kind === "refusal") {
    await sb.from("unresolved_questions").insert({
      tenant_id: tenantId,
      conversation_id: conv.id,
      question_encrypted: await encryptField(text),
      best_similarity: best,
    });
  }
}

Deno.serve(async (req) => {
  // تحقق Meta من الـ webhook
  if (req.method === "GET") {
    const u = new URL(req.url);
    if (
      u.searchParams.get("hub.mode") === "subscribe" &&
      u.searchParams.get("hub.verify_token") === Deno.env.get("WA_VERIFY_TOKEN")
    ) {
      return new Response(u.searchParams.get("hub.challenge"), { status: 200 });
    }
    return new Response("forbidden", { status: 403 });
  }

  try {
    const body = await req.json();

    // فحص الحالة من الواجهة: هل رُبط رقم منصة لهذا العميل؟
    if (body?.action === "ping") {
      const sb = supabase();
      const { data: b } = await sb
        .from("wa_bindings")
        .select("phone_id")
        .eq("tenant_id", body.tenantId ?? "")
        .maybeSingle();
      return Response.json({ ok: true, bound: Boolean(b), phoneId: b?.phone_id ?? null });
    }

    const value = body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    if (!msg || msg.type !== "text") return Response.json({ ok: true });

    // أي رقم مرتبط بهذا الـ phone number id؟ (multi-tenant)
    const phoneId: string = value?.metadata?.phone_number_id ?? Deno.env.get("WA_PHONE_NUMBER_ID") ?? "";
    const sb = supabase();
    const { data: binding } = await sb.from("wa_bindings").select("tenant_id").eq("phone_id", phoneId).maybeSingle();
    if (!binding) return Response.json({ ok: true, ignored: "no binding" });

    await handleIncoming(binding.tenant_id, msg.from, (msg.text?.body ?? "").trim(), msg.id ?? null, phoneId);
    return Response.json({ ok: true });
  } catch (e) {
    console.error("[wa-webhook]", e);
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});
