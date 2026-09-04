/**
 * عميل API للواجهة:
 * - إذا ضُبط VITE_API_URL تعمل الواجهة ضد الخادم الحقيقي (QR فعلي، فهرسة حقيقية).
 * - إذا تُرك فارغًا تبقى الواجهة بوضع العرض التجريبي الحالي بدون أي تغيير.
 */
const RAW = ((import.meta as any).env?.VITE_API_URL as string | undefined) ?? "";
const API = RAW.replace(/\/+$/, "");

export const apiEnabled = API.length > 0;
export const apiBase = API;

/** طلبات لوحة التحكم الموثقة (توكن Supabase Auth) */
export async function apiAuthFetch<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    ...init,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any)?.error ?? `HTTP ${res.status}`);
  return data as T;
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any)?.error ?? `HTTP ${res.status}`);
  return data as T;
}

/* ─── أنواع ─── */
export type CreateTenantRes = { tenantId: string; claimToken: string };
export type IngestRes = {
  sourceId: string;
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

/* ─── جلسات واتساب الحقيقية (الميزة: ربط فعلي) ─── */
export type WAState =
  | "QR_REQUIRED"
  | "CONNECTING"
  | "CONNECTED"
  | "DISCONNECTED"
  | "LOGGED_OUT"
  | "ERROR";

export type WaSnapshot = {
  sessionId: string;
  state: WAState;
  qrDataUrl: string | null;
  phone: string | null;
  error: string | null;
};

/** توكن Supabase (JWT) يُرسل كـ Bearer، وتوكن جلسة المعالج كرأس خاص */
const authHeaders = (token?: string | null): Record<string, string> => {
  if (!token) return {};
  return token.split(".").length === 3
    ? { authorization: `Bearer ${token}` }
    : { "x-tenant-token": token };
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

export const api = {
  createTenant: (
    businessName: string,
    sourceType: "gmaps" | "website" | "manual",
    sourceUrl?: string,
    phoneE164?: string
  ) =>
    apiFetch<CreateTenantRes>("/api/tenants", {
      method: "POST",
      body: JSON.stringify({ businessName, sourceType, sourceUrl, phoneE164 }),
    }),

  ingestUrl: (tenantId: string, url: string) =>
    apiFetch<IngestRes>(`/api/tenants/${tenantId}/knowledge`, {
      method: "POST",
      body: JSON.stringify({ url }),
    }),

  ingestText: (tenantId: string, text: string) =>
    apiFetch<IngestRes>(`/api/tenants/${tenantId}/knowledge`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),

  /* جلسات واتساب حقيقية: الجلسة تُنشأ في الخادم (Baileys) والواجهة تعرض فقط */
  wa: {
    createSession: (tenantId: string, token?: string | null) =>
      apiFetch<WaSnapshot>("/api/whatsapp/session", {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ tenantId }),
      }),

    getSession: (sessionId: string, token?: string | null) =>
      apiFetch<WaSnapshot>(`/api/whatsapp/session/${sessionId}`, { headers: authHeaders(token) }),

    getQr: (sessionId: string, token?: string | null) =>
      apiFetch<WaSnapshot>(`/api/whatsapp/session/${sessionId}/qr`, { headers: authHeaders(token) }),

    logout: (sessionId: string, token?: string | null) =>
      apiFetch<{ ok: true }>(`/api/whatsapp/session/${sessionId}/logout`, {
        method: "POST",
        headers: authHeaders(token),
      }),

    /** رابط بث SSE اللحظي (الحالة + كل QR جديد فور صدوره) */
    eventsUrl: (sessionId: string, token?: string | null) =>
      `${API}/api/whatsapp/session/${sessionId}/events?token=${encodeURIComponent(token ?? "")}`,
  },

  /* ── الميزة 2: أسئلة وأجوبة من الرابط ── */
  extractQA: (tenantId: string, url: string) =>
    apiFetch<{ pairs: QAPair[]; title: string }>(`/api/tenants/${tenantId}/qa/extract`, {
      method: "POST",
      body: JSON.stringify({ url }),
    }),

  saveQA: (tenantId: string, pairs: QAPair[], sourceUrl?: string | null) =>
    apiFetch<{ saved: number; sourceId: string }>(`/api/tenants/${tenantId}/qa/save`, {
      method: "POST",
      body: JSON.stringify({ pairs, sourceUrl: sourceUrl ?? null }),
    }),

  /* ── الميزة 3: مختبر الفهم الدلالي ── */
  testQA: (tenantId: string, text: string) =>
    apiFetch<SemanticTestRes>(`/api/tenants/${tenantId}/qa/test`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
};
