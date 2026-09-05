/**
 * ميلانو — الباك-إند الكامل على Supabase Edge Function واحدة.
 * يُستدعى: POST {SUPABASE_URL}/functions/v1/milan-api?action=<الإجراء>
 *
 * الإجراءات:
 *  عامة:      create_tenant
 *  برمz الجلسة: bind_number, wa_status, qa_extract, qa_save, ingest_text, qa_test
 *  بحساب:    claim_account, summary, conversations, messages, reply,
 *             unresolved, resolve, knowledge, knowledge_add, knowledge_delete, pay_create
 *  علنية موقّعة: pay_webhook
 */
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import * as cheerio from "npm:cheerio@1";

const enc = new TextEncoder();
const dec = new TextDecoder();
const hex = (b: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(b instanceof Uint8Array ? b.buffer : b)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");

const env = (k: string) => Deno.env.get(k) ?? "";
const sbAdmin = (): SupabaseClient => createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-tenant-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...CORS, "content-type": "application/json" } });
const err = (m: string, s = 400) => json({ error: m }, s);

/* ─── تشفير حقلي (متوافق مع صيغة الخادم) ─── */
async function aesKey(mode: "encrypt" | "decrypt") {
  const mat = await crypto.subtle.digest("SHA-256", enc.encode(env("FIELD_ENCRYPTION_KEY")));
  return crypto.subtle.importKey("raw", mat, "AES-GCM", false, [mode]);
}
async function encryptField(plain: string): Promise<string> {
  if (!plain) return "";
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey("encrypt"), enc.encode(plain)));
  return `enc:v1:${hex(iv)}:${hex(ct.slice(-16))}:${hex(ct.slice(0, -16))}`;
}
async function decryptField(stored: string | null | undefined): Promise<string> {
  if (!stored) return "";
  if (!stored.startsWith("enc:v1:")) return stored;
  const [, , ivH, tagH, dataH] = stored.split(":");
  const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
  const buf = new Uint8Array(fromHex(dataH).length + 16);
  buf.set(fromHex(dataH), 0);
  buf.set(fromHex(tagH), fromHex(dataH).length);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromHex(ivH) as BufferSource }, await aesKey("decrypt"), buf as BufferSource);
  return dec.decode(pt);
}

/* ─── مصادقة ─── */
async function userOf(req: Request, sb: SupabaseClient) {
  const h = req.headers.get("authorization") ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return null;
  const { data } = await sb.auth.getUser(token);
  return data.user ?? null;
}
function claimOf(req: Request) {
  return req.headers.get("x-tenant-token") ?? "";
}
async function tenantByClaim(sb: SupabaseClient, req: Request, tenantId: string) {
  const { data } = await sb.from("tenants").select("*").eq("id", tenantId).maybeSingle();
  if (!data || data.claim_token !== claimOf(req)) return null;
  return data;
}
async function ownedTenant(sb: SupabaseClient, req: Request) {
  const u = await userOf(req, sb);
  if (!u) return null;
  const { data } = await sb.from("tenants").select("*").eq("user_id", u.id).maybeSingle();
  return data;
}

/* ─── LLM / Embeddings ─── */
async function embed(texts: string[]): Promise<number[][]> {
  const res = await fetch(`${env("EMBED_BASE_URL") || "https://api.openai.com/v1"}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env("OPENAI_API_KEY")}` },
    body: JSON.stringify({ model: env("EMBED_MODEL") || "text-embedding-3-small", input: texts }),
  });
  if (!res.ok) throw new Error(`embedding ${res.status}`);
  const j = await res.json();
  return j.data.map((d: { embedding: number[] }) => d.embedding);
}
const pg = (v: number[]) => `[${v.join(",")}]`;

