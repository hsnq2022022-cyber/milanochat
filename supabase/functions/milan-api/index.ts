/**
 * ميلانو — الباك-إند الكامل على Supabase Edge Function واحدة.
 *
 * الوظائف:
 * عامة:
 *   create_tenant
 *
 * برمز الجلسة:
 *   bind_number
 *   wa_status
 *   qa_extract
 *   qa_save
 *   ingest_text
 *   qa_test
 *
 * بالحساب:
 *   claim_account
 *   summary
 *   conversations
 *   messages
 *   reply
 *   unresolved
 *   resolve
 *   knowledge
 *   knowledge_add
 *   knowledge_delete
 *   pay_create
 *
 * Widget:
 *   widget_public
 *   widget_session
 *   widget_message
 *
 * Pay:
 *   pay_webhook
 *
 * الاستدعاء:
 * POST {SUPABASE_URL}/functions/v1/milan-api?action=<الإجراء>
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

const sbAdmin = (): SupabaseClient =>
  createClient(
    env("SUPABASE_URL"),
    env("SUPABASE_SERVICE_ROLE_KEY")
  );

/* ═══════════════════════════════════════════════════════════════════════
   HTTP
═══════════════════════════════════════════════════════════════════════ */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-tenant-token",
  "Access-Control-Allow-Methods":
    "GET, POST, PUT, DELETE, OPTIONS",
};

const json = (
  d: unknown,
  s = 200,
  extraHeaders: Record<string, string> = {}
) =>
  new Response(JSON.stringify(d), {
    status: s,
    headers: {
      ...CORS,
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });

const err = (m: string, s = 400) =>
  json({ error: m }, s);

/* ═══════════════════════════════════════════════════════════════════════
   تشفير حقلي
═══════════════════════════════════════════════════════════════════════ */

async function aesKey(mode: "encrypt" | "decrypt") {
  const mat = await crypto.subtle.digest(
    "SHA-256",
    enc.encode(env("FIELD_ENCRYPTION_KEY"))
  );

  return crypto.subtle.importKey(
    "raw",
    mat,
    "AES-GCM",
    false,
    [mode]
  );
}

async function encryptField(plain: string): Promise<string> {
  if (!plain) return "";

  const iv = crypto.getRandomValues(new Uint8Array(12));

  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
      },
      await aesKey("encrypt"),
      enc.encode(plain)
    )
  );

  return `enc:v1:${hex(iv)}:${hex(
    ct.slice(-16)
  )}:${hex(ct.slice(0, -16))}`;
}

async function decryptField(
  stored: string | null | undefined
): Promise<string> {
  if (!stored) return "";

  if (!stored.startsWith("enc:v1:")) {
    return stored;
  }

  const [, , ivH, tagH, dataH] = stored.split(":");

  const fromHex = (h: string) =>
    Uint8Array.from(
      h.match(/../g)!.map((x) => parseInt(x, 16))
    );

  const data = fromHex(dataH);
  const tag = fromHex(tagH);

  const buf = new Uint8Array(data.length + 16);

  buf.set(data, 0);
  buf.set(tag, data.length);

  const pt = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromHex(ivH) as BufferSource,
    },
    await aesKey("decrypt"),
    buf as BufferSource
  );

  return dec.decode(pt);
}

/* ═══════════════════════════════════════════════════════════════════════
   المصادقة
═══════════════════════════════════════════════════════════════════════ */

async function userOf(
  req: Request,
  sb: SupabaseClient
) {
  const h = req.headers.get("authorization") ?? "";

  const token = h.startsWith("Bearer ")
    ? h.slice(7)
    : "";

  if (!token) return null;

  const { data } = await sb.auth.getUser(token);

  return data.user ?? null;
}

function claimOf(req: Request) {
  return req.headers.get("x-tenant-token") ?? "";
}

async function tenantByClaim(
  sb: SupabaseClient,
  req: Request,
  tenantId: string
) {
  const { data } = await sb
    .from("tenants")
    .select("*")
    .eq("id", tenantId)
    .maybeSingle();

  if (!data) return null;

  if (data.claim_token !== claimOf(req)) {
    return null;
  }

  return data;
}

async function ownedTenant(
  sb: SupabaseClient,
  req: Request
) {
  const u = await userOf(req, sb);

  if (!u) return null;

  const { data } = await sb
    .from("tenants")
    .select("*")
    .eq("user_id", u.id)
    .maybeSingle();

  return data;
}

/* ═══════════════════════════════════════════════════════════════════════
   LLM / EMBEDDINGS
═══════════════════════════════════════════════════════════════════════ */

/**
 * مفتاح مزوّد الذكاء الاصطناعي. يقبل عدة أسماء للسر:
 * - للـ embeddings: EMBED_API_KEY ثم GEMINI_API_KEY ثم LLM_API_KEY
 * - للمحادثة:      LLM_API_KEY ثم GEMINI_API_KEY ثم EMBED_API_KEY
 * ويرجع احتياطياً إلى OPENAI_API_KEY.
 */
function aiKey(kind: "embed" | "llm" = "llm"): string {
  const order =
    kind === "embed"
      ? ["EMBED_API_KEY", "GEMINI_API_KEY", "LLM_API_KEY"]
      : ["LLM_API_KEY", "GEMINI_API_KEY", "EMBED_API_KEY"];

  for (const k of [...order, "OPENAI_API_KEY"]) {
    const v = env(k).trim();
    if (v) return v;
  }

  return "";
}

async function embed(
  texts: string[]
): Promise<number[][]> {
  const res = await fetch(
    `${
      env("EMBED_BASE_URL") ||
      "https://api.openai.com/v1"
    }/embeddings`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${aiKey("embed")}`,
      },
      body: JSON.stringify({
        model:
          env("EMBED_MODEL") ||
          "text-embedding-3-small",
        input: texts,
      }),
    }
  );

  if (!res.ok) {
    throw new Error(
      `embedding ${res.status}: ${await res.text()}`
    );
  }

  const j = await res.json();

  return j.data.map(
    (d: { embedding: number[] }) => d.embedding
  );
}

const pg = (v: number[]) =>
  `[${v.join(",")}]`;

async function chatJSON(
  system: string,
  user: string
): Promise<Record<string, unknown>> {
  const res = await fetch(
    `${
      env("LLM_BASE_URL") ||
      "https://api.openai.com/v1"
    }/chat/completions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${aiKey()}`,
      },
      body: JSON.stringify({
        model:
          env("LLM_MODEL") ||
          "gpt-4o-mini",

        response_format: {
          type: "json_object",
        },

        messages: [
          {
            role: "system",
            content: system,
          },
          {
            role: "user",
            content: user,
          },
        ],
      }),
    }
  );

  if (!res.ok) {
    throw new Error(
      `llm ${res.status}: ${await res.text()}`
    );
  }

  const j = await res.json();

  try {
    return JSON.parse(
      j.choices?.[0]?.message?.content ?? "{}"
    );
  } catch {
    return {};
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   استخراج نص الموقع
═══════════════════════════════════════════════════════════════════════ */

async function extractFromUrl(
  url: string
): Promise<{
  title: string;
  text: string;
}> {
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
    },
    redirect: "follow",
  });

  if (!res.ok) {
    throw new Error(
      `تعذر فتح الرابط (HTTP ${res.status})`
    );
  }

  const raw = await res.text();

  const $ = cheerio.load(raw);

  $(
    "script,style,noscript,nav,footer,header,aside,iframe,svg,form"
  ).remove();

  const title = (
    $("title").first().text() ||
    url
  )
    .trim()
    .slice(0, 200);

  const text = (
    $("main").first().text() ||
    $("article").first().text() ||
    $("body").text()
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40_000);

  return {
    title,
    text,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   تقسيم النص
═══════════════════════════════════════════════════════════════════════ */

function chunkText(
  text: string,
  size = 700,
  overlap = 120
): string[] {
  const parts = text
    .split(/\n{2,}|\s{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const out: string[] = [];

  let buf = "";

  for (const p of parts) {
    if (
      (buf + " " + p).length >
      size
    ) {
      if (buf.trim().length > 30) {
        out.push(buf.trim());
      }

      buf = (
        buf.slice(-overlap) +
        " " +
        p
      ).trim();
    } else {
      buf = (
        buf +
        "\n" +
        p
      ).trim();
    }
  }

  if (buf.trim().length > 30) {
    out.push(buf.trim());
  }

  return out;
}

/* ═══════════════════════════════════════════════════════════════════════
   QA
═══════════════════════════════════════════════════════════════════════ */

const QA_SYSTEM = `
أنت محلل محتوى لمشاريع تجارية.
من النص المرفق ولّد أسئلة وأجوبة قد يسألها عميل حقيقي.

قواعد:
- أجوبة من النص فقط.
- لا تختلق أسعارًا.
- لا تختلق مواعيد.
- لا تختلق خدمات.
- لا تختلق معلومات غير موجودة.
- الأسئلة بلهجة عميل عادي.
- الأجوبة واضحة ومباشرة.
- غطِ الأسعار، المواعيد، الموقع، الخدمات، التواصل، والاسترجاع إن وجدت.
- 5 إلى 12 زوجًا كحد أقصى.

أعد JSON فقط:
{
  "pairs": [
    {
      "question": "...",
      "answer": "..."
    }
  ]
}
`;

/* ═══════════════════════════════════════════════════════════════════════
   واتساب
═══════════════════════════════════════════════════════════════════════ */

/**
 * توكن واتساب: يدعم الاسمين WA_ACCESS_TOKEN و WHATSAPP_ACCESS_TOKEN
 * (الأخير هو الاسم المستخدم في سيرفر Railway) مع تنظيف المسافات
 * وكلمة Bearer إن لُصقت بالخطأ.
 */
function waToken(): string {
  const raw =
    env("WA_ACCESS_TOKEN") ||
    env("WHATSAPP_ACCESS_TOKEN");

  return raw
    .trim()
    .replace(/^Bearer\s+/i, "")
    .replace(/^["']|["']$/g, "");
}

/**
 * خطأ مصادقة واتساب (توكن منتهي/غير صالح).
 */
class WaAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WaAuthError";
  }
}

async function sendWa(
  phoneId: string,
  to: string,
  text: string
) {
  const token = waToken();

  if (!token) {
    throw new WaAuthError(
      "توكن واتساب غير مضبوط: أضف WA_ACCESS_TOKEN في Supabase Edge Function Secrets"
    );
  }

  const res = await fetch(
    `https://graph.facebook.com/v21.0/${phoneId}/messages`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: {
          body: text,
        },
      }),
    }
  );

  if (!res.ok) {
    const raw = await res.text();

    let code: number | undefined;
    let fbMessage = "";

    try {
      const parsed = JSON.parse(raw);
      code = parsed?.error?.code;
      fbMessage = parsed?.error?.message ?? "";
    } catch {
      /* ليس JSON */
    }

    // 190 = توكن منتهي أو غير صالح، 102/104 = جلسة غير صالحة
    if (
      res.status === 401 ||
      code === 190 ||
      code === 102 ||
      code === 104
    ) {
      console.error(
        `[wa] auth failure (code ${code}): ${fbMessage}`
      );

      throw new WaAuthError(
        "توكن واتساب منتهي أو غير صالح (Meta code 190). " +
          "أنشئ توكن دائم عبر System User في Meta Business Settings " +
          "ثم حدّث WA_ACCESS_TOKEN في Supabase Secrets."
      );
    }

    throw new Error(`wa send ${res.status}: ${raw}`);
  }
}

