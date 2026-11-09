/**
 * SSRF-safe URL fetcher for website ingestion (qa_extract, knowledge_add).
 *
 * Pure module: fetch, DNS resolver and clock are injected so it runs under
 * node --test as well as in the Deno edge runtime.
 *
 * Rules (every redirect hop is re-validated with the same rules):
 *  - http/https only, no userinfo (user:pass@), ports 80/443 only
 *  - hostname must not be localhost / *.localhost / *.local / *.internal /
 *    *.localdomain / *.home.arpa / a single label
 *  - IP literals (incl. decimal / octal / hex IPv4 forms) and every DNS answer
 *    (A + AAAA) must be public: private, loopback, link-local (incl.
 *    169.254.169.254 metadata), CGNAT, benchmarking, documentation,
 *    multicast, reserved, ::1, fc00::/7, fe80::/10, v4-mapped / NAT64 / 6to4
 *    / Teredo IPv6 are all refused
 *  - redirects handled manually: max 3 hops
 *  - one overall deadline (AbortController) for DNS + all hops + body
 *  - streaming body cap; content-type allowlist
 *  - after the response, the final host is resolved again and must still be
 *    public (DNS-rebinding mitigation; fetch itself cannot pin the IP).
 *
 * Errors are SafeFetchError with a coarse code; messages never contain the
 * URL, the host or a resolved address.
 */

export type Resolver = (hostname: string) => Promise<string[]>;
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type SafeFetchOptions = {
  fetch: FetchLike;
  resolve: Resolver;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  allowedContentTypes?: readonly string[];
  userAgent?: string;
};

export type SafeFetchResult =
  | { ok: true; status: number; contentType: string; text: string }
  | { ok: false; status: number };

export const SAFE_FETCH_DEFAULTS = {
  timeoutMs: 8_000,
  maxBytes: 1_500_000,
  maxRedirects: 3,
  allowedContentTypes: ["text/html", "text/plain", "application/xhtml+xml"] as const,
};

export type SafeFetchCode =
  | "invalid_url"
  | "scheme"
  | "credentials"
  | "port"
  | "blocked_host"
  | "blocked_address"
  | "dns_failed"
  | "too_many_redirects"
  | "bad_redirect"
  | "timeout"
  | "too_large"
  | "content_type"
  | "network";

const MESSAGES: Record<SafeFetchCode, string> = {
  invalid_url: "الرابط غير صالح",
  scheme: "الرابط يجب أن يبدأ بـ http أو https",
  credentials: "الرابط غير مسموح (يحوي بيانات دخول)",
  port: "الرابط غير مسموح (المنفذ غير مدعوم)",
  blocked_host: "الرابط غير مسموح (عنوان داخلي)",
  blocked_address: "الرابط غير مسموح (عنوان داخلي)",
  dns_failed: "تعذر الوصول إلى الموقع",
  too_many_redirects: "الرابط يحوي تحويلات كثيرة",
  bad_redirect: "تحويل غير صالح من الموقع",
  timeout: "انتهت مهلة فتح الرابط",
  too_large: "الصفحة أكبر من الحد المسموح",
  content_type: "نوع المحتوى غير مدعوم (صفحات HTML أو نص فقط)",
  network: "تعذر فتح الرابط",
};

export class SafeFetchError extends Error {
  readonly code: SafeFetchCode;
  constructor(code: SafeFetchCode) {
    super(`${MESSAGES[code]} [${code}]`);
    this.name = "SafeFetchError";
    this.code = code;
  }
}

/* ───────────────────────────── IPv4 ───────────────────────────── */