async function chatJSON(system: string, user: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${env("LLM_BASE_URL") || "https://api.openai.com/v1"}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env("OPENAI_API_KEY")}` },
    body: JSON.stringify({
      model: env("LLM_MODEL") || "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(`llm ${res.status}`);
  const j = await res.json();
  try {
    return JSON.parse(j.choices[0].message.content);
  } catch {
    return {};
  }
}

/* ─── استخراج نص صفحة ─── */
async function extractFromUrl(url: string): Promise<{ title: string; text: string }> {
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0 Safari/537.36" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`تعذر فتح الرابط (HTTP ${res.status})`);
  const raw = await res.text();
  const $ = cheerio.load(raw);
  $("script,style,noscript,nav,footer,header,aside,iframe,svg,form").remove();
  const title = ($("title").first().text() || url).trim().slice(0, 200);
  const text = ($("main").first().text() || $("article").first().text() || $("body").text())
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40_000);
  return { title, text };
}

function chunkText(text: string, size = 700, overlap = 120): string[] {
  const parts = text.split(/\n{2,}|\s{2,}/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let buf = "";
  for (const p of parts) {
    if ((buf + " " + p).length > size) {
      if (buf.trim().length > 30) out.push(buf.trim());
      buf = (buf.slice(-overlap) + " " + p).trim();
    } else buf = (buf + "\n" + p).trim();
  }
  if (buf.trim().length > 30) out.push(buf.trim());
  return out;
}

const QA_SYSTEM = `أنت محلل محتوى لمشاريع تجارية. من النص المرفق ولّد أسئلة وأجوبة قد يسألها عميل حقيقي عبر واتساب.
قواعد:
- أجوبة من النص فقط — لا تختلق أسعارًا أو مواعيد أو معلومات غير موجودة.
- الأسئلة بلهجة عميل عادي (مثال: «بكم السبانش لاتيه؟»)، والأجوبة واضحة ومباشرة.
- غطِّ: الأسعار، المواعيد، الموقع، الخدمات، التواصل، الاسترجاع.
- 5 إلى 12 زوجًا كحد أقصى.
أعد JSON فقط: {"pairs":[{"question":"...","answer":"..."}]}`;

/* ─── إرسال واتساب (Cloud API) ─── */
async function sendWa(phoneId: string, to: string, text: string) {
  const res = await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env("WA_ACCESS_TOKEN")}` },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
  });
  if (!res.ok) throw new Error(`wa send ${res.status}: ${await res.text()}`);
}
async function boundPhone(sb: SupabaseClient, tenantId: string): Promise<string | null> {
  const { data } = await sb.from("wa_bindings").select("phone_id").eq("tenant_id", tenantId).maybeSingle();
  return data?.phone_id ?? null;
}

