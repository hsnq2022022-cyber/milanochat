/**
 * Abuse guards for public / pre-billing milan-api actions (S3 / S4).
 *
 * Fixed-window rate limits backed by the service-role-only SQL function
 * public.milan_rate_limit_hit (migration 20261029250000). Edge isolates are
 * stateless, so the DB is the shared counter. If the RPC fails for any
 * reason, a STRICTER per-isolate in-memory limiter is used instead (half the
 * limit, never unlimited, never skipped).
 *
 * Pure module: rpc client, clock, hashing salt and the in-memory store are
 * injected. Logs carry only coarse reason codes (never IPs, keys or text).
 */

export type RpcClient = {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
};

export type LimitRule = { key: string; limit: number; windowSec: number; code: string };

export type HitResult = { allowed: boolean; retryAfter: number; source: "db" | "memory" };

export type MemoryStore = Map<string, { windowStart: number; windowMs: number; hits: number }>;

/** Module-level fallback store (one per edge isolate). */
const isolateStore: MemoryStore = new Map();

export const RATE_LIMIT_RPC = "milan_rate_limit_hit";

/** Stricter fallback limit used when the DB limiter is unavailable. */
export const fallbackLimit = (limit: number) => Math.max(1, Math.floor(limit / 2));

export function memoryHit(store: MemoryStore, rule: LimitRule, nowMs: number): HitResult {
  const win = rule.windowSec * 1000;
  const windowStart = Math.floor(nowMs / win) * win;
  const k = `${rule.key}|${rule.windowSec}`;
  if (store.size > 5000) {
    for (const [key, v] of store) if (v.windowStart + v.windowMs <= nowMs) store.delete(key);
  }
  const cur = store.get(k);
  const hits = cur && cur.windowStart === windowStart ? cur.hits + 1 : 1;
  store.set(k, { windowStart, windowMs: win, hits });
  const retryAfter = Math.max(1, Math.ceil((windowStart + win - nowMs) / 1000));
  return { allowed: hits <= fallbackLimit(rule.limit), retryAfter, source: "memory" };
}

export type Limiter = { hit(rule: LimitRule): Promise<HitResult> };

export function createLimiter(deps: {
  rpc: RpcClient;
  now?: () => number;
  store?: MemoryStore;
  log?: (msg: string, meta: Record<string, string>) => void;
}): Limiter {
  const now = deps.now ?? Date.now;
  const store = deps.store ?? isolateStore;
  const log = deps.log ?? ((m, meta) => console.warn(m, meta));
  return {
    async hit(rule) {
      try {
        const { data, error } = await deps.rpc.rpc(RATE_LIMIT_RPC, {
          p_key: rule.key,
          p_limit: rule.limit,
          p_window_seconds: rule.windowSec,
        });
        const d = data as { allowed?: unknown; retry_after?: unknown } | null;
        if (error || !d || typeof d.allowed !== "boolean") throw new Error("limiter_rpc");
        const ra = Number(d.retry_after);
        return { allowed: d.allowed, retryAfter: Number.isFinite(ra) && ra > 0 ? Math.ceil(ra) : 1, source: "db" };
      } catch {
        log("[rate_limit] db limiter unavailable; strict in-memory fallback", { code: "limiter_fallback" });
        return memoryHit(store, rule, now());
      }
    },
  };
}

/** Runs rules in order; stops at the first blocked one. */
export async function checkRules(limiter: Limiter, rules: LimitRule[]): Promise<(HitResult & { code: string }) | null> {
  for (const r of rules) {
    const h = await limiter.hit(r);
    if (!h.allowed) return { ...h, code: r.code };
  }
  return null;
}

/* ───────────────────────── client identity ───────────────────────── */

