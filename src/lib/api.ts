/**
 * عميل API للواجهة — نمطان يعملان تلقائيًا حسب متغيرات البيئة:
 *
 * 1) supabase : VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY مضبوطان → Edge Functions
 *               (الوضع الوحيد المعتمد حاليًا — خادم Railway أُغلق وحُذف نهائيًا)
 * 2) demo     : لا شيء منهما → وضع العرض
 *
 * ملاحظة: VITE_API_URL لم يعد يُقرأ من أي مكان؛ المسارات القديمة ذات النمط
 * "/api/..." تُخدم الآن بالكامل عبر دوال Supabase Edge Functions.
 */
const env = (((import.meta as any).env ?? {}) as Record<string, string | undefined>);
const SUPABASE_URL = (env.VITE_SUPABASE_URL ?? "").replace(/\/+$/, "");
const SUPABASE_ANON = env.VITE_SUPABASE_ANON_KEY ?? "";

/** رابط دوال Supabase Edge Functions — يمكن تجاوزه بمتغير البيئة النظيف:
 *  VITE_SUPABASE_FUNCTIONS_URL (افتراضيًا مشتق من VITE_SUPABASE_URL) */
export const FUNCTIONS_BASE =
  (env.VITE_SUPABASE_FUNCTIONS_URL ?? (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1` : "")).replace(/\/+$/, "");

const HAS_SUPABASE = FUNCTIONS_BASE.length > 0 && SUPABASE_ANON.length > 0;

export const apiEnabled = false; // لا خادم خارجي بعد اليوم
export const apiBase = FUNCTIONS_BASE;

export type BackendMode = "supabase" | "demo";
export const backendMode: BackendMode = HAS_SUPABASE ? "supabase" : "demo";

/** عنوان Edge Function الواحدة التي تحوي الباك-إند كله */
const FN_URL = `${FUNCTIONS_BASE}/milan-api`;
const CHANNELS_FN_URL = `${FUNCTIONS_BASE}/channels`;
const WA_FN_URL = `${FUNCTIONS_BASE}/wa-webhook`;

/* ─── نقل عام (عام فقط — لم يعد يوجد خادم خارجي) ─── */

export async function apiFetch<T>(_path: string, _init?: RequestInit): Promise<T> {
  throw new Error("الخادم الخارجي أُغلق نهائيًا — جميع الطلبات تُخدم عبر Supabase Edge Functions.");
}

/** طلبات موثقة: توكن Supabase Auth أو رمز جلسة المعالج — تُخدم دائمًا من Edge Functions */
export async function apiAuthFetch<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  return dashSupabase<T>(token, path, init);
}

/** شحن الرصيد بالدينار العراقي عبر Wayl (دالة topup-create). */
async function topupSupabase(
  packageId: string,
  token?: string | null,
): Promise<{ invoiceId: string; paymentUrl: string | null }> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/topup-create`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: SUPABASE_ANON,
      authorization: `Bearer ${token ?? ""}`,
    },
    body: JSON.stringify({ packageId, returnUrl: window.location.href.split("#")[0] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any)?.error ?? `HTTP ${res.status}`);
  return data as { invoiceId: string; paymentUrl: string | null };
}

/** نداء Edge Function في نمط Supabase */
async function fn<T>(
  action: string,
  opts: { body?: unknown; token?: string | null; claim?: string | null; wa?: boolean } = {}
): Promise<T> {
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

/** نداء دالة channels منفصلة في Supabase */
async function channelsFn<T>(
  token: string,
  channelPath: string,
  init?: RequestInit
): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const body: Record<string, unknown> = init?.body ? JSON.parse(init.body as string) : {};
  // دعم تمرير query string داخل المسار نفسه (مثل /meta/oauth-url?channel=instagram&debug=1)
  const [rawPath, rawQuery = ""] = channelPath.split("?");
  const qsParams = new URLSearchParams(rawQuery);
  for (const [k, v] of Object.entries(body)) {
    if (typeof v === "string") qsParams.set(k, v);
  }
  const qs = qsParams.toString();

  const url = `${CHANNELS_FN_URL}${rawPath}${qs ? `?${qs}` : ""}`;

  const res = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      apikey: SUPABASE_ANON,
      authorization: `Bearer ${token}`,
    },
    body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any)?.error ?? `HTTP ${res.status}`);
  return data as T;
}