/* ═══════════ المعالج ═══════════ */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const action = new URL(req.url).searchParams.get("action") ?? "";
  const raw = await req.text();
  let body: Record<string, any> = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return err("JSON غير صالح");
  }
  const sb = sbAdmin();

  try {
    switch (action) {
      /* ── عام ── */
      case "create_tenant": {
        const { businessName, sourceType, sourceUrl, phoneE164 } = body;
        if (!businessName?.trim() || !["gmaps", "website", "manual"].includes(sourceType)) return err("بيانات ناقصة");
        const phone = typeof phoneE164 === "string" && /^\+\d{7,15}$/.test(phoneE164) ? phoneE164 : null;
        const { data, error } = await sb
          .from("tenants")
          .insert({
            business_name: businessName.trim().slice(0, 120),
            source_type: sourceType,
            source_url: sourceUrl ?? null,
            business_phone_encrypted: phone ? await encryptField(phone) : null,
            credits_remaining: 0,
            is_active: false,
          })
          .select("id, claim_token")
          .single();
        if (error || !data) return err(error?.message ?? "خطأ", 500);
        return json({ tenantId: data.id, claimToken: data.claim_token });
      }

      case "pay_webhook": {
        const sig = req.headers.get("moyasar-signature") ?? "";
        const expected = hex(
          await crypto.subtle.sign(
            "HMAC",
            await crypto.subtle.importKey("raw", enc.encode(env("MOYASAR_WEBHOOK_SECRET")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
            enc.encode(raw)
          )
        );
        if (!sig || sig !== expected) return err("توقيع غير صالح", 401);
        const ev = body;
        const type: string = ev.type ?? "";
        const invoiceId: string = ev.data?.invoice_id ?? ev.data?.id;
        if (!invoiceId || !/paid|succeeded/.test(type)) return json({ received: true });
        const { data: payment } = await sb.from("payments").select("*").eq("invoice_id", invoiceId).maybeSingle();
        if (!payment || payment.status === "paid") return json({ received: true });
        const credits = { 9900: 1000, 24900: 3000, 64900: 10000 }[payment.amount] ?? 1000;
        await sb.from("payments").update({ status: "paid", credits_granted: credits, webhook_event: ev, paid_at: new Date().toISOString() }).eq("id", payment.id);
        await sb.rpc("grant_credits", { p_tenant_id: payment.tenant_id, p_credits: credits });
        return json({ received: true, activated: true });
      }
    }

    /* ── إجراءات رمز الجلسة (claim) ── */
    const claimActions = ["bind_number", "wa_status", "qa_extract", "qa_save", "ingest_text", "qa_test"];
    if (claimActions.includes(action)) {
      const tenant = await tenantByClaim(sb, req, body.tenantId ?? "");
      if (!tenant) return err("رمز الجلسة غير صالح", 403);

      switch (action) {
        case "bind_number": {
          const phoneId = String(body.phoneId ?? "").trim();
          if (!/^\d{6,20}$/.test(phoneId)) return err("Phone Number ID غير صالح — خذه من Meta → WhatsApp → API Setup");
          await sb.from("wa_bindings").upsert({ phone_id: phoneId, tenant_id: tenant.id }, { onConflict: "phone_id" });
          return json({ ok: true });
        }
        case "wa_status": {
          const phoneId = await boundPhone(sb, tenant.id);
          return json({ bound: Boolean(phoneId), phoneId });
        }
        case "qa_extract": {
          const url = String(body.url ?? "");
          if (!/^https?:\/\/\S+\.\S+/.test(url)) return err("الرابط غير صالح");
          const { title, text } = await extractFromUrl(url);
          if (text.length < 40) return err("المحتوى المستخرج غير كافٍ — جرّب الإدخال اليدوي", 502);
          const out = await chatJSON(QA_SYSTEM, `<website_content>\n${text}\n</website_content>`);
          const pairs = (Array.isArray(out.pairs) ? out.pairs : [])
            .filter((p: any) => p?.question?.trim() && p?.answer?.trim())
            .map((p: any) => ({ question: String(p.question).trim(), answer: String(p.answer).trim() }))
            .slice(0, 15);
          if (!pairs.length) return err("تعذر توليد الأسئلة — المحتوى قد لا يحوي معلومات كافية", 502);
          return json({ pairs, title });
        }
        case "qa_save": {
          const pairs = (Array.isArray(body.pairs) ? body.pairs : [])
            .filter((p: any) => p?.question?.trim() && p?.answer?.trim());
          if (!pairs.length) return err("القائمة فارغة");
          const src = await sb.from("knowledge_sources").insert({ tenant_id: tenant.id, kind: "qa", url: body.sourceUrl ?? null, status: "indexed", chunks_count: pairs.length }).select().single();
          const contents = pairs.map((p: any) => `س: ${p.question.trim()}\nج: ${p.answer.trim()}`);
          const vectors = await embed(contents);
          await sb.from("knowledge_chunks").insert(
            contents.map((content: string, i: number) => ({ tenant_id: tenant.id, source_id: src.data.id, chunk_index: i, content, embedding: pg(vectors[i]) }))
          );
          return json({ saved: pairs.length, sourceId: src.data.id });
        }
        case "ingest_text": {
          const text = String(body.text ?? "").trim();
          if (text.length < 20) return err("النص قصير جدًا");
          const chunks = chunkText(text);
          const vectors = await embed(chunks);
          const src = await sb.from("knowledge_sources").insert({ tenant_id: tenant.id, kind: "manual", status: "indexed", chunks_count: chunks.length, raw_text_encrypted: await encryptField(text) }).select().single();
          await sb.from("knowledge_chunks").insert(
            chunks.map((content, i) => ({ tenant_id: tenant.id, source_id: src.data.id, chunk_index: i, content, embedding: pg(vectors[i]) }))
          );
          return json({ chunks: chunks.length });
        }
        case "qa_test": {
          const text = String(body.text ?? "").trim();
          if (!text) return err("اكتب صياغة لتجربتها");
          const [qv] = await embed([text]);
          const { data: hits } = await sb.rpc("match_knowledge", { p_tenant_id: tenant.id, p_query: pg(qv), p_limit: Number(env("RAG_TOP_K") || 5), p_threshold: 0 });
          const matches = ((hits ?? []) as { id: string; content: string; similarity: number }[]).map((h) => ({ id: h.id, content: h.content, similarity: Math.round(h.similarity * 1000) / 1000 }));
          const best = matches[0]?.similarity ?? 0;
          const threshold = Number(env("SIMILARITY_THRESHOLD") || 0.25);
          if (!matches.length || best < threshold) {
            return json({ confident: false, bestSimilarity: best, threshold, matches, answer: null });
          }
          const g = await chatJSON(
            [
              `أنت موظف خدمة عملاء لمشروع «${tenant.business_name}» يرد عبر واتساب.`,
              "أجب بناءً على السياق المرفق فقط، وبنفس لهجة وأسلوب المحتوى المتوفر.",
              "إذا لم تجد إجابة كافية قل صراحة إنك غير متأكد ولا تختلق.",
              'أعد JSON فقط: {"answer":"...","grounded":true|false}',
            ].join("\n"),
            `<context>\n${matches.map((m, i) => `[${i + 1}] ${m.content}`).join("\n")}\n</context>\n\nسؤال العميل:\n${text}`
          );
          const answer = String(g.answer ?? "").trim();
          const confident = Boolean(g.grounded) && answer.length > 0;
          return json({ confident, bestSimilarity: best, threshold, matches, answer: confident ? answer : null });
        }
      }
    }

    /* ── إجراءات الحساب الموثق (Supabase Auth) ── */
    const u = await userOf(req, sb);
    if (!u) return err("غير مصرح", 401);

    switch (action) {
      case "claim_account": {
        const { claimToken } = body;
        if (!claimToken) return err("رمز الضم ناقص");
        const { data } = await sb.from("tenants").update({ user_id: u.id }).eq("claim_token", claimToken).is("user_id", null).select("id").maybeSingle();
        if (!data) return err("رمز غير صالح أو مستخدم", 404);
        return json({ tenantId: data.id });
      }
    }

    const tenant = await ownedTenant(sb, req);
    if (!tenant) return err("لا يوجد حساب مرتبط — أنشئ موظفًا من الصفحة الرئيسية أولاً", 404);

    switch (action) {
      case "summary": {
        const [oq, cc] = await Promise.all([
          sb.from("unresolved_questions").select("id", { count: "exact", head: true }).eq("tenant_id", tenant.id).eq("status", "open"),
          sb.from("conversations").select("id", { count: "exact", head: true }).eq("tenant_id", tenant.id),
        ]);
        const phoneId = await boundPhone(sb, tenant.id);
        return json({
          tenant: { id: tenant.id, businessName: tenant.business_name, isActive: tenant.is_active, creditsRemaining: tenant.credits_remaining, phone: null },
          wa: { status: phoneId ? "connected" : "disconnected", cloudApi: true, phoneId },
          openUnresolved: oq.count ?? 0,
          conversations: cc.count ?? 0,
        });
      }
      case "conversations": {
        const { data } = await sb.from("conversations").select("id, customer_phone_encrypted, transferred, auto_paused_reason, last_message_at").eq("tenant_id", tenant.id).order("last_message_at", { ascending: false }).limit(50);
        const rows = [];
        for (const c of data ?? []) {
          rows.push({ id: c.id, customerPhone: await decryptField(c.customer_phone_encrypted), transferred: c.transferred, autoPausedReason: c.auto_paused_reason, lastMessageAt: c.last_message_at });
        }
        return json(rows);
      }
      case "messages": {
        const { data } = await sb.from("messages").select("id,direction,body_encrypted,kind,is_auto,created_at").eq("tenant_id", tenant.id).eq("conversation_id", body.convId ?? "").order("created_at").limit(200);
        const rows = [];
        for (const m of data ?? []) rows.push({ ...m, body: await decryptField(m.body_encrypted) });
        return json(rows);
      }
      case "reply": {
        const { convId, text, resumeAuto } = body;
        if (!text?.trim()) return err("نص الرد فارغ");
        const { data: conv } = await sb.from("conversations").select("*").eq("id", convId ?? "").eq("tenant_id", tenant.id).maybeSingle();
        if (!conv) return err("المحادثة غير موجودة", 404);
        const phoneId = await boundPhone(sb, tenant.id);
        if (!phoneId) return err("واتساب غير مربوط — اربط رقم المنصة أولاً", 400);
        await sendWa(phoneId, conv.wa_chat_id, text.trim());
        await sb.from("messages").insert({ conversation_id: conv.id, tenant_id: tenant.id, direction: "out", body_encrypted: await encryptField(text.trim()), kind: "manual", is_auto: false });
        const patch: Record<string, unknown> = { last_message_at: new Date().toISOString() };
        if (resumeAuto) Object.assign(patch, { transferred: false, auto_paused_reason: null });
        await sb.from("conversations").update(patch).eq("id", conv.id);
        return json({ ok: true });
      }
      case "unresolved": {
        const { data } = await sb.from("unresolved_questions").select("id, question_encrypted, status, manual_answer, added_to_kb, created_at, conversation_id, best_similarity").eq("tenant_id", tenant.id).order("created_at", { ascending: false }).limit(100);
        const rows = [];
        for (const q of data ?? []) {
          rows.push({ id: q.id, question: await decryptField(q.question_encrypted), status: q.status, manualAnswer: q.manual_answer, addedToKb: q.added_to_kb, createdAt: q.created_at, conversationId: q.conversation_id, bestSimilarity: q.best_similarity ?? null });
        }
        return json(rows);
      }
      case "resolve": {
        const { id, answer, saveToKb, sendToCustomer } = body;
        if (!answer?.trim()) return err("الإجابة فارغة");
        const { data: q } = await sb.from("unresolved_questions").select("*").eq("id", id ?? "").eq("tenant_id", tenant.id).maybeSingle();
        if (!q) return err("السؤال غير موجود", 404);
        if (saveToKb) {
          const question = await decryptField(q.question_encrypted);
          const content = `س: ${question}\nج: ${answer.trim()}`;
          const [v] = await embed([content]);
          await sb.from("knowledge_chunks").insert({ tenant_id: tenant.id, source_id: null, chunk_index: 0, content, embedding: pg(v) });
        }
        await sb.from("unresolved_questions").update({ status: "resolved", manual_answer: answer.trim(), added_to_kb: Boolean(saveToKb), resolved_at: new Date().toISOString() }).eq("id", q.id);
        if (sendToCustomer && q.conversation_id) {
          const { data: conv } = await sb.from("conversations").select("wa_chat_id").eq("id", q.conversation_id).maybeSingle();
          const phoneId = await boundPhone(sb, tenant.id);
          if (conv && phoneId) {
            try {
              await sendWa(phoneId, conv.wa_chat_id, answer.trim());
              await sb.from("messages").insert({ conversation_id: q.conversation_id, tenant_id: tenant.id, direction: "out", body_encrypted: await encryptField(answer.trim()), kind: "manual", is_auto: false });
            } catch { /* الواتساب غير متاح — تُحفظ الإجابة */ }
          }
        }
        return json({ ok: true });
      }
      case "knowledge": {
        const { data } = await sb.from("knowledge_sources").select("id, kind, url, status, error, chunks_count, created_at").eq("tenant_id", tenant.id).order("created_at", { ascending: false });
        return json(data ?? []);
      }
      case "knowledge_add": {
        const { url, text } = body;
        if (url?.trim()) {
          const { title, text: raw2 } = await extractFromUrl(url.trim());
          if (raw2.length < 40) return err("المحتوى غير كافٍ", 502);
          const chunks = chunkText(raw2);
          const vectors = await embed(chunks);
          const src = await sb.from("knowledge_sources").insert({ tenant_id: tenant.id, kind: "website", url: url.trim(), status: "indexed", chunks_count: chunks.length }).select().single();
          await sb.from("knowledge_chunks").insert(chunks.map((content, i) => ({ tenant_id: tenant.id, source_id: src.data.id, chunk_index: i, content, embedding: pg(vectors[i]) })));
          return json({ status: "indexed", chunks: chunks.length, title });
        }
        const t = String(text ?? "").trim();
        if (t.length < 20) return err("النص قصير جدًا");
        const chunks = chunkText(t);
        const vectors = await embed(chunks);
        const src = await sb.from("knowledge_sources").insert({ tenant_id: tenant.id, kind: "manual", status: "indexed", chunks_count: chunks.length, raw_text_encrypted: await encryptField(t) }).select().single();
        await sb.from("knowledge_chunks").insert(chunks.map((content, i) => ({ tenant_id: tenant.id, source_id: src.data.id, chunk_index: i, content, embedding: pg(vectors[i]) })));
        return json({ status: "indexed", chunks: chunks.length });
      }
      case "knowledge_delete": {
        await sb.from("knowledge_sources").delete().eq("id", body.sourceId ?? "").eq("tenant_id", tenant.id);
        return json({ ok: true });
      }
      case "pay_create": {
        const packages: Record<string, { name: string; credits: number; amount: number }> = {
          starter: { name: "باقة البداية", credits: 1000, amount: 9900 },
          growth: { name: "باقة النمو", credits: 3000, amount: 24900 },
          scale: { name: "باقة التوسع", credits: 10000, amount: 64900 },
        };
        const p = packages[body.packageId] ?? packages.starter;
        const res = await fetch("https://api.moyasar.com/v1/invoices", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Basic ${btoa(env("MOYASAR_SECRET_KEY") + ":")}` },
          body: JSON.stringify({
            amount: p.amount, currency: "SAR",
            description: `ميلانو — ${p.name} (${p.credits} رد) — ${tenant.business_name}`,
            callback_url: `${env("SUPABASE_URL")}/functions/v1/milan-api?action=pay_webhook`,
            metadata: { tenant_id: tenant.id },
          }),
        });
        if (!res.ok) return err(`Moyasar ${res.status}: ${await res.text()}`, 502);
        const inv: any = await res.json();
        await sb.from("payments").insert({ tenant_id: tenant.id, provider: "moyasar", invoice_id: inv.id, amount: p.amount, currency: "SAR", status: "created", credits_granted: 0 });
        return json({ invoiceId: inv.id, paymentUrl: inv.transaction?.url ?? inv.url ?? null });
      }
    }

    return err(`إجراء غير معروف: ${action}`, 404);
  } catch (e) {
    console.error(`[milan-api:${action}]`, e);
    return err(e instanceof Error ? e.message : "خطأ داخلي", 500);
  }
});
