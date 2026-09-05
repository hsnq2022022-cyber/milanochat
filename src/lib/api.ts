/**
 * عميل API للواجهة — ثلاثة أنماط تعمل تلقائيًا حسب متغيرات البيئة:
 *
 * 1) server   : VITE_API_URL مضبوط → الخادم التقليدي (Baileys + Express)
 * 2) supabase : بدون VITE_API_URL ومع VITE_SUPABASE_URL/ANON → Edge Functions
 *               (كل شيء على Supabase: واتساب عبر Cloud API الرسمية، معرفة، لوحة، دفع)
 * 3) demo     : لا شيء منهما → وضع العرض التجريبي
 */
const env = (((import.meta as any).env ?? {}) as Record<string, string | undefined>);
const API = (env.VITE_API_URL ?? "").replace(/\/+$/, "");
const SUPABASE_URL = (env.VITE_SUPABASE_URL ?? "").replace(/\/+$/, "");
const SUPABASE_ANON = env.VITE_SUPABASE_ANON_KEY ?? "";

export const apiEnabled = API.length > 0;
export const apiBase = API;

export type BackendMode = "server" | "supabase" | "demo";
export const backendMode: BackendMode = apiEnabled
  ? "server"
  : SUPABASE_URL && SUPABASE_ANON
    ? "supabase"
    : "demo";

/** عنوان Edge Function الواحدة التي تحوي الباك-إند كله */
const FN_URL = `${SUPABASE_URL}/functions/v1/milan-api`;
const WA_FN_URL = `${SUPABASE_URL}/functions/v1/wa-webhook`;

/* ─── نقل عام ─── */

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any)?.error ?? `HTTP ${res.status}`);
  return data as T;
}

/** طلبات موثقة: توكن Supabase Auth أو رمز جلسة المعالج */
export async function apiAuthFetch<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  if (backendMode === "supabase") return dashSupabase<T>(token, path, init);
  const res = await fetch(`${API}${path}`, {
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    ...init,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any)?.error ?? `HTTP ${res.status}`);
  return data as T;
}

/** نداء Edge Function في نمط Supabase */
async function fn<T>(action: string, opts: { body?: unknown; token?: string | null; claim?: string | null; wa?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    apikey: SUPABASE_ANON,
    authorization: `Bearer ${opts.token && opts.token.split(".").length === 3 ? opts.token : SUPABASE_ANON}`,
  };
  if (opts.claim) headers["x-tenant-token"] = opts.claim;
  const res = await fetch(`${opts.wa ? WA_FN_URL : FN_URL}?action=${action}`, {
    method: "POST",
    headers,
    body: JSON.stringify(opts.body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any)?.error ?? `HTTP ${res.status}`);
  return data as T;
}

/** ترجمة مسارات لوحة التحكم إلى إجراءات Edge Function */
async function dashSupabase<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const body: Record<string, unknown> = init?.body ? JSON.parse(init.body as string) : {};
  const method = (init?.method ?? "GET").toUpperCase();
  const m = path.match(/^\/api\/dashboard\/(.*)$/);
  const sub = m?.[1] ?? path;

  let action = "";
  if (sub === "claim") action = "claim_account";
  else if (sub === "summary") action = "summary";
  else if (sub === "conversations") action = "conversations";
  else if (sub === "unresolved") action = "unresolved";
  else if (sub === "knowledge" && method === "GET") action = "knowledge";
  else if (sub === "knowledge" && method === "POST") action = "knowledge_add";
  else if (sub.startsWith("knowledge/")) {
    action = "knowledge_delete";
    body.sourceId = sub.split("/")[1];
  } else if (/^conversations\/[^/]+\/messages$/.test(sub)) {
    action = "messages";
    body.convId = sub.split("/")[1];
  } else if (/^conversations\/[^/]+\/reply$/.test(sub)) {
    action = "reply";
    body.convId = sub.split("/")[1];
  } else if (/^unresolved\/[^/]+\/resolve$/.test(sub)) {
    action = "resolve";
    body.id = sub.split("/")[1];
  } else if (path === "/api/payments/create") action = "pay_create";

  if (!action) throw new Error(`مسار غير مدعوم في نمط Supabase: ${path}`);
  return fn<T>(action, { body, token });
}