/** inet_aton-style parse: dotted 1-4 parts, each decimal / 0octal / 0xhex. */
export function parseIpv4(host: string): number[] | null {
  if (!/^[0-9a-fx.]+$/i.test(host)) return null;
  const h = host.endsWith(".") ? host.slice(0, -1) : host;
  const parts = h.split(".");
  if (parts.length < 1 || parts.length > 4 || parts.some((p) => p === "")) return null;
  const nums: number[] = [];
  for (const p of parts) {
    let n: number;
    if (/^0x[0-9a-f]*$/i.test(p)) n = p.length === 2 ? 0 : parseInt(p.slice(2), 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    else if (/^(0|[1-9][0-9]*)$/.test(p)) n = parseInt(p, 10);
    else return null;
    if (!Number.isFinite(n)) return null;
    nums.push(n);
  }
  const last = nums[nums.length - 1];
  const head = nums.slice(0, -1);
  if (head.some((n) => n > 255)) return null;
  const restBytes = 4 - head.length;
  if (last >= 2 ** (8 * restBytes)) return null;
  const out = [...head];
  for (let i = restBytes - 1; i >= 0; i--) out.push(Math.floor(last / 2 ** (8 * i)) % 256);
  return out;
}

const V4_BLOCKS: Array<[number[], number]> = [
  [[0, 0, 0, 0], 8], // "this" network
  [[10, 0, 0, 0], 8], // private
  [[100, 64, 0, 0], 10], // CGNAT
  [[127, 0, 0, 0], 8], // loopback
  [[169, 254, 0, 0], 16], // link-local + cloud metadata 169.254.169.254
  [[172, 16, 0, 0], 12], // private
  [[192, 0, 0, 0], 24], // IETF protocol assignments
  [[192, 0, 2, 0], 24], // TEST-NET-1
  [[192, 88, 99, 0], 24], // 6to4 relay anycast
  [[192, 168, 0, 0], 16], // private
  [[198, 18, 0, 0], 15], // benchmarking
  [[198, 51, 100, 0], 24], // TEST-NET-2
  [[203, 0, 113, 0], 24], // TEST-NET-3
  [[224, 0, 0, 0], 4], // multicast
  [[240, 0, 0, 0], 4], // reserved + broadcast
];

const v4int = (b: number[]) => ((b[0] << 24) >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3];

export function isPublicIpv4(bytes: number[]): boolean {
  const v = v4int(bytes);
  for (const [net, bits] of V4_BLOCKS) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if (((v & mask) >>> 0) === ((v4int(net) & mask) >>> 0)) return false;
  }
  return true;
}

/* ───────────────────────────── IPv6 ───────────────────────────── */

/** Parses an IPv6 literal (optionally bracketed, no zone) into 8 16-bit groups. */
export function parseIpv6(input: string): number[] | null {
  let s = String(input ?? "");
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (!s.includes(":") || s.includes("%")) return null;
  let tail: number[] = [];
  const lc = s.lastIndexOf(":");
  const last = s.slice(lc + 1);
  if (last.includes(".")) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(last)) return null;
    const b = last.split(".").map(Number);
    if (b.some((x) => x > 255)) return null;
    tail = [(b[0] << 8) | b[1], (b[2] << 8) | b[3]];
    s = s.slice(0, lc + 1);
    if (!s.endsWith("::")) s = s.slice(0, -1);
  }
  const dbl = s.split("::");
  if (dbl.length > 2) return null;
  const parseGroups = (x: string) =>
    x === "" ? [] : x.split(":").map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
  let groups: number[];
  if (dbl.length === 2) {
    const left = parseGroups(dbl[0]);
    const right = parseGroups(dbl[1]);
    const need = 8 - tail.length - left.length - right.length;
    if (need < 1) return null;
    groups = [...left, ...Array(need).fill(0), ...right, ...tail];
  } else {
    groups = [...parseGroups(s), ...tail];
  }
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

export function isPublicIpv6(g: number[]): boolean {
  // Only global unicast 2000::/3 is acceptable at all; this excludes ::,
  // ::1, ::ffff:0:0/96 (v4-mapped), ::/96 (v4-compatible), 64:ff9b::/96
  // (NAT64), 100::/64, fc00::/7, fe80::/10, fec0::/10, ff00::/8, ...
  if ((g[0] & 0xe000) !== 0x2000) return false;
  if (g[0] === 0x2001 && g[1] < 0x0200) return false; // 2001::/23 IETF (Teredo, ORCHID, benchmarking)
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g[0] === 0x2002) return false; // 6to4 (embeds an arbitrary IPv4)
  if ((g[0] & 0xfff0) === 0x3ff0) return false; // 3fff::/20 documentation
  return true;
}

/** True only for a syntactically valid PUBLIC IPv4 or IPv6 address. */
export function isPublicAddress(addr: string): boolean {
  const a = String(addr ?? "").trim();
  const v4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(a) ? parseIpv4(a) : null;
  if (v4) return isPublicIpv4(v4);
  const v6 = parseIpv6(a);
  if (v6) return isPublicIpv6(v6);
  return false; // unparseable answer: fail closed
}

/* ─────────────────────────── URL rules ─────────────────────────── */

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa", ".in-addr.arpa", ".ip6.arpa"];

export type ValidatedTarget = { url: URL; host: string; literal: boolean };

