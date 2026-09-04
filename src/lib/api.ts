/**
 * عميل API للواجهة:
 * - إذا ضُبط VITE_API_URL تعمل الواجهة ضد الخادم الحقيقي (QR فعلي، فهرسة حقيقية).
 * - إذا تُرك فارغًا تبقى الواجهة بوضع العرض التجريبي الحالي بدون أي تغيير.
 */
const RAW = ((import.meta as any).env?.VITE_API_URL as string | undefined) ?? "";
const API = RAW.replace(/\/+$/, "");

export const apiEnabled = API.length > 0;

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
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

  connectWa: (tenantId: string) =>
    apiFetch<{ status: string }>(`/api/tenants/${tenantId}/wa/connect`, { method: "POST" }),

  getQr: (tenantId: string) => apiFetch<QrRes>(`/api/tenants/${tenantId}/wa/qr`),

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