/** توكن Supabase (JWT) يُرسل كـ Bearer، وتوكن جلسة المعالج كرأس خاص */
const authHeaders = (token?: string | null): Record<string, string> => {
  if (!token) return {};
  return token.split(".").length === 3
    ? { authorization: `Bearer ${token}` }
    : { "x-tenant-token": token };
};

/* ─── أنواع ─── */
export type CreateTenantRes = { tenantId: string; claimToken: string };
export type IngestRes = {
  sourceId?: string;
  status: "indexed" | "failed";
  chunks: number;
  error?: string;
  title?: string;
};
export type QrRes = {
  status: "idle" | "starting" | "qr" | "connecting" | "connected" | "disconnected";
  qrDataUrl: string | null;
  phone: string | null;
};

export type WAState =
  | "QR_REQUIRED"
  | "CONNECTING"
  | "CONNECTED"
  | "DISCONNECTED"
  | "LOGGED_OUT"
  | "UNBOUND"
  | "ERROR";

export type WaSnapshot = {
  sessionId: string;
  state: WAState;
  qrDataUrl: string | null;
  phone: string | null;
  error: string | null;
};

/* ─── عمليات الإعداد ─── */
export type QAPair = { question: string; answer: string };

export type SemanticTestRes = {
  confident: boolean;
  bestSimilarity: number;
  threshold: number;
  matches: { id: string; content: string; similarity: number }[];
  answer: string | null;
};

/** رمز جلسة المعالج المحفوظ (يُستخدم في نمط Supabase لتفويض إجراءات الإعداد) */
const storedClaim = () => localStorage.getItem("milano_claim");