/** Client IP from the platform headers: x-forwarded-for first hop, then cf-connecting-ip. */
export function clientIp(headers: Headers): string {
  const xff = (headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  const cand = xff || (headers.get("cf-connecting-ip") ?? "").trim() || (headers.get("x-real-ip") ?? "").trim();
  return /^[0-9a-fA-F:.]{2,64}$/.test(cand) ? cand.toLowerCase() : "unknown";
}

/** SHA-256(salt, ip) truncated; the raw IP is never stored or logged. */
export async function hashIp(ip: string, salt: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`milan-rl:v1:${salt}:${ip}`));
  return [...new Uint8Array(buf)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ───────────────────────────── policies ───────────────────────────── */

export const WIDGET_LIMITS = {
  ipPerMinute: 10,
  sessionPerHour: 30,
  tenantPerMinute: 120,
};

export const AI_ACTION_LIMITS = {
  ipPerMinute: 10,
  ipPerHour: 60,
  tenantPerHour: 30,
  knowledgeAddTenantPerHour: 60,
};

/** Claim-token actions that fetch URLs or call LLM / embeddings. */
export const CLAIM_AI_ACTIONS: ReadonlySet<string> = new Set(["qa_extract", "qa_save", "ingest_text", "qa_test"]);

export const widgetIpRules = (ipHash: string): LimitRule[] => [
  { key: `w:ip:${ipHash}`, limit: WIDGET_LIMITS.ipPerMinute, windowSec: 60, code: "widget_ip" },
];

export const widgetScopeRules = (tenantId: string, sessionId: string): LimitRule[] => [
  { key: `w:s:${sessionId}`, limit: WIDGET_LIMITS.sessionPerHour, windowSec: 3600, code: "widget_session" },
  { key: `w:t:${tenantId}`, limit: WIDGET_LIMITS.tenantPerMinute, windowSec: 60, code: "widget_tenant" },
];

export const aiActionRules = (ipHash: string, tenantId: string): LimitRule[] => [
  { key: `ai:ip:${ipHash}`, limit: AI_ACTION_LIMITS.ipPerMinute, windowSec: 60, code: "ai_ip" },
  { key: `ai:iph:${ipHash}`, limit: AI_ACTION_LIMITS.ipPerHour, windowSec: 3600, code: "ai_ip_hour" },
  { key: `ai:t:${tenantId}`, limit: AI_ACTION_LIMITS.tenantPerHour, windowSec: 3600, code: "ai_tenant" },
];

/** Read-only claim action "comment_activity" (Inbox comment log). */
export const COMMENT_ACTIVITY_LIMITS = { ipPerMinute: 60, tenantPerMinute: 120 };
export const commentActivityRules = (ipHash: string, tenantId: string): LimitRule[] => [
  { key: `ca:ip:${ipHash}`, limit: COMMENT_ACTIVITY_LIMITS.ipPerMinute, windowSec: 60, code: "comment_activity_ip" },
  { key: `ca:t:${tenantId}`, limit: COMMENT_ACTIVITY_LIMITS.tenantPerMinute, windowSec: 60, code: "comment_activity_tenant" },
];

export const knowledgeAddRules = (tenantId: string): LimitRule[] => [
  { key: `kb:t:${tenantId}`, limit: AI_ACTION_LIMITS.knowledgeAddTenantPerHour, windowSec: 3600, code: "kb_tenant" },
];

export function tooManyRequests(retryAfter: number, headers: Record<string, string>): Response {
  return new Response(
    JSON.stringify({
      error: "طلبات كثيرة جدًا، حاول بعد قليل / Too many requests, please retry later",
      code: "RATE_LIMITED",
      retryAfter,
    }),
    {
      status: 429,
      headers: { ...headers, "content-type": "application/json; charset=utf-8", "Retry-After": String(retryAfter) },
    },
  );
}

/**
 * One call for index.ts: hashes the client IP, applies the rules, logs a
 * coarse code and returns a 429 Response, or null when allowed.
 */
export async function rateGate(opts: {
  rpc: RpcClient;
  headers: Headers;
  salt: string;
  cors: Record<string, string>;
  rules: (ipHash: string) => LimitRule[];
  now?: () => number;
  store?: MemoryStore;
}): Promise<Response | null> {
  const ipHash = await hashIp(clientIp(opts.headers), opts.salt);
  const limiter = createLimiter({ rpc: opts.rpc, now: opts.now, store: opts.store });
  const blocked = await checkRules(limiter, opts.rules(ipHash));
  if (!blocked) return null;
  console.warn("[rate_limit] blocked", { code: blocked.code, source: blocked.source });
  return tooManyRequests(blocked.retryAfter, opts.cors);
}