/** Static checks (no DNS). Throws SafeFetchError. */
export function validateUrl(raw: string, base?: URL): ValidatedTarget {
  let url: URL;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    throw new SafeFetchError("invalid_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SafeFetchError("scheme");
  if (url.username !== "" || url.password !== "") throw new SafeFetchError("credentials");
  if (url.port !== "" && url.port !== "80" && url.port !== "443") throw new SafeFetchError("port");
  let host = url.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    const g = parseIpv6(host);
    if (!g || !isPublicIpv6(g)) throw new SafeFetchError("blocked_address");
    return { url, host, literal: true };
  }
  while (host.endsWith(".")) host = host.slice(0, -1);
  if (!host || host.includes("%") || host.includes(":")) throw new SafeFetchError("blocked_host");
  // A host whose last label is numeric is an IPv4 literal (decimal, octal,
  // hex, 1-4 parts); WHATWG URL normalises these already, this is defence
  // in depth for runtimes that do not.
  if (/^[0-9a-fx.]+$/i.test(host) && /^(0x[0-9a-f]*|[0-9]+)$/i.test(host.split(".").pop() ?? "")) {
    const v4 = parseIpv4(host);
    if (!v4) throw new SafeFetchError("invalid_url");
    if (!isPublicIpv4(v4)) throw new SafeFetchError("blocked_address");
    return { url, host: v4.join("."), literal: true };
  }
  if (host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s)) || !host.includes(".")) {
    throw new SafeFetchError("blocked_host");
  }
  return { url, host, literal: false };
}

async function withDeadline<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new SafeFetchError("timeout");
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new SafeFetchError("timeout"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

async function assertResolvesPublic(t: ValidatedTarget, resolve: Resolver, signal: AbortSignal) {
  if (t.literal) return;
  let addrs: string[];
  try {
    addrs = await withDeadline(resolve(t.host), signal);
  } catch (e) {
    if (e instanceof SafeFetchError) throw e;
    throw new SafeFetchError("dns_failed");
  }
  if (!Array.isArray(addrs) || addrs.length === 0) throw new SafeFetchError("dns_failed");
  for (const a of addrs) if (!isPublicAddress(a)) throw new SafeFetchError("blocked_address");
}

function mediaType(ct: string | null): string {
  return String(ct ?? "").split(";")[0].trim().toLowerCase();
}

async function readCapped(res: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await res.body?.cancel(); } catch { /* ignore */ }
    throw new SafeFetchError("too_large");
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await withDeadline(reader.read(), signal);
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new SafeFetchError("too_large");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.byteLength; }
  return new TextDecoder().decode(all);
}

/**
 * Fetches a public web page. Non-2xx final responses return {ok:false,status}
 * without reading the body; every policy violation throws SafeFetchError.
 */
export async function safeFetchText(rawUrl: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const timeoutMs = opts.timeoutMs ?? SAFE_FETCH_DEFAULTS.timeoutMs;
  const maxBytes = opts.maxBytes ?? SAFE_FETCH_DEFAULTS.maxBytes;
  const maxRedirects = opts.maxRedirects ?? SAFE_FETCH_DEFAULTS.maxRedirects;
  const allowed = opts.allowedContentTypes ?? SAFE_FETCH_DEFAULTS.allowedContentTypes;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let target = validateUrl(String(rawUrl ?? "").trim());
    for (let hop = 0; ; hop++) {
      await assertResolvesPublic(target, opts.resolve, ctl.signal);
      let res: Response;
      try {
        res = await withDeadline(
          opts.fetch(target.url.toString(), {
            method: "GET",
            redirect: "manual",
            signal: ctl.signal,
            headers: {
              "user-agent": opts.userAgent ??
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
              accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
            },
          }),
          ctl.signal,
        );
      } catch (e) {
        if (e instanceof SafeFetchError) throw e;
        if (ctl.signal.aborted) throw new SafeFetchError("timeout");
        throw new SafeFetchError("network");
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        try { await res.body?.cancel(); } catch { /* ignore */ }
        if (!loc) throw new SafeFetchError("bad_redirect");
        if (hop + 1 > maxRedirects) throw new SafeFetchError("too_many_redirects");
        target = validateUrl(loc, target.url);
        continue;
      }
      if (res.status < 200 || res.status > 299) {
        try { await res.body?.cancel(); } catch { /* ignore */ }
        return { ok: false, status: res.status };
      }
      const ct = mediaType(res.headers.get("content-type"));
      if (!allowed.includes(ct)) {
        try { await res.body?.cancel(); } catch { /* ignore */ }
        throw new SafeFetchError("content_type");
      }
      const text = await readCapped(res, maxBytes, ctl.signal);
      // Re-validate the final host after the connection (rebinding check).
      await assertResolvesPublic(target, opts.resolve, ctl.signal);
      return { ok: true, status: res.status, contentType: ct, text };
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Deno resolver: all A + AAAA answers ("no records" of one type is fine). */
export function denoResolver(): Resolver {
  return async (hostname: string) => {
    const D = (globalThis as any).Deno;
    if (!D?.resolveDns) throw new SafeFetchError("dns_failed");
    const out: string[] = [];
    for (const t of ["A", "AAAA"]) {
      try {
        out.push(...(await D.resolveDns(hostname, t)));
      } catch {
        /* no records of this type */
      }
    }
    return out;
  };
}