export const api = {
  createTenant: (
    businessName: string,
    sourceType: "gmaps" | "website" | "manual",
    sourceUrl?: string,
    phoneE164?: string
  ) =>
    backendMode === "supabase"
      ? fn<CreateTenantRes>("create_tenant", { body: { businessName, sourceType, sourceUrl, phoneE164 } })
      : apiFetch<CreateTenantRes>("/api/tenants", {
          method: "POST",
          body: JSON.stringify({ businessName, sourceType, sourceUrl, phoneE164 }),
        }),

  ingestUrl: (tenantId: string, url: string) =>
    backendMode === "supabase"
      ? // نمط Supabase: استخراج الأسئلة والأجوبة من الرابط ثم حفظها كقاعدة معرفة
        fn<{ pairs: QAPair[] }>("qa_extract", { body: { tenantId, url }, claim: storedClaim() }).then((r) =>
          fn<IngestRes>("qa_save", { body: { tenantId, pairs: r.pairs, sourceUrl: url }, claim: storedClaim() })
        )
      : apiFetch<IngestRes>(`/api/tenants/${tenantId}/knowledge`, {
          method: "POST",
          body: JSON.stringify({ url }),
        }),

  ingestText: (tenantId: string, text: string) =>
    backendMode === "supabase"
      ? fn<{ chunks: number }>("ingest_text", { body: { tenantId, text }, claim: storedClaim() }).then((r) => ({
          status: "indexed" as const,
          chunks: r.chunks,
        }))
      : apiFetch<IngestRes>(`/api/tenants/${tenantId}/knowledge`, {
          method: "POST",
          body: JSON.stringify({ text }),
        }),

  /* واتساب: Baileys في نمط الخادم — وCloud API الرسمية في نمط Supabase */
  wa: {
    createSession: (tenantId: string, token?: string | null) =>
      backendMode === "supabase"
        ? fn<{ bound: boolean; phoneId: string | null }>("ping", { body: { tenantId }, wa: true }).then(
            (r): WaSnapshot => ({
              sessionId: tenantId,
              state: r.bound ? "CONNECTED" : "UNBOUND",
              qrDataUrl: null,
              phone: r.phoneId,
              error: null,
            })
          )
        : apiFetch<WaSnapshot>("/api/whatsapp/session", {
            method: "POST",
            headers: authHeaders(token),
            body: JSON.stringify({ tenantId }),
          }),

    getSession: (sessionId: string, token?: string | null) =>
      backendMode === "supabase"
        ? fn<{ bound: boolean; phoneId: string | null }>("ping", { body: { tenantId: sessionId }, wa: true }).then(
            (r): WaSnapshot => ({
              sessionId,
              state: r.bound ? "CONNECTED" : "UNBOUND",
              qrDataUrl: null,
              phone: r.phoneId,
              error: null,
            })
          )
        : apiFetch<WaSnapshot>(`/api/whatsapp/session/${sessionId}`, { headers: authHeaders(token) }),

    getQr: (sessionId: string, token?: string | null) =>
      api.wa.getSession(sessionId, token),

    logout: (sessionId: string, token?: string | null) =>
      backendMode === "supabase"
        ? Promise.resolve({ ok: true as const }) // في Cloud API يُفصل الرقم من لوحة Meta
        : apiFetch<{ ok: true }>(`/api/whatsapp/session/${sessionId}/logout`, {
            method: "POST",
            headers: authHeaders(token),
          }),

    /** ربط رقم المنصة (Phone Number ID من Meta) بالعميل — نمط Supabase فقط */
    bindNumber: (tenantId: string, phoneId: string) =>
      fn<{ ok: true }>("bind_number", { body: { tenantId, phoneId }, claim: storedClaim() ?? tenantId }),

    /** رابط بث SSE اللحظي — فارغ في نمط Supabase (لا حاجة لبث؛ الحالة لحظية من الـ webhook) */
    eventsUrl: (sessionId: string, token?: string | null) =>
      backendMode === "supabase"
        ? ""
        : `${API}/api/whatsapp/session/${sessionId}/events?token=${encodeURIComponent(token ?? "")}`,
  },

  /* ── أسئلة وأجوبة من الرابط ── */
  extractQA: (tenantId: string, url: string) =>
    backendMode === "supabase"
      ? fn<{ pairs: QAPair[]; title: string }>("qa_extract", { body: { tenantId, url }, claim: storedClaim() })
      : apiFetch<{ pairs: QAPair[]; title: string }>(`/api/tenants/${tenantId}/qa/extract`, {
          method: "POST",
          body: JSON.stringify({ url }),
        }),

  saveQA: (tenantId: string, pairs: QAPair[], sourceUrl?: string | null) =>
    backendMode === "supabase"
      ? fn<{ saved: number; sourceId: string }>("qa_save", {
          body: { tenantId, pairs, sourceUrl: sourceUrl ?? null },
          claim: storedClaim(),
        })
      : apiFetch<{ saved: number; sourceId: string }>(`/api/tenants/${tenantId}/qa/save`, {
          method: "POST",
          body: JSON.stringify({ pairs, sourceUrl: sourceUrl ?? null }),
        }),

  /* ── مختبر الفهم الدلالي ── */
  testQA: (tenantId: string, text: string) =>
    backendMode === "supabase"
      ? fn<SemanticTestRes>("qa_test", { body: { tenantId, text }, claim: storedClaim() })
      : apiFetch<SemanticTestRes>(`/api/tenants/${tenantId}/qa/test`, {
          method: "POST",
          body: JSON.stringify({ text }),
        }),

  /* ── دفع ── */
  createPayment: (tenantId: string, packageId: string, token?: string | null) =>
    backendMode === "supabase"
      ? fn<{ invoiceId: string; paymentUrl: string | null }>("pay_create", { body: { packageId }, token })
      : apiFetch<{ invoiceId: string; paymentUrl: string | null }>("/api/payments/create", {
          method: "POST",
          body: JSON.stringify({ tenantId, packageId }),
        }),
};