/** ترجمة مسارات لوحة التحكم إلى إجراءات Edge Function */
async function dashSupabase<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const body: Record<string, unknown> = init?.body ? JSON.parse(init.body as string) : {};
  const method = (init?.method ?? "GET").toUpperCase();

  // ─── بدء OAuth القديم (خادم Railway أُغلق) → توجيه مباشر إلى دالة channels ───
  if (path === "/api/auth/facebook/start" && method === "POST") {
    const platform = String(body.platform ?? "instagram");
    return channelsFn<T>(token, `/meta/oauth-url?channel=${encodeURIComponent(platform)}`, init);
  }

  // ─── مسارات القنوات → دالة channels منفصلة ───
  if (path.startsWith("/api/channels/")) {
    const channelPath = path.replace(/^\/api\/channels/, "");
    return channelsFn<T>(token, channelPath, init);
  }

  // ─── قنوات Dashboard (social channels) → دالة channels أيضاً ───
  if (path === "/api/dashboard/channels" || path.startsWith("/api/dashboard/channels?")) {
    return channelsFn<T>(token, "/accounts", init);
  }

  // ─── مسارات Widgets → milan-api ───
  if (path.startsWith("/api/widgets/dashboard")) {
    const sub = path.replace("/api/widgets/dashboard", "").replace(/^\//, "");
    let action: string;
    if (!sub) {
      action = method === "POST" ? "widget_dashboard_create" : "widget_dashboard_list";
    } else {
      body.widgetId = sub;
      action = method === "DELETE" ? "widget_dashboard_delete" : "widget_dashboard_update";
    }
    return fn<T>(action, { body, token });
  }

  // ─── رسالة توجيه الوكيل → دالة agent-prompt منفصلة ───
  if (path === "/api/dashboard/agent-prompt" || path.startsWith("/api/dashboard/agent-prompt?")) {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/agent-prompt`, {
      method: method === "POST" ? "POST" : "GET",
      headers: {
        "content-type": "application/json",
        apikey: SUPABASE_ANON,
        authorization: `Bearer ${token}`,
      },
      body: method === "POST" ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as any)?.error ?? `HTTP ${res.status}`);
    return data as T;
  }

  // ─── مسارات dashboard القياسية → milan-api ───
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
  } else if (/^conversations\/[^/]+\/takeover$/.test(sub)) {
    action = "takeover";
    body.convId = sub.split("/")[1];
  } else if (/^conversations\/[^/]+\/release$/.test(sub)) {
    action = "release";
    body.convId = sub.split("/")[1];
  } else if (/^unresolved\/[^/]+\/resolve$/.test(sub)) {
    action = "resolve";
    body.id = sub.split("/")[1];
  } else if (path === "/api/payments/create") action = "pay_create";

  // معاينة آخر رسالة لكل محادثة (من دالة conversation-previews) تُدمج في القائمة
  if (action === "conversations") {
    const rows = await fn<any[]>(action, { body, token });
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/conversation-previews`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          apikey: SUPABASE_ANON,
          authorization: `Bearer ${token}`,
        },
        body: "{}",
      });
      if (res.ok) {
        const { previews } = (await res.json()) as { previews?: Record<string, string> };
        for (const r of rows) {
          if (!r.lastMessageBody && previews?.[r.id]) r.lastMessageBody = previews[r.id];
        }
      }
    } catch {
      /* المعاينة اختيارية — تستمر القائمة بدونها */
    }
    return rows as unknown as T;
  }

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
  | "CONNECTING"
  | "CONNECTED"
  | "DISCONNECTED"
  | "UNBOUND"
  | "ERROR";

export type WaSnapshot = {
  sessionId: string;
  state: WAState;
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

/** رمز جلسة المعالج المحفوظ */
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
      ? fn<{ pairs: QAPair[] }>("qa_extract", { body: { tenantId, url }, claim: storedClaim() }).then((r) =>
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

  wa: {
    createSession: (tenantId: string, token?: string | null) =>
      backendMode === "supabase"
        ? fn<{ bound: boolean; phoneId: string | null }>("ping", { body: { tenantId }, wa: true }).then(
            (r): WaSnapshot => ({
              sessionId: tenantId,
              state: r.bound ? "CONNECTED" : "UNBOUND",
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
              phone: r.phoneId,
              error: null,
            })
          )
        : apiFetch<WaSnapshot>(`/api/whatsapp/session/${sessionId}`, { headers: authHeaders(token) }),

    getQr: (sessionId: string, token?: string | null) =>
      api.wa.getSession(sessionId, token),

    logout: (sessionId: string, token?: string | null) =>
      backendMode === "supabase"
        ? Promise.resolve({ ok: true as const })
        : apiFetch<{ ok: true }>(`/api/whatsapp/session/${sessionId}/logout`, {
            method: "POST",
            headers: authHeaders(token),
          }),

    bindNumber: (tenantId: string, phoneId: string) =>
      fn<{ ok: true }>("bind_number", { body: { tenantId, phoneId }, claim: storedClaim() ?? tenantId }),

    eventsUrl: (sessionId: string, token?: string | null) =>
      backendMode === "supabase"
        ? ""
        : `${API}/api/whatsapp/session/${sessionId}/events?token=${encodeURIComponent(token ?? "")}`,
  },

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

  testQA: (tenantId: string, text: string) =>
    backendMode === "supabase"
      ? fn<SemanticTestRes>("qa_test", { body: { tenantId, text }, claim: storedClaim() })
      : apiFetch<SemanticTestRes>(`/api/tenants/${tenantId}/qa/test`, {
          method: "POST",
          body: JSON.stringify({ text }),
        }),

  createPayment: (tenantId: string, packageId: string, token?: string | null) =>
    backendMode === "supabase"
      ? topupSupabase(packageId, token)
      : apiFetch<{ invoiceId: string; paymentUrl: string | null }>("/api/payments/create", {
          method: "POST",
          body: JSON.stringify({ tenantId, packageId }),
        }),
};