async function boundPhone(
  sb: SupabaseClient,
  tenantId: string
): Promise<string | null> {
  const { data } = await sb
    .from("wa_bindings")
    .select("phone_id")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  return data?.phone_id ?? null;
}

/**
 * يرسل نصاً إلى محادثة عبر القناة الصحيحة:
 * - whatsapp  → sendWa (WA_ACCESS_TOKEN)
 * - instagram / facebook → sendMetaDirectMessage (توكن الحساب المشفّر في channel_accounts)
 */
async function sendToConversation(
  sb: SupabaseClient,
  tenantId: string,
  conv: any,
  text: string
): Promise<void> {
  const channel: string =
    conv?.channel ?? "whatsapp";

  if (channel === "instagram" || channel === "facebook") {
    if (!conv.account_id) {
      throw new Error(
        "حساب القناة غير مرتبط بهذه المحادثة"
      );
    }

    const { data: account } = await sb
      .from("channel_accounts")
      .select("id, external_id, access_token_encrypted")
      .eq("id", conv.account_id)
      .eq("tenant_id", tenantId)
      .maybeSingle();

    if (!account?.access_token_encrypted) {
      throw new Error(
        `لا يوجد توكن محفوظ لحساب ${channel} — أعد ربط الحساب`
      );
    }

    const token = await decryptField(
      account.access_token_encrypted
    );

    await sendMetaDirectMessage({
      channel: channel as "instagram" | "facebook",
      externalId: String(account.external_id),
      token,
      recipientId: String(conv.wa_chat_id)
        .split(":")
        .slice(1)
        .join(":"),
      text,
    });

    return;
  }

  const phoneId = await boundPhone(sb, tenantId);

  if (!phoneId) {
    throw new Error(
      "واتساب غير مربوط — اربط رقم المنصة أولاً"
    );
  }

  await sendWa(
    phoneId,
    String(conv.wa_chat_id).replace(/^whatsapp:/, ""),
    text
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Widget Helpers
═══════════════════════════════════════════════════════════════════════ */

/**
 * تحويل سجل Widget من snake_case إلى camelCase
 * لأن widget.js يستخدم camelCase.
 */
function widgetConfig(widget: any, tenant: any) {
  return {
    id: widget.id,
    name: widget.name,

    businessName:
      tenant?.business_name ??
      "",

    enabled:
      Boolean(widget.enabled),

    welcomeMessage:
      widget.welcome_message ??
      "مرحباً! كيف يمكنني مساعدتك؟",

    primaryColor:
      widget.primary_color ??
      "#2ec27e",

    position:
      widget.position === "right"
        ? "right"
        : "left",

    language:
      widget.language ??
      "ar",

    rtl:
      widget.rtl !== false,

    avatarUrl:
      widget.avatar_url ??
      null,

    showBranding:
      widget.show_branding !== false,

    placeholder:
      widget.placeholder ??
      "اكتب رسالتك...",

    suggestedQuestions:
      Array.isArray(widget.suggested_questions)
        ? widget.suggested_questions
        : [],

    publicToken:
      widget.public_token,
  };
}

/**
 * البحث عن Widget بواسطة public_token.
 *
 * هذه العملية عامة ولا تعتمد على auth.
 */
async function publicWidget(
  sb: SupabaseClient,
  token: string
) {
  if (!token) return null;

  const { data: widget } = await sb
    .from("widgets")
    .select("*")
    .eq("public_token", token)
    .eq("enabled", true)
    .maybeSingle();

  if (!widget) return null;

  const { data: tenant } = await sb
    .from("tenants")
    .select(
      "id,business_name,is_active,credits_remaining"
    )
    .eq("id", widget.tenant_id)
    .maybeSingle();

  if (!tenant) return null;

  return {
    widget,
    tenant,
  };
}

/**
 * إنشاء أو استرجاع جلسة Widget.
 */
async function getOrCreateWidgetSession(
  sb: SupabaseClient,
  widget: any,
  visitorId: string,
  visitorIp?: string | null,
  visitorUa?: string | null
) {
  const cleanVisitorId =
    String(visitorId || "")
      .trim()
      .slice(0, 200);

  if (!cleanVisitorId) {
    throw new Error(
      "visitorId مطلوب"
    );
  }

  const { data: existing } = await sb
    .from("widget_sessions")
    .select("*")
    .eq("widget_id", widget.id)
    .eq("visitor_id", cleanVisitorId)
    .maybeSingle();

  if (existing) {
    await sb
      .from("widget_sessions")
      .update({
        last_message_at:
          new Date().toISOString(),
      })
      .eq("id", existing.id);

    return existing;
  }

  const { data, error } = await sb
    .from("widget_sessions")
    .insert({
      widget_id: widget.id,
      tenant_id: widget.tenant_id,
      visitor_id: cleanVisitorId,
      visitor_ip:
        visitorIp
          ? String(visitorIp).slice(0, 100)
          : null,
      visitor_ua:
        visitorUa
          ? String(visitorUa).slice(0, 300)
          : null,
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(
      error?.message ||
        "تعذر إنشاء جلسة Widget"
    );
  }

  return data;
}

/**
 * جلب رسائل جلسة Widget.
 */
async function widgetMessages(
  sb: SupabaseClient,
  sessionId: string,
  tenantId: string
) {
  const { data, error } = await sb
    .from("widget_messages")
    .select(
      "id,direction,body,kind,created_at"
    )
    .eq("session_id", sessionId)
    .eq("tenant_id", tenantId)
    .order("created_at", {
      ascending: true,
    })
    .limit(200);

  if (error) {
    throw new Error(
      error.message
    );
  }

  return data ?? [];
}

/**
 * التأكد أن جلسة Widget تابعة فعلًا للـ Widget.
 */
async function widgetSession(
  sb: SupabaseClient,
  sessionId: string,
  widgetId: string,
  tenantId: string
) {
  const { data } = await sb
    .from("widget_sessions")
    .select("*")
    .eq("id", sessionId)
    .eq("widget_id", widgetId)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  return data;
}

/**
 * محرك RAG المشترك بين WhatsApp و Widget.
 */
async function answerFromKnowledge(
  sb: SupabaseClient,
  tenant: any,
  text: string,
  history = ""
): Promise<{
  answer: string | null;
  kind:
    | "answer"
    | "refusal"
    | "error";
  similarity: number;
}> {
  const [qv] = await embed([text]);

  const { data: hits, error } =
    await sb.rpc(
      "match_knowledge",
      {
        p_tenant_id:
          tenant.id,

        p_query:
          pg(qv),

        p_limit:
          Number(
            env("RAG_TOP_K") || 5
          ),

        p_threshold: 0,
      }
    );

  if (error) {
    throw new Error(
      `فشل البحث في قاعدة المعرفة: ${error.message}`
    );
  }

  const matches =
    (
      (hits ?? []) as {
        id: string;
        content: string;
        similarity: number;
      }[]
    ).map((h) => ({
      id: h.id,
      content: h.content,
      similarity:
        Number(h.similarity) || 0,
    }));

  const best =
    matches[0]?.similarity ?? 0;

  const threshold =
    Number(
      env("SIMILARITY_THRESHOLD") ||
        0.25
    );

  if (
    !matches.length ||
    best < threshold
  ) {
    return {
      answer: null,
      kind: "refusal",
      similarity: best,
    };
  }

  const context =
    matches
      .map(
        (m, i) =>
          `[${i + 1}] ${m.content}`
      )
      .join("\n");

  const g = await chatJSON(
    [
      `أنت موظف خدمة عملاء لمشروع «${tenant.business_name}».`,
      "أجب بناءً على السياق المرفق فقط.",
      "لا تستخدم أي معلومات خارج السياق.",
      "لا تخترع سعرًا أو منتجًا أو موعدًا أو سياسة.",
      "إذا لم تجد الإجابة في السياق، قل إنك غير متأكد.",
      "استخدم اللغة العربية المناسبة للعميل.",
      "اجعل الرد مختصرًا وواضحًا.",
      'أعد JSON فقط: {"answer":"...","grounded":true|false}',
    ].join("\n"),
    `
<context>
${context}
</context>

سؤال العميل:
${text}
${history ? `\nسياق المحادثة السابق:\n${history}\n` : ""}`
  );

  const answer =
    String(
      g.answer ?? ""
    ).trim();

  const grounded =
    Boolean(g.grounded) &&
    answer.length > 0;

  if (!grounded) {
    return {
      answer: null,
      kind: "refusal",
      similarity: best,
    };
  }

  return {
    answer,
    kind: "answer",
    similarity: best,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   Webhooks helpers (WhatsApp / Instagram)
═══════════════════════════════════════════════════════════════════════ */

/**
 * التحقق من توقيع Meta عبر x-hub-signature-256.
 * إذا لم يكن السر مضبوطًا نتجاهل التحقق (سلوك خادم Node السابق).
 */
async function verifyMetaSignature(
  raw: string,
  sigHeader: string
): Promise<boolean> {
  const secret =
    env("INSTAGRAM_APP_SECRET") ||
    env("META_APP_SECRET");

  if (!secret) return true;

  if (!sigHeader) return false;

  const expected =
    "sha256=" +
    hex(
      await crypto.subtle.sign(
        "HMAC",
        await crypto.subtle.importKey(
          "raw",
          enc.encode(secret),
          {
            name: "HMAC",
            hash: "SHA-256",
          },
          false,
          ["sign"]
        ),
        enc.encode(raw)
      )
    );

  return sigHeader === expected;
}

/**
 * استخراج كل الرسائل من entry — من كلا البنيتين
 * (Messenger-style و Instagram Login changes[].value).
 */
function extractIgMessages(entry: any): Array<{
  senderId: string;
  recipientId: string;
  text: string;
  mid: string | null;
}> {
  const out: Array<{
    senderId: string;
    recipientId: string;
    text: string;
    mid: string | null;
  }> = [];

  // ─── 1) البنية القديمة: entry.messaging[] ───

  if (Array.isArray(entry.messaging)) {
    for (const ev of entry.messaging) {
      if (!ev?.message || ev.message.is_echo) {
        continue;
      }

      const senderId = String(ev.sender?.id ?? "");
      const recipientId = String(ev.recipient?.id ?? "");

      const text =
        typeof ev.message.text === "string"
          ? ev.message.text
          : "";

      const mid =
        typeof ev.message.mid === "string"
          ? ev.message.mid
          : null;

      if (senderId && text) {
        out.push({
          senderId,
          recipientId,
          text,
          mid,
        });
      }
    }
  }

  // ─── 2) البنية الجديدة: entry.changes[].value ───

  if (Array.isArray(entry.changes)) {
    for (const change of entry.changes) {
      if (change?.field !== "messages") {
        continue;
      }

      const value = change.value;

      if (!value) {
        continue;
      }

      if (Array.isArray(value.messaging)) {
        for (const ev of value.messaging) {
          if (!ev?.message || ev.message.is_echo) {
            continue;
          }

          const senderId = String(
            ev.sender?.id ?? ""
          );

          const recipientId = String(
            ev.recipient?.id ?? ""
          );

          const text =
            typeof ev.message.text === "string"
              ? ev.message.text
              : "";

          const mid =
            typeof ev.message.mid === "string"
              ? ev.message.mid
              : null;

          if (senderId && text) {
            out.push({
              senderId,
              recipientId,
              text,
              mid,
            });
          }
        }

        continue;
      }

      if (
        value.message &&
        !value.message.is_echo
      ) {
        const senderId = String(
          value.sender?.id ?? ""
        );

        const recipientId = String(
          value.recipient?.id ?? ""
        );

        const text =
          typeof value.message.text === "string"
            ? value.message.text
            : "";

        const mid =
          typeof value.message.mid === "string"
            ? value.message.mid
            : null;

        if (senderId && text) {
          out.push({
            senderId,
            recipientId,
            text,
            mid,
          });
        }
      }
    }
  }

  return out;
}

/**
 * إرسال رسالة مباشرة عبر Facebook/Instagram Graph API.
 * يدعم نوعي رموز Instagram (IG... و EAA...) كما في metaSend.ts.
 */
async function sendMetaDirectMessage(opts: {
  channel: "instagram" | "facebook";
  externalId: string;
  token: string;
  recipientId: string;
  text: string;
}): Promise<void> {
  const {
    channel,
    externalId,
    token,
    recipientId,
    text,
  } = opts;

  if (!token) throw new Error("Missing Meta access token");
  if (!recipientId) throw new Error("Missing recipient ID");
  if (!text) throw new Error("Missing message text");

  const payload: Record<string, unknown> = {
    recipient: { id: recipientId },
    message: { text },
  };

  let url: string;
  let headers: Record<string, string> = {
    "content-type": "application/json",
  };
  let body: Record<string, unknown>;

  if (
    channel === "instagram" &&
    token.startsWith("IG")
  ) {
    /* Instagram Login */
    url =
      `https://graph.instagram.com/v21.0/me/messages`;

    headers = {
      ...headers,
      authorization:
        `Bearer ${token}`,
    };

    body = payload;
  } else if (channel === "instagram") {
    /* Facebook Login → Instagram API */
    if (!externalId) {
      throw new Error(
        "Missing Instagram Business Account ID"
      );
    }

    url =
      `https://graph.facebook.com/v21.0/${externalId}/messages`;

    body = { ...payload, access_token: token };
  } else {
    /* Facebook Messenger */
    url =
      "https://graph.facebook.com/v21.0/me/messages";

    body = { ...payload, access_token: token };
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(
      `${channel} send ${res.status}: ${await res.text()}`
    );
  }
}

/**
 * جلب آخر N رسائل من المحادثة كسياق للـ RAG.
 */
async function conversationHistory(
  sb: SupabaseClient,
  conversationId: string,
  limit = 8
): Promise<string> {
  const { data: msgs } = await sb
    .from("messages")
    .select("direction, body_encrypted, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (!msgs || msgs.length === 0) {
    return "";
  }

  const reversed = [...msgs].reverse();

  const lines: string[] = [];

  for (const m of reversed) {
    let bodyText = "";

    try {
      bodyText = await decryptField(m.body_encrypted);
    } catch {
      continue;
    }

    if (!bodyText?.trim()) continue;

    const role =
      m.direction === "in"
        ? "العميل"
        : "المساعد";

    lines.push(`${role}: ${bodyText.trim()}`);
  }

  return lines.join("\n");
}

/**
 * معالجة رسالة واردة (من WhatsApp أو Instagram)
 * وتشغيل الرد الآلي عبر RAG.
 */
/**
 * جلب بيانات المرسل (اسم + صورة) من Meta Graph API.
 * يعمل فقط لـ Instagram و Facebook (ليس WhatsApp).
 */
async function fetchSenderProfile(opts: {
  channel: "instagram" | "facebook" | "whatsapp";
  senderId: string;
  token: string | null;
}): Promise<{ name: string | null; avatar: string | null }> {
  const { channel, senderId, token } = opts;

  if (channel === "whatsapp" || !token || !senderId) {
    return { name: null, avatar: null };
  }

  try {
    let url: string;

    if (channel === "instagram" && token.startsWith("IG")) {
      // Instagram Login
      url = `https://graph.instagram.com/v21.0/${senderId}?fields=name,username,profile_pic&access_token=${encodeURIComponent(token)}`;
    } else if (channel === "instagram") {
      // Facebook Login → Instagram API
      url = `https://graph.facebook.com/v21.0/${senderId}?fields=name,profile_picture&access_token=${encodeURIComponent(token)}`;
    } else {
      // Facebook Messenger
      url = `https://graph.facebook.com/v21.0/${senderId}?fields=name,picture&access_token=${encodeURIComponent(token)}`;
    }

    const res = await fetch(url);

    if (!res.ok) {
      console.warn(`[fetchSenderProfile] HTTP ${res.status} for ${senderId}`);
      return { name: null, avatar: null };
    }

    const pj: any = await res.json();

    let name: string | null = null;
    if (typeof pj.name === "string" && pj.name.trim()) {
      name = pj.name.trim();
    } else if (typeof pj.username === "string" && pj.username.trim()) {
      name = `@${pj.username.trim()}`;
    }

    let avatar: string | null = null;
    if (typeof pj.profile_pic === "string") avatar = pj.profile_pic;
    else if (typeof pj.profile_picture === "string") avatar = pj.profile_picture;
    else if (typeof pj.picture?.data?.url === "string") avatar = pj.picture.data.url;

    console.log("[fetchSenderProfile]", {
      senderId,
      name,
      avatar: avatar ? "present" : "missing",
    });

    return { name, avatar };
  } catch (e: any) {
    console.warn("[fetchSenderProfile] error:", e?.message ?? e);
    return { name: null, avatar: null };
  }
}
async function handleIncomingWebhookMessage(
  sb: SupabaseClient,
  account: any,
  chatId: string,
  customerText: string,
  externalMsgId: string | null,
  channel: "whatsapp" | "instagram" | "facebook",
  phoneId?: string
) {
  const tenantId: string =
    channel === "whatsapp"
      ? account.tenant_id
      : account.tenant_id;

  const { data: tenant } = await sb
    .from("tenants")
    .select("*")
    .eq("id", tenantId)
    .maybeSingle();

  if (!tenant) {
    console.error(
      `[${channel}_webhook] tenant not found: ${tenantId}`
    );
    return;
  }

  if (tenant.is_active === false) {
    console.log(
      `[${channel}_webhook] tenant inactive: ${tenantId}`
    );
    return;
  }

  /**
   * البحث عن conversation موجود أو إنشاؤه.
   */
  const { data: existingConv } = await sb
    .from("conversations")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("wa_chat_id", chatId)
    .maybeSingle();

  let conv: any = existingConv;

  if (!conv) {
    const { data: newConv } = await sb
      .from("conversations")
      .insert({
        tenant_id: tenantId,
        wa_chat_id: chatId,
        customer_phone_encrypted:
          await encryptField(
            chatId.replace(/@s\.whatsapp\.net$/, "")
          ),
        channel,
        account_id: account?.id ?? null,
        last_message_at:
          new Date().toISOString(),
      })
      .select()
      .single();

    conv = newConv;
  } else {
    await sb
      .from("conversations")
      .update({
        last_message_at:
          new Date().toISOString(),
      })
      .eq("id", conv.id);
  }

  if (!conv) {
    console.error(
      `[${channel}_webhook] conversation is null`
    );
    return;
  }

  /**
   * حفظ رسالة العميل الواردة.
   */
  try {
    await sb
      .from("messages")
      .insert({
        conversation_id: conv.id,
        tenant_id: tenantId,
        direction: "in",
        body_encrypted:
          await encryptField(customerText),
        kind: "customer",
        is_auto: false,
        wa_message_id: externalMsgId,
      });
  } catch (e: any) {
    if (e?.code === "23505") {
      console.log(
        `[${channel}_webhook] duplicate message skipped: ${externalMsgId}`
      );
    } else {
      console.error(
        `[${channel}_webhook] incoming insert failed`,
        e
      );
    }
    return;
  }

  /**
   * المحادثة محولة لبشري — لا رد آلي.
   */
  if (conv.transferred) {
    console.log(
      `[${channel}_webhook] conversation transferred: ${conv.id}`
    );
    return;
  }

  /**
   * متوقفة بسبب الرصيد.
   */
  if (conv.auto_paused_reason === "credits") {
    console.log(
      `[${channel}_webhook] paused (credits): ${conv.id}`
    );
    return;
  }

  /**
   * لا رد آلي إلا لو الوكيل مفعّل على الحساب.
   */
  if (account.agent_enabled === false ||
      account.auto_reply === false) {
    console.log(
      `[${channel}_webhook] auto reply disabled for account ${account?.id}`
    );
    return;
  }

  const credits = Number(
    tenant.credits_remaining ?? 0
  );

  if (credits <= 0) {
    await sb
      .from("conversations")
      .update({
        auto_paused_reason: "credits",
      })
      .eq("id", conv.id);

    console.log(
      `[${channel}_webhook] no credits: ${tenantId}`
    );
    return;
  }

  /**
   * RAG + LLM مع ذاكرة المحادثة.
   */
  const history =
    await conversationHistory(sb, conv.id, 8);

  let result;

  try {
    result =
      await answerFromKnowledge(
        sb,
        tenant,
        customerText,
        history
      );
  } catch (e) {
    console.error(
      `[${channel}_webhook] AI error`,
      e
    );
    return;
  }

  const replyText =
    result.answer?.trim() ?? "";

  if (!replyText) {
    /*
     * سؤال غير مؤهل — نسجله في unresolved_questions
     * دون إرسال رد.
     */
    try {
      await sb
        .from("unresolved_questions")
        .insert({
          tenant_id: tenantId,
          question_encrypted:
            await encryptField(customerText),
          status: "open",
          conversation_id: conv.id,
          best_similarity: result.similarity,
        });
    } catch (e) {
      console.error(
        `[${channel}_webhook] unresolved insert failed`,
        e
      );
    }
    return;
  }

  /**
   * إرسال الرد إلى القناة.
   */
  try {
    if (channel === "whatsapp") {
      if (!phoneId) {
        console.error(
          "[whatsapp_webhook] missing phone_number_id for reply"
        );
        return;
      }

      await sendWa(
        phoneId,
        chatId.replace(/^whatsapp:/, ""),
        replyText
      );
    } else {
      let token: string | null = null;

      try {
        if (account.access_token_encrypted) {
          token = await decryptField(
            account.access_token_encrypted
          );
        }
      } catch (e) {
        console.warn(
          `[${channel}_webhook] token decrypt failed`,
          e
        );
      }

      if (!token) {
        console.error(
          `[${channel}_webhook] no access token for account ${account?.id}`
        );
        return;
      }

      await sendMetaDirectMessage({
        channel:
          channel === "facebook"
            ? "facebook"
            : "instagram",
        externalId: String(account.external_id),
        token,
        recipientId: chatId.split(":").slice(1).join(":"),
        text: replyText,
      });
    }
  } catch (e) {
    console.error(
      `[${channel}_webhook] send failed`,
      e
    );
    return;
  }

  /**
   * تسجيل الرد الصادر.
   */
  await sb
    .from("messages")
    .insert({
      conversation_id: conv.id,
      tenant_id: tenantId,
      direction: "out",
      body_encrypted:
        await encryptField(replyText),
      kind: "answer",
      is_auto: true,
    });

  /**
   * خصم credit بعد إرسال الرد.
   */
  try {
    await sb.rpc(
      "consume_reply",
      {
        p_tenant_id: tenantId,
      }
    );
  } catch (e) {
    console.error(
      `[${channel}_webhook] consume_reply failed`,
      e
    );
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   المعالج الرئيسي
═══════════════════════════════════════════════════════════════════════ */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: CORS,
    });
  }

  const url = new URL(req.url);

  const action =
    url.searchParams.get("action") ??
    "";

  const raw = await req.text();

  let body: Record<string, any> = {};

  try {
    body = raw
      ? JSON.parse(raw)
      : {};
  } catch {
    return err(
      "JSON غير صالح"
    );
  }

  const sb = sbAdmin();

  try {
    /* ═══════════════════════════════════════════════════════════════════
       PUBLIC
    ═══════════════════════════════════════════════════════════════════ */

    switch (action) {
      /* ────────────────────────────────────────────────────────────────
         إنشاء Tenant
      ──────────────────────────────────────────────────────────────── */

      case "create_tenant": {
        const {
          businessName,
          sourceType,
          sourceUrl,
          phoneE164,
        } = body;

        if (
          !businessName?.trim() ||
          ![
            "gmaps",
            "website",
            "manual",
          ].includes(sourceType)
        ) {
          return err(
            "بيانات ناقصة"
          );
        }

        const phone =
          typeof phoneE164 ===
          "string" &&
          /^\+\d{7,15}$/.test(
            phoneE164
          )
            ? phoneE164
            : null;

        const { data, error } =
          await sb
            .from("tenants")
            .insert({
              business_name:
                businessName
                  .trim()
                  .slice(0, 120),

              source_type:
                sourceType,

              source_url:
                sourceUrl ??
                null,

              business_phone_encrypted:
                phone
                  ? await encryptField(
                      phone
                    )
                  : null,

              credits_remaining: 0,

              is_active: false,
            })
            .select(
              "id, claim_token"
            )
            .single();

        if (
          error ||
          !data
        ) {
          return err(
            error?.message ??
              "خطأ",
            500
          );
        }

        return json({
          tenantId:
            data.id,

          claimToken:
            data.claim_token,
        });
      }

      /* ═══════════════════════════════════════════════════════════════
         PAY WEBHOOK
      ═══════════════════════════════════════════════════════════════ */

      case "pay_webhook": {
        const sig =
          req.headers.get(
            "moyasar-signature"
          ) ?? "";

        const expected =
          hex(
            await crypto.subtle.sign(
              "HMAC",
              await crypto.subtle.importKey(
                "raw",
                enc.encode(
                  env(
                    "MOYASAR_WEBHOOK_SECRET"
                  )
                ),
                {
                  name: "HMAC",
                  hash: "SHA-256",
                },
                false,
                ["sign"]
              ),
              enc.encode(raw)
            )
          );

        if (
          !sig ||
          sig !== expected
        ) {
          return err(
            "توقيع غير صالح",
            401
          );
        }

        const ev = body;

        const type: string =
          ev.type ?? "";

        const invoiceId: string =
          ev.data?.invoice_id ??
          ev.data?.id;

        if (
          !invoiceId ||
          !/paid|succeeded/.test(
            type
          )
        ) {
          return json({
            received: true,
          });
        }

        const {
          data: payment,
        } = await sb
          .from("payments")
          .select("*")
          .eq(
            "invoice_id",
            invoiceId
          )
          .maybeSingle();

        if (
          !payment ||
          payment.status ===
            "paid"
        ) {
          return json({
            received: true,
          });
        }

        const credits =
          {
            9900: 1000,
            24900: 3000,
            64900: 10000,
          }[
            payment.amount
          ] ?? 1000;

        await sb
          .from("payments")
          .update({
            status: "paid",
            credits_granted:
              credits,
            webhook_event: ev,
            paid_at:
              new Date().toISOString(),
          })
          .eq(
            "id",
            payment.id
          );

        await sb.rpc(
          "grant_credits",
          {
            p_tenant_id:
              payment.tenant_id,
            p_credits:
              credits,
          }
        );

        return json({
          received: true,
          activated: true,
        });
      }

      /* ────────────────────────────────────────────────────────────────
         WhatsApp Webhook (Meta Cloud API)
         GET  ?action=whatsapp_webhook&hub.mode=... → verification
         POST ?action=whatsapp_webhook             → incoming messages
      ──────────────────────────────────────────────────────────────── */

      case "whatsapp_webhook": {
        if (req.method === "GET") {
          const mode =
            url.searchParams.get("hub.mode");

          const token =
            url.searchParams.get(
              "hub.verify_token"
            );

          const challenge =
            url.searchParams.get(
              "hub.challenge"
            );

          const expected =
            env("WHATSAPP_VERIFY_TOKEN");

          if (
            mode === "subscribe" &&
            expected &&
            token === expected
          ) {
            return new Response(
              challenge ?? "",
              { status: 200 }
            );
          }

          return new Response(
            "Forbidden",
            { status: 403 }
          );
        }

        if (
          body.object !==
          "whatsapp_business_account"
        ) {
          return json({
            received: true,
          });
        }

        for (const entry of body.entry ?? []) {
          for (const change of entry?.changes ?? []) {
            if (change?.field !== "messages") {
              continue;
            }

            const value = change.value;

            if (!value) {
              continue;
            }

            const phoneId = String(
              value.metadata?.phone_number_id ?? ""
            );

            if (!phoneId) {
              continue;
            }

            /**
             * تحديد الحساب/المستأجر عبر wa_bindings.
             */
            let account: any = null;

            const { data: binding } = await sb
              .from("wa_bindings")
              .select("tenant_id, phone_id")
              .eq("phone_id", phoneId)
              .maybeSingle();

            if (binding) {
              account = {
                tenant_id: binding.tenant_id,
                external_id: phoneId,
                channel: "whatsapp",
              };
            } else {
              const { data: chAcc } = await sb
                .from("channel_accounts")
                .select(
                  "id, tenant_id, channel, external_id, status, agent_enabled, auto_reply, access_token_encrypted"
                )
                .eq("external_id", phoneId)
                .eq("channel", "whatsapp")
                .maybeSingle();

              if (chAcc) {
                account = chAcc;
              }
            }

            if (!account) {
              console.warn(
                `[whatsapp_webhook] no account for phone_number_id=${phoneId}`
              );
              continue;
            }

            const customerNameOf = (waId: string) => {
              const c = (value.contacts ?? []).find(
                (x: any) => x.wa_id === waId
              );
              return c?.profile?.name
                ? String(c.profile.name)
                : null;
            };

            for (const message of value.messages ?? []) {
              const from = String(message?.from ?? "");

              if (!from) {
                continue;
              }

              const text =
                typeof message?.text?.body === "string"
                  ? message.text.body
                  : "";

              const msgId =
                typeof message?.id === "string"
                  ? message.id
                  : null;

              if (!text) {
                /*
                 * أنواع غير نصية — نسجلها الواردة فقط إن وُجد نص،
                 * وإلا نتجاهلها (كما في extractText القديم).
                 */
                continue;
              }

              const chatId = `whatsapp:${from}`;

              /**
               * منع التكرار قبل المعالجة.
               */
              if (msgId) {
                const { data: dup } = await sb
                  .from("messages")
                  .select("id")
                  .eq("wa_message_id", msgId)
                  .maybeSingle();

                if (dup) {
                  console.log(
                    `[whatsapp_webhook] duplicate skipped: ${msgId}`
                  );
                  continue;
                }
              }

              const name = customerNameOf(from);

              await handleIncomingWebhookMessage(
                sb,
                account,
                chatId,
                text,
                msgId,
                "whatsapp",
                phoneId
              );

              if (name) {
                await sb
                  .from("conversations")
                  .update({
                    customer_name: name,
                  })
                  .eq("tenant_id", account.tenant_id)
                  .eq("wa_chat_id", chatId);
              }
            }
          }
        }

        return json({
          received: true,
        });
      }

      /* ────────────────────────────────────────────────────────────────
         Instagram Webhook (Meta Messenger/Instagram API)
         GET  ?action=instagram_webhook&hub.mode=... → verification
         POST ?action=instagram_webhook             → incoming messages
      ──────────────────────────────────────────────────────────────── */

      case "instagram_webhook": {
        if (req.method === "GET") {
          const mode =
            url.searchParams.get("hub.mode");

          const token =
            url.searchParams.get(
              "hub.verify_token"
            );

          const challenge =
            url.searchParams.get(
              "hub.challenge"
            );

          const expected =
            env("INSTAGRAM_VERIFY_TOKEN") ||
            env("META_WEBHOOK_VERIFY_TOKEN");

          if (
            mode === "subscribe" &&
            expected &&
            token === expected
          ) {
            return new Response(
              challenge ?? "",
              { status: 200 }
            );
          }

          return new Response(
            "Forbidden",
            { status: 403 }
          );
        }

        if (
          body.object !== "instagram" &&
          body.object !== "page"
        ) {
          return json({
            received: true,
          });
        }

        const sigOk = await verifyMetaSignature(
          raw,
          req.headers.get(
            "x-hub-signature-256"
          ) ?? ""
        );

        if (!sigOk) {
          console.error(
            "[instagram_webhook] invalid signature — ignored"
          );

          return json({
            received: true,
          });
        }

        for (const entry of body.entry ?? []) {
          const entryId = String(entry.id ?? "");

          const msgs = extractIgMessages(entry);

          for (const msg of msgs) {
            const candidates = [
              entryId,
              msg.recipientId,
            ].filter((x) => x && x !== "0");

            let account: any = null;

            for (const candidate of candidates) {
              const { data } = await sb
                .from("channel_accounts")
                .select(
                  "id, tenant_id, channel, external_id, status, agent_enabled, auto_reply, access_token_encrypted"
                )
                .eq("external_id", candidate)
                .in("channel", [
                  "instagram",
                  "facebook",
                ])
                .maybeSingle();

              if (data) {
                account = data;
                break;
              }
            }

            if (!account) {
              console.warn(
                `[instagram_webhook] no matching account | entryId=${entryId} recipient=${msg.recipientId}`
              );
              continue;
            }

            if (account.status !== "active") {
              console.warn(
                `[instagram_webhook] account not active — skipped | status=${account.status}`
              );
              continue;
            }

            const channel =
              account.channel === "facebook"
                ? "facebook"
                : "instagram";

            const chatId =
              `${channel}:${msg.senderId}`;

            const msgId =
              msg.mid || `ig_${Date.now()}`;

            /**
             * منع التكرار.
             */
            if (msg.mid) {
              const { data: dup } = await sb
                .from("messages")
                .select("id")
                .eq("wa_message_id", msgId)
                .limit(1);

              if (dup && dup.length > 0) {
                console.log(
                  `[instagram_webhook] duplicate skipped: ${msgId}`
                );
                continue;
              }
            }

            await handleIncomingWebhookMessage(
              sb,
              account,
              chatId,
              msg.text,
              msgId,
              channel as
                | "instagram"
                | "facebook"
            );
          }
        }

        return json({
          received: true,
        });
      }

      default:
        break;
    }

    /* ═══════════════════════════════════════════════════════════════════
       WIDGET PUBLIC API
    ═══════════════════════════════════════════════════════════════════ */

    if (
      action ===
      "widget_public"
    ) {
      const token =
        String(
          body.token ??
            url.searchParams.get(
              "token"
            ) ??
            ""
        ).trim();

      if (!token) {
        return err(
          "Widget token مطلوب",
          400
        );
      }

      const found =
        await publicWidget(
          sb,
          token
        );

      if (!found) {
        return err(
          "Widget غير موجود أو غير مفعّل",
          404
        );
      }

      return json(
        widgetConfig(
          found.widget,
          found.tenant
        )
      );
    }

    /* ═══════════════════════════════════════════════════════════════════
       WIDGET SESSION
    ═══════════════════════════════════════════════════════════════════ */

    if (
      action ===
      "widget_session"
    ) {
      const token =
        String(
          body.token ??
            url.searchParams.get(
              "token"
            ) ??
            ""
        ).trim();

      const visitorId =
        String(
          body.visitorId ??
            ""
        ).trim();

      if (!token) {
        return err(
          "Widget token مطلوب"
        );
      }

      if (!visitorId) {
        return err(
          "visitorId مطلوب"
        );
      }

      const found =
        await publicWidget(
          sb,
          token
        );

      if (!found) {
        return err(
          "Widget غير موجود أو غير مفعّل",
          404
        );
      }

      const visitorIp =
        req.headers.get(
          "x-forwarded-for"
        ) ??
        req.headers.get(
          "cf-connecting-ip"
        );

      const visitorUa =
        req.headers.get(
          "user-agent"
        );

      const session =
        await getOrCreateWidgetSession(
          sb,
          found.widget,
          visitorId,
          visitorIp,
          visitorUa
        );

      const messages =
        await widgetMessages(
          sb,
          session.id,
          found.tenant.id
        );

      return json({
        sessionId:
          session.id,

        messages,
      });
    }

    /* ═══════════════════════════════════════════════════════════════════
       WIDGET MESSAGE
    ═══════════════════════════════════════════════════════════════════ */

    if (
      action ===
      "widget_message"
    ) {
      const token =
        String(
          body.token ??
            url.searchParams.get(
              "token"
            ) ??
            ""
        ).trim();

      const sessionId =
        String(
          body.sessionId ??
            ""
        ).trim();

      const message =
        String(
          body.message ??
            ""
        ).trim();

      if (!token) {
        return err(
          "Widget token مطلوب"
        );
      }

      if (!sessionId) {
        return err(
          "sessionId مطلوب"
        );
      }

      if (!message) {
        return err(
          "الرسالة فارغة"
        );
      }

      if (
        message.length >
        4000
      ) {
        return err(
          "الرسالة طويلة جدًا"
        );
      }

      const found =
        await publicWidget(
          sb,
          token
        );

      if (!found) {
        return err(
          "Widget غير موجود أو غير مفعّل",
          404
        );
      }

      const session =
        await widgetSession(
          sb,
          sessionId,
          found.widget.id,
          found.tenant.id
        );

      if (!session) {
        return err(
          "جلسة Widget غير صالحة",
          404
        );
      }

      /*
       * حفظ رسالة العميل أولًا
       */
      const {
        error: insertInError,
      } = await sb
        .from(
          "widget_messages"
        )
        .insert({
          session_id:
            session.id,

          widget_id:
            found.widget.id,

          tenant_id:
            found.tenant.id,

          direction: "in",

          body: message,

          kind: "customer",
        });

      if (
        insertInError
      ) {
        throw new Error(
          insertInError.message
        );
      }

      /*
       * تحديث وقت الجلسة
       */
      await sb
        .from(
          "widget_sessions"
        )
        .update({
          last_message_at:
            new Date().toISOString(),
        })
        .eq(
          "id",
          session.id
        );

      /*
       * التأكد من حالة الحساب
       */
      if (
        found.tenant.is_active ===
        false
      ) {
        const reply =
          "عذرًا، المساعد غير متاح حاليًا.";

        await sb
          .from(
            "widget_messages"
          )
          .insert({
            session_id:
              session.id,

            widget_id:
              found.widget.id,

            tenant_id:
              found.tenant.id,

            direction: "out",

            body: reply,

            kind: "error",
          });

        return json({
          reply,
          kind: "error",
        });
      }

      /*
       * التحقق من الرصيد
       */
      const credits =
        Number(
          found.tenant
            .credits_remaining ??
            0
        );

      if (credits <= 0) {
        const reply =
          "عذرًا، المساعد غير متاح حاليًا.";

        await sb
          .from(
            "widget_messages"
          )
          .insert({
            session_id:
              session.id,

            widget_id:
              found.widget.id,

            tenant_id:
              found.tenant.id,

            direction: "out",

            body: reply,

            kind: "error",
          });

        return json({
          reply,
          kind: "error",
        });
      }

      /*
       * البحث في قاعدة المعرفة + LLM
       */
      let result;

      try {
        result =
          await answerFromKnowledge(
            sb,
            found.tenant,
            message
          );
      } catch (e) {
        console.error(
          "[widget_message] AI error",
          e
        );

        const reply =
          "عذرًا، حدث خطأ مؤقت أثناء معالجة رسالتك.";

        await sb
          .from(
            "widget_messages"
          )
          .insert({
            session_id:
              session.id,

            widget_id:
              found.widget.id,

            tenant_id:
              found.tenant.id,

            direction: "out",

            body: reply,

            kind: "error",
          });

        return json({
          reply,
          kind: "error",
        });
      }

      /*
       * لا توجد إجابة موثوقة
       */
      if (
        !result.answer ||
        result.kind ===
          "refusal"
      ) {
        const reply =
          "عذرًا، ما عندي معلومات كافية عن هذا السؤال حاليًا.";

        await sb
          .from(
            "widget_messages"
          )
          .insert({
            session_id:
              session.id,

            widget_id:
              found.widget.id,

            tenant_id:
              found.tenant.id,

            direction: "out",

            body: reply,

            kind: "refusal",
          });

        /*
         * تسجيل السؤال في unresolved_questions
         * إذا كان الجدول موجودًا.
         */
        try {
          await sb
            .from(
              "unresolved_questions"
            )
            .insert({
              tenant_id:
                found.tenant.id,

              question_encrypted:
                await encryptField(
                  message
                ),

              status: "open",

              conversation_id:
                null,

              best_similarity:
                result.similarity,
            });
        } catch (e) {
          console.error(
            "[widget_message] unresolved insert failed",
            e
          );
        }

        return json({
          reply,
          kind: "refusal",
        });
      }

      /*
       * حفظ رد AI
       */
      await sb
        .from(
          "widget_messages"
        )
        .insert({
          session_id:
            session.id,

          widget_id:
            found.widget.id,

          tenant_id:
            found.tenant.id,

          direction: "out",

          body:
            result.answer,

          kind: "answer",
        });

      /*
       * استهلاك رصيد الرد.
       *
       * إذا كانت دالة consume_reply موجودة في مشروعك
       * نستعملها.
       */
      try {
        await sb.rpc(
          "consume_reply",
          {
            p_tenant_id:
              found.tenant.id,
          }
        );
      } catch (e) {
        console.error(
          "[widget_message] consume_reply failed",
          e
        );
      }

      await sb
        .from(
          "widget_sessions"
        )
        .update({
          last_message_at:
            new Date().toISOString(),
        })
        .eq(
          "id",
          session.id
        );

      return json({
        reply:
          result.answer,

        kind:
          "answer",

        similarity:
          result.similarity,
      });
    }

    /* ═══════════════════════════════════════════════════════════════════
       إجراءات رمز الجلسة
    ═══════════════════════════════════════════════════════════════════ */

    const claimActions = [
      "bind_number",
      "wa_status",
      "qa_extract",
      "qa_save",
      "ingest_text",
      "qa_test",
    ];

    if (
      claimActions.includes(
        action
      )
    ) {
      const tenant =
        await tenantByClaim(
          sb,
          req,
          body.tenantId ?? ""
        );

      if (!tenant) {
        return err(
          "رمز الجلسة غير صالح",
          403
        );
      }

      switch (action) {
        /* ─────────────────────────────────────────────────────────────
           ربط الرقم
        ───────────────────────────────────────────────────────────── */

        case "bind_number": {
          const phoneId =
            String(
              body.phoneId ??
                ""
            ).trim();

          if (
            !/^\d{6,20}$/.test(
              phoneId
            )
          ) {
            return err(
              "Phone Number ID غير صالح — خذه من Meta → WhatsApp → API Setup"
            );
          }

          const {
            error,
          } = await sb
            .from(
              "wa_bindings"
            )
            .upsert(
              {
                phone_id:
                  phoneId,

                tenant_id:
                  tenant.id,
              },
              {
                onConflict:
                  "phone_id",
              }
            );

          if (error) {
            return err(
              error.message,
              500
            );
          }

          return json({
            ok: true,
          });
        }

        /* ─────────────────────────────────────────────────────────────
           حالة واتساب
        ───────────────────────────────────────────────────────────── */

        case "wa_status": {
          const phoneId =
            await boundPhone(
              sb,
              tenant.id
            );

          return json({
            bound:
              Boolean(phoneId),

            phoneId,
          });
        }

        /* ─────────────────────────────────────────────────────────────
           استخراج QA
        ───────────────────────────────────────────────────────────── */

        case "qa_extract": {
          const url =
            String(
              body.url ??
                ""
            );

          if (
            !/^https?:\/\/\S+\.\S+/.test(
              url
            )
          ) {
            return err(
              "الرابط غير صالح"
            );
          }

          const {
            title,
            text,
          } =
            await extractFromUrl(
              url
            );

          if (
            text.length < 40
          ) {
            return err(
              "المحتوى المستخرج غير كافٍ — جرّب الإدخال اليدوي",
              502
            );
          }

          const out =
            await chatJSON(
              QA_SYSTEM,
              `<website_content>
${text}
</website_content>`
            );

          const pairs =
            (
              Array.isArray(
                out.pairs
              )
                ? out.pairs
                : []
            )
              .filter(
                (p: any) =>
                  p?.question?.trim() &&
                  p?.answer?.trim()
              )
              .map(
                (p: any) => ({
                  question:
                    String(
                      p.question
                    ).trim(),

                  answer:
                    String(
                      p.answer
                    ).trim(),
                })
              )
              .slice(0, 15);

          if (
            !pairs.length
          ) {
            return err(
              "تعذر توليد الأسئلة — المحتوى قد لا يحوي معلومات كافية",
              502
            );
          }

          return json({
            pairs,
            title,
          });
        }

        /* ─────────────────────────────────────────────────────────────
           حفظ QA
        ───────────────────────────────────────────────────────────── */

        case "qa_save": {
          const pairs =
            (
              Array.isArray(
                body.pairs
              )
                ? body.pairs
                : []
            ).filter(
              (p: any) =>
                p?.question?.trim() &&
                p?.answer?.trim()
            );

          if (
            !pairs.length
          ) {
            return err(
              "القائمة فارغة"
            );
          }

          const {
            data: src,
            error: srcError,
          } = await sb
            .from(
              "knowledge_sources"
            )
            .insert({
              tenant_id:
                tenant.id,

              kind: "qa",

              url:
                body.sourceUrl ??
                null,

              status:
                "indexed",

              chunks_count:
                pairs.length,
            })
            .select()
            .single();

          if (
            srcError ||
            !src
          ) {
            return err(
              srcError?.message ??
                "تعذر إنشاء مصدر المعرفة",
              500
            );
          }

          const contents =
            pairs.map(
              (p: any) =>
                `س: ${p.question.trim()}\nج: ${p.answer.trim()}`
            );

          const vectors =
            await embed(
              contents
            );

          const {
            error: chunksError,
          } = await sb
            .from(
              "knowledge_chunks"
            )
            .insert(
              contents.map(
                (
                  content: string,
                  i: number
                ) => ({
                  tenant_id:
                    tenant.id,

                  source_id:
                    src.id,

                  chunk_index:
                    i,

                  content,

                  embedding:
                    pg(
                      vectors[i]
                    ),
                })
              )
            );

          if (
            chunksError
          ) {
            return err(
              chunksError.message,
              500
            );
          }

          return json({
            saved:
              pairs.length,

            sourceId:
              src.id,
          });
        }

        /* ─────────────────────────────────────────────────────────────
           إدخال نص
        ───────────────────────────────────────────────────────────── */

        case "ingest_text": {
          const text =
            String(
              body.text ??
                ""
            ).trim();

          if (
            text.length < 20
          ) {
            return err(
              "النص قصير جدًا"
            );
          }

          const chunks =
            chunkText(text);

          const vectors =
            await embed(
              chunks
            );

          const {
            data: src,
            error: srcError,
          } = await sb
            .from(
              "knowledge_sources"
            )
            .insert({
              tenant_id:
                tenant.id,

              kind: "manual",

              status:
                "indexed",

              chunks_count:
                chunks.length,

              raw_text_encrypted:
                await encryptField(
                  text
                ),
            })
            .select()
            .single();

          if (
            srcError ||
            !src
          ) {
            return err(
              srcError?.message ??
                "تعذر إنشاء المصدر",
              500
            );
          }

          const {
            error: chunksError,
          } = await sb
            .from(
              "knowledge_chunks"
            )
            .insert(
              chunks.map(
                (
                  content,
                  i
                ) => ({
                  tenant_id:
                    tenant.id,

                  source_id:
                    src.id,

                  chunk_index:
                    i,

                  content,

                  embedding:
                    pg(
                      vectors[i]
                    ),
                })
              )
            );

          if (
            chunksError
          ) {
            return err(
              chunksError.message,
              500
            );
          }

          return json({
            chunks:
              chunks.length,
          });
        }

        /* ─────────────────────────────────────────────────────────────
           اختبار QA
        ───────────────────────────────────────────────────────────── */

        case "qa_test": {
          const text =
            String(
              body.text ??
                ""
            ).trim();

          if (!text) {
            return err(
              "اكتب صياغة لتجربتها"
            );
          }

          const [qv] =
            await embed([
              text,
            ]);

          const {
            data: hits,
            error,
          } = await sb.rpc(
            "match_knowledge",
            {
              p_tenant_id:
                tenant.id,

              p_query:
                pg(qv),

              p_limit:
                Number(
                  env(
                    "RAG_TOP_K"
                  ) || 5
                ),

              p_threshold: 0,
            }
          );

          if (error) {
            return err(
              error.message,
              500
            );
          }

          const matches =
            (
              (hits ??
                []) as {
                id: string;
                content: string;
                similarity: number;
              }[]
            ).map(
              (h) => ({
                id:
                  h.id,

                content:
                  h.content,

                similarity:
                  Math.round(
                    h.similarity *
                      1000
                  ) / 1000,
              })
            );

          const best =
            matches[0]
              ?.similarity ??
            0;

          const threshold =
            Number(
              env(
                "SIMILARITY_THRESHOLD"
              ) || 0.25
            );

          if (
            !matches.length ||
            best <
              threshold
          ) {
            return json({
              confident:
                false,

              bestSimilarity:
                best,

              threshold,

              matches,

              answer:
                null,
            });
          }

          const g =
            await chatJSON(
              [
                `أنت موظف خدمة عملاء لمشروع «${tenant.business_name}» يرد عبر واتساب.`,
                "أجب بناءً على السياق المرفق فقط، وبنفس لهجة وأسلوب المحتوى المتوفر.",
                "إذا لم تجد إجابة كافية قل صراحة إنك غير متأكد ولا تختلق.",
                'أعد JSON فقط: {"answer":"...","grounded":true|false}',
              ].join("\n"),
              `<context>
${matches
  .map(
    (m, i) =>
      `[${i + 1}] ${m.content}`
  )
  .join("\n")}
</context>

سؤال العميل:
${text}`
            );

          const answer =
            String(
              g.answer ??
                ""
            ).trim();

          const confident =
            Boolean(
              g.grounded
            ) &&
            answer.length >
              0;

          return json({
            confident,

            bestSimilarity:
              best,

            threshold,

            matches,

            answer:
              confident
                ? answer
                : null,
          });
        }
      }
    }

    /* ═══════════════════════════════════════════════════════════════════
       AUTH
    ═══════════════════════════════════════════════════════════════════ */

    const u =
      await userOf(
        req,
        sb
      );

    if (!u) {
      return err(
        "غير مصرح",
        401
      );
    }

    /* ═══════════════════════════════════════════════════════════════════
       CLAIM ACCOUNT
    ═══════════════════════════════════════════════════════════════════ */

    switch (action) {
      case "claim_account": {
        const {
          claimToken,
        } = body;

        if (!claimToken) {
          return err(
            "رمز الضم ناقص"
          );
        }

        const {
          data,
          error,
        } = await sb
          .from("tenants")
          .update({
            user_id:
              u.id,
          })
          .eq(
            "claim_token",
            claimToken
          )
          .is(
            "user_id",
            null
          )
          .select("id")
          .maybeSingle();

        if (
          error ||
          !data
        ) {
          return err(
            error?.message ??
              "رمز غير صالح أو مستخدم",
            error
              ? 500
              : 404
          );
        }

        return json({
          tenantId:
            data.id,
        });
      }
    }

    const tenant =
      await ownedTenant(
        sb,
        req
      );

    if (!tenant) {
      return err(
        "لا يوجد حساب مرتبط — أنشئ موظفًا من الصفحة الرئيسية أولاً",
        404
      );
    }

    /* ═══════════════════════════════════════════════════════════════════
       DASHBOARD WIDGET ACTIONS
    ═══════════════════════════════════════════════════════════════════ */

    switch (action) {
      /* ─────────────────────────────────────────────────────────────
         جلب Widgets الخاصة بالحساب
      ───────────────────────────────────────────────────────────── */

      case "widget_dashboard_list": {
        const {
          data,
          error,
        } = await sb
          .from("widgets")
          .select("*")
          .eq(
            "tenant_id",
            tenant.id
          )
          .order(
            "created_at",
            {
              ascending: false,
            }
          );

        if (error) {
          return err(
            error.message,
            500
          );
        }

        return json(
          data ?? []
        );
      }

      /* ─────────────────────────────────────────────────────────────
         إنشاء Widget
      ───────────────────────────────────────────────────────────── */

      case "widget_dashboard_create": {
        const name =
          String(
            body.name ??
              ""
          )
            .trim()
            .slice(0, 100);

        if (!name) {
          return err(
            "اسم الـ Widget مطلوب"
          );
        }

        const settings =
          body.settings ??
          {};

        const suggested =
          Array.isArray(
            settings.suggestedQuestions
          )
            ? settings.suggestedQuestions
                .map(
                  (x: any) =>
                    String(x)
                      .trim()
                      .slice(
                        0,
                        200
                      )
                )
                .filter(Boolean)
                .slice(0, 20)
            : [];

        const {
          data,
          error,
        } = await sb
          .from("widgets")
          .insert({
            tenant_id:
              tenant.id,

            name,

            enabled:
              true,

            welcome_message:
              String(
                settings.welcomeMessage ??
                  "مرحباً! كيف يمكنني مساعدتك؟"
              ).slice(
                0,
                500
              ),

            primary_color:
              String(
                settings.primaryColor ??
                  "#2ec27e"
              ).slice(
                0,
                30
              ),

            position:
              settings.position ===
              "right"
                ? "right"
                : "left",

            language:
              "ar",

            rtl:
              true,

            avatar_url:
              settings.avatarUrl ??
              null,

            show_branding:
              settings.showBranding !==
              false,

            placeholder:
              String(
                settings.placeholder ??
                  "اكتب رسالتك..."
              ).slice(
                0,
                200
              ),

            suggested_questions:
              suggested,
          })
          .select("*")
          .single();

        if (
          error ||
          !data
        ) {
          return err(
            error?.message ??
              "تعذر إنشاء Widget",
            500
          );
        }

        return json(
          data,
          201
        );
      }

      /* ─────────────────────────────────────────────────────────────
         تحديث Widget
      ───────────────────────────────────────────────────────────── */

      case "widget_dashboard_update": {
        const id =
          String(
            body.widgetId ??
              ""
          ).trim();

        if (!id) {
          return err(
            "Widget ID مطلوب"
          );
        }

        const {
          data: existing,
        } = await sb
          .from("widgets")
          .select("*")
          .eq(
            "id",
            id
          )
          .eq(
            "tenant_id",
            tenant.id
          )
          .maybeSingle();

        if (!existing) {
          return err(
            "Widget غير موجود",
            404
          );
        }

        const patch: Record<
          string,
          unknown
        > = {};

        if (
          typeof body.enabled ===
          "boolean"
        ) {
          patch.enabled =
            body.enabled;
        }

        if (
          body.settings &&
          typeof body.settings ===
            "object"
        ) {
          const settings =
            body.settings;

          if (
            settings.welcomeMessage !==
            undefined
          ) {
            patch.welcome_message =
              String(
                settings.welcomeMessage
              ).slice(
                0,
                500
              );
          }

          if (
            settings.primaryColor !==
            undefined
          ) {
            patch.primary_color =
              String(
                settings.primaryColor
              ).slice(
                0,
                30
              );
          }

          if (
            settings.position !==
            undefined
          ) {
            patch.position =
              settings.position ===
              "right"
                ? "right"
                : "left";
          }

          if (
            settings.placeholder !==
            undefined
          ) {
            patch.placeholder =
              String(
                settings.placeholder
              ).slice(
                0,
                200
              );
          }

          if (
            settings.showBranding !==
            undefined
          ) {
            patch.show_branding =
              settings.showBranding !==
              false;
          }

          if (
            Array.isArray(
              settings.suggestedQuestions
            )
          ) {
            patch.suggested_questions =
              settings
                .suggestedQuestions
                .map(
                  (x: any) =>
                    String(x)
                      .trim()
                      .slice(
                        0,
                        200
                      )
                )
                .filter(Boolean)
                .slice(
                  0,
                  20
                );
          }

          if (
            settings.avatarUrl !==
            undefined
          ) {
            patch.avatar_url =
              settings.avatarUrl ??
              null;
          }
        }

        if (!Object.keys(patch).length) {
          return json(
            existing
          );
        }

        const {
          data,
          error,
        } = await sb
          .from("widgets")
          .update(patch)
          .eq(
            "id",
            id
          )
          .eq(
            "tenant_id",
            tenant.id
          )
          .select("*")
          .single();

        if (
          error ||
          !data
        ) {
          return err(
            error?.message ??
              "تعذر تحديث Widget",
            500
          );
        }

        return json(
          data
        );
      }

      /* ─────────────────────────────────────────────────────────────
         حذف Widget
      ───────────────────────────────────────────────────────────── */

      case "widget_dashboard_delete": {
        const id =
          String(
            body.widgetId ??
              ""
          ).trim();

        if (!id) {
          return err(
            "Widget ID مطلوب"
          );
        }

        const {
          error,
        } = await sb
          .from("widgets")
          .delete()
          .eq(
            "id",
            id
          )
          .eq(
            "tenant_id",
            tenant.id
          );

        if (error) {
          return err(
            error.message,
            500
          );
        }

        return json({
          ok: true,
        });
      }

      /* ═══════════════════════════════════════════════════════════════
         SUMMARY
      ═══════════════════════════════════════════════════════════════ */

      case "summary": {
        const [
          oq,
          cc,
        ] =
          await Promise.all([
            sb
              .from(
                "unresolved_questions"
              )
              .select(
                "id",
                {
                  count:
                    "exact",
                  head: true,
                }
              )
              .eq(
                "tenant_id",
                tenant.id
              )
              .eq(
                "status",
                "open"
              ),

            sb
              .from(
                "conversations"
              )
              .select(
                "id",
                {
                  count:
                    "exact",
                  head: true,
                }
              )
              .eq(
                "tenant_id",
                tenant.id
              ),
          ]);

        const phoneId =
          await boundPhone(
            sb,
            tenant.id
          );

        return json({
          tenant: {
            id:
              tenant.id,

            businessName:
              tenant.business_name,

            isActive:
              tenant.is_active,

            creditsRemaining:
              tenant.credits_remaining,

            phone:
              null,
          },

          wa: {
            status:
              phoneId
                ? "connected"
                : "disconnected",

            cloudApi:
              true,

            phoneId,
          },

          openUnresolved:
            oq.count ??
            0,

          conversations:
            cc.count ??
            0,
        });
      }

      /* ═══════════════════════════════════════════════════════════════
         CONVERSATIONS
      ═══════════════════════════════════════════════════════════════ */

      case "conversations": {
        const {
          data,
          error,
        } = await sb
          .from(
            "conversations"
          )
          .select(
            "id, wa_chat_id, customer_phone_encrypted, customer_name, customer_avatar, channel, account_id, transferred, auto_paused_reason, last_message_at"
          )
          .eq(
            "tenant_id",
            tenant.id
          )
          .order(
            "last_message_at",
            {
              ascending:
                false,
            }
          )
          .limit(50);

        if (error) {
          return err(
            error.message,
            500
          );
        }

        const rows = [];

        for (
          const c of
            data ?? []
        ) {
          rows.push({
            id:
              c.id,

            customerPhone:
              await decryptField(
                c.customer_phone_encrypted
              ),

            customerName:
              c.customer_name ?? null,

            customerAvatar:
              c.customer_avatar ?? null,

            channel:
              c.channel ?? null,

            accountId:
              c.account_id ?? null,

            transferred:
              c.transferred,

            autoPausedReason:
              c.auto_paused_reason,

            lastMessageAt:
              c.last_message_at,
          });
        }

        return json(
          rows
        );
      }

      /* ═══════════════════════════════════════════════════════════════
         MESSAGES
      ═══════════════════════════════════════════════════════════════ */

      case "messages": {
        const {
          data,
          error,
        } = await sb
          .from("messages")
          .select(
            "id,direction,body_encrypted,kind,is_auto,created_at"
          )
          .eq(
            "tenant_id",
            tenant.id
          )
          .eq(
            "conversation_id",
            body.convId ??
              ""
          )
          .order(
            "created_at"
          )
          .limit(200);

        if (error) {
          return err(
            error.message,
            500
          );
        }

        const rows = [];

        for (
          const m of
            data ?? []
        ) {
          rows.push({
            ...m,

            body:
              await decryptField(
                m.body_encrypted
              ),
          });
        }

        return json(
          rows
        );
      }

      /* ═══════════════════════════════════════════════════════════════
         MANUAL REPLY
      ═══════════════════════════════════════════════════════════════ */

      case "reply": {
        const {
          convId,
          text,
          resumeAuto,
        } = body;

        if (
          !text?.trim()
        ) {
          return err(
            "نص الرد فارغ"
          );
        }

        const {
          data: conv,
        } = await sb
          .from(
            "conversations"
          )
          .select("*")
          .eq(
            "id",
            convId ??
              ""
          )
          .eq(
            "tenant_id",
            tenant.id
          )
          .maybeSingle();

        if (!conv) {
          return err(
            "المحادثة غير موجودة",
            404
          );
        }

        try {
          await sendToConversation(
            sb,
            tenant.id,
            conv,
            text.trim()
          );
        } catch (e) {
          if (e instanceof WaAuthError) throw e;

          return err(
            e instanceof Error
              ? e.message
              : "فشل الإرسال",
            400
          );
        }

        await sb
          .from(
            "messages"
          )
          .insert({
            conversation_id:
              conv.id,

            tenant_id:
              tenant.id,

            direction:
              "out",

            body_encrypted:
              await encryptField(
                text.trim()
              ),

            kind:
              "manual",

            is_auto:
              false,
          });

        const patch:
          Record<
            string,
            unknown
          > = {
          last_message_at:
            new Date().toISOString(),
        };

        if (
          resumeAuto
        ) {
          Object.assign(
            patch,
            {
              transferred:
                false,

              auto_paused_reason:
                null,
            }
          );
        }

        await sb
          .from(
            "conversations"
          )
          .update(patch)
          .eq(
            "id",
            conv.id
          );

        return json({
          ok: true,
        });
      }

      /* ═══════════════════════════════════════════════════════════════
         UNRESOLVED
      ═══════════════════════════════════════════════════════════════ */

      /* ═══════════════════════════════════════════════════════════════
         HUMAN AGENT — takeover / release
      ═══════════════════════════════════════════════════════════════ */

      case "takeover": {
        const { convId } = body;

        if (!convId) return err("convId مطلوب");

        const expiresAt = new Date(
          Date.now() + 15 * 60 * 1000
        ).toISOString();

        const { error: upErr } = await sb
          .from("conversations")
          .update({
            transferred: true,
            auto_paused_reason: "manual_takeover",
            human_agent_expires_at: expiresAt,
          })
          .eq("id", convId)
          .eq("tenant_id", tenant.id);

        if (upErr) return err(upErr.message, 500);

        return json({ ok: true, expiresAt });
      }

      case "release": {
        const { convId } = body;

        if (!convId) return err("convId مطلوب");

        const { error: upErr } = await sb
          .from("conversations")
          .update({
            transferred: false,
            auto_paused_reason: null,
            human_agent_expires_at: null,
          })
          .eq("id", convId)
          .eq("tenant_id", tenant.id);

        if (upErr) return err(upErr.message, 500);

        return json({ ok: true });
      }

      case "unresolved": {
        const {
          data,
          error,
        } = await sb
          .from(
            "unresolved_questions"
          )
          .select(
            "id, question_encrypted, status, manual_answer, added_to_kb, created_at, conversation_id, best_similarity"
          )
          .eq(
            "tenant_id",
            tenant.id
          )
          .order(
            "created_at",
            {
              ascending:
                false,
            }
          )
          .limit(100);

        if (error) {
          return err(
            error.message,
            500
          );
        }

        const rows = [];

        for (
          const q of
            data ?? []
        ) {
          rows.push({
            id:
              q.id,

            question:
              await decryptField(
                q.question_encrypted
              ),

            status:
              q.status,

            manualAnswer:
              q.manual_answer,

            addedToKb:
              q.added_to_kb,

            createdAt:
              q.created_at,

            conversationId:
              q.conversation_id,

            bestSimilarity:
              q.best_similarity ??
              null,
          });
        }

        return json(
          rows
        );
      }

      /* ═══════════════════════════════════════════════════════════════
         RESOLVE
      ═══════════════════════════════════════════════════════════════ */

      case "resolve": {
        const {
          id,
          answer,
          saveToKb,
          sendToCustomer,
        } = body;

        if (
          !answer?.trim()
        ) {
          return err(
            "الإجابة فارغة"
          );
        }

        const {
          data: q,
        } = await sb
          .from(
            "unresolved_questions"
          )
          .select("*")
          .eq(
            "id",
            id ?? ""
          )
          .eq(
            "tenant_id",
            tenant.id
          )
          .maybeSingle();

        if (!q) {
          return err(
            "السؤال غير موجود",
            404
          );
        }

        if (saveToKb) {
          const question =
            await decryptField(
              q.question_encrypted
            );

          const content =
            `س: ${question}\nج: ${answer.trim()}`;

          const [v] =
            await embed([
              content,
            ]);

          await sb
            .from(
              "knowledge_chunks"
            )
            .insert({
              tenant_id:
                tenant.id,

              source_id:
                null,

              chunk_index:
                0,

              content,

              embedding:
                pg(v),
            });
        }

        await sb
          .from(
            "unresolved_questions"
          )
          .update({
            status:
              "resolved",

            manual_answer:
              answer.trim(),

            added_to_kb:
              Boolean(
                saveToKb
              ),

            resolved_at:
              new Date().toISOString(),
          })
          .eq(
            "id",
            q.id
          );

        if (
          sendToCustomer &&
          q.conversation_id
        ) {
          const {
            data: conv,
          } = await sb
            .from(
              "conversations"
            )
            .select(
              "wa_chat_id, channel, account_id"
            )
            .eq(
              "id",
              q.conversation_id
            )
            .maybeSingle();

          if (conv) {
            try {
              await sendToConversation(
                sb,
                tenant.id,
                conv,
                answer.trim()
              );

              await sb
                .from(
                  "messages"
                )
                .insert({
                  conversation_id:
                    q.conversation_id,

                  tenant_id:
                    tenant.id,

                  direction:
                    "out",

                  body_encrypted:
                    await encryptField(
                      answer.trim()
                    ),

                  kind:
                    "manual",

                  is_auto:
                    false,
                });
            } catch (e) {
              console.error(
                "[unresolved] send failed",
                e
              );
            }
          }
        }

        return json({
          ok: true,
        });
      }

      /* ═══════════════════════════════════════════════════════════════
         KNOWLEDGE
      ═══════════════════════════════════════════════════════════════ */

      case "knowledge": {
        const {
          data,
          error,
        } = await sb
          .from(
            "knowledge_sources"
          )
          .select(
            "id, kind, url, status, error, chunks_count, created_at"
          )
          .eq(
            "tenant_id",
            tenant.id
          )
          .order(
            "created_at",
            {
              ascending:
                false,
            }
          );

        if (error) {
          return err(
            error.message,
            500
          );
        }

        return json(
          data ?? []
        );
      }

      /* ═══════════════════════════════════════════════════════════════
         KNOWLEDGE ADD
      ═══════════════════════════════════════════════════════════════ */

      case "knowledge_add": {
        const {
          url,
          text,
        } = body;

        if (
          url?.trim()
        ) {
          const {
            title,
            text: raw2,
          } =
            await extractFromUrl(
              url.trim()
            );

          if (
            raw2.length < 40
          ) {
            return err(
              "المحتوى غير كافٍ",
              502
            );
          }

          const chunks =
            chunkText(
              raw2
            );

          const vectors =
            await embed(
              chunks
            );

          const {
            data: src,
            error: srcError,
          } = await sb
            .from(
              "knowledge_sources"
            )
            .insert({
              tenant_id:
                tenant.id,

              kind:
                "website",

              url:
                url.trim(),

              status:
                "indexed",

              chunks_count:
                chunks.length,
            })
            .select()
            .single();

          if (
            srcError ||
            !src
          ) {
            return err(
              srcError?.message ??
                "تعذر إنشاء المصدر",
              500
            );
          }

          const {
            error:
              chunksError,
          } = await sb
            .from(
              "knowledge_chunks"
            )
            .insert(
              chunks.map(
                (
                  content,
                  i
                ) => ({
                  tenant_id:
                    tenant.id,

                  source_id:
                    src.id,

                  chunk_index:
                    i,

                  content,

                  embedding:
                    pg(
                      vectors[i]
                    ),
                })
              )
            );

          if (
            chunksError
          ) {
            return err(
              chunksError.message,
              500
            );
          }

          return json({
            status:
              "indexed",

            chunks:
              chunks.length,

            title,
          });
        }

        const t =
          String(
            text ??
              ""
          ).trim();

        if (
          t.length < 20
        ) {
          return err(
            "النص قصير جدًا"
          );
        }

        const chunks =
          chunkText(t);

        const vectors =
          await embed(
            chunks
          );

        const {
          data: src,
          error: srcError,
        } = await sb
          .from(
            "knowledge_sources"
          )
          .insert({
            tenant_id:
              tenant.id,

            kind:
              "manual",

            status:
              "indexed",

            chunks_count:
              chunks.length,

            raw_text_encrypted:
              await encryptField(
                t
              ),
          })
          .select()
          .single();

        if (
          srcError ||
          !src
        ) {
          return err(
            srcError?.message ??
              "تعذر إنشاء المصدر",
            500
          );
        }

        const {
          error:
            chunksError,
        } = await sb
          .from(
            "knowledge_chunks"
          )
          .insert(
            chunks.map(
              (
                content,
                i
              ) => ({
                tenant_id:
                  tenant.id,

                source_id:
                  src.id,

                chunk_index:
                  i,

                content,

                embedding:
                  pg(
                    vectors[i]
                  ),
              })
            )
          );

        if (
          chunksError
        ) {
          return err(
            chunksError.message,
            500
          );
        }

        return json({
          status:
            "indexed",

          chunks:
            chunks.length,
        });
      }

      /* ═══════════════════════════════════════════════════════════════
         KNOWLEDGE DELETE
      ═══════════════════════════════════════════════════════════════ */

      case "knowledge_delete": {
        const {
          error,
        } = await sb
          .from(
            "knowledge_sources"
          )
          .delete()
          .eq(
            "id",
            body.sourceId ??
              ""
          )
          .eq(
            "tenant_id",
            tenant.id
          );

        if (error) {
          return err(
            error.message,
            500
          );
        }

        return json({
          ok: true,
        });
      }

      /* ═══════════════════════════════════════════════════════════════
         PAYMENT CREATE
      ═══════════════════════════════════════════════════════════════ */

      case "pay_create": {
        const packages: Record<
          string,
          {
            name: string;
            credits: number;
            amount: number;
          }
        > = {
          starter: {
            name:
              "باقة البداية",
            credits:
              1000,
            amount:
              9900,
          },

          growth: {
            name:
              "باقة النمو",
            credits:
              3000,
            amount:
              24900,
          },

          scale: {
            name:
              "باقة التوسع",
            credits:
              10000,
            amount:
              64900,
          },
        };

        const p =
          packages[
            body.packageId
          ] ??
          packages.starter;

        const res =
          await fetch(
            "https://api.moyasar.com/v1/invoices",
            {
              method:
                "POST",

              headers: {
                "content-type":
                  "application/json",

                authorization:
                  `Basic ${btoa(
                    env(
                      "MOYASAR_SECRET_KEY"
                    ) + ":"
                  )}`,
              },

              body: JSON.stringify(
                {
                  amount:
                    p.amount,

                  currency:
                    "SAR",

                  description:
                    `ميلانو — ${p.name} (${p.credits} رد) — ${tenant.business_name}`,

                  callback_url:
                    `${env(
                      "SUPABASE_URL"
                    )}/functions/v1/milan-api?action=pay_webhook`,

                  metadata: {
                    tenant_id:
                      tenant.id,
                  },
                }
              ),
            }
          );

        if (!res.ok) {
          return err(
            `Moyasar ${res.status}: ${await res.text()}`,
            502
          );
        }

        const inv: any =
          await res.json();

        const {
          error,
        } = await sb
          .from(
            "payments"
          )
          .insert({
            tenant_id:
              tenant.id,

            provider:
              "moyasar",

            invoice_id:
              inv.id,

            amount:
              p.amount,

            currency:
              "SAR",

            status:
              "created",

            credits_granted:
              0,
          });

        if (error) {
          return err(
            error.message,
            500
          );
        }

        return json({
          invoiceId:
            inv.id,

          paymentUrl:
            inv.transaction
              ?.url ??
            inv.url ??
            null,
        });
      }
    }

    return err(
      `إجراء غير معروف: ${action}`,
      404
    );
  } catch (e) {
    console.error(
      `[milan-api:${action}]`,
      e
    );

    if (e instanceof WaAuthError) {
      return err(e.message, 502);
    }

    return err(
      e instanceof Error
        ? e.message
        : "خطأ داخلي",
      500
    );
  }
});
