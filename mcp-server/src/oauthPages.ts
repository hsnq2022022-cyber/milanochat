import { randomBytes, timingSafeEqual } from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import session from "express-session";
import { UUID_RE } from "./config.js";
import { MCP_SCOPE, PENDING_TTL_MS, randomToken, type OAuthProviderBundle, type PendingAuthorization } from "./oauthProvider.js";
import type { AuthOutcome } from "./auth.js";

/**
 * Login (Supabase Auth password grant, server side) + consent screens for /authorize.
 * Session: only { userId (verified Supabase sub), csrf, pending authorization requests }.
 * The password is forwarded once to Supabase over TLS and never stored or logged.
 */
export type PasswordLoginResult = { ok: true; userId: string } | { ok: false; reason: "invalid" | "unavailable" };
export type PasswordLogin = (email: string, password: string) => Promise<PasswordLoginResult>;

export function supabasePasswordLogin(supabaseUrl: string, anonKey: string, fetchImpl: typeof fetch = fetch): PasswordLogin {
  return async (email, password) => {
    let res: globalThis.Response;
    try {
      res = await fetchImpl(supabaseUrl + "/auth/v1/token?grant_type=password", {
        method: "POST",
        headers: { apikey: anonKey, Authorization: "Bearer " + anonKey, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
    } catch { return { ok: false, reason: "unavailable" }; }
    if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 422) {
      await res.body?.cancel();
      return { ok: false, reason: "invalid" };
    }
    if (!res.ok) { await res.body?.cancel(); return { ok: false, reason: "unavailable" }; }
    let body: unknown;
    try { body = await res.json(); } catch { return { ok: false, reason: "unavailable" }; }
    // Only the user id is kept; the Supabase access/refresh tokens are discarded.
    const id = (body as { user?: { id?: unknown } } | null)?.user?.id;
    return typeof id === "string" && UUID_RE.test(id) ? { ok: true, userId: id.toLowerCase() } : { ok: false, reason: "unavailable" };
  };
}

/** Bounded in-process session store (express-session's MemoryStore never prunes and warns in production). */
export class BoundedMemorySessionStore extends session.Store {
  private m = new Map<string, { data: string; exp: number }>();
  constructor(private max = 5000, private defaultTtlMs = 15 * 60 * 1000) { super(); }
  private prune() { const t = Date.now(); for (const [k, v] of this.m) if (v.exp <= t) this.m.delete(k); }
  override get(sid: string, cb: (err: unknown, s?: session.SessionData | null) => void) {
    const e = this.m.get(sid);
    if (!e || e.exp <= Date.now()) { this.m.delete(sid); cb(null, null); return; }
    cb(null, JSON.parse(e.data));
  }
  override set(sid: string, s: session.SessionData, cb?: (err?: unknown) => void) {
    if (this.m.size >= this.max) { this.prune(); while (this.m.size >= this.max) this.m.delete(this.m.keys().next().value as string); }
    const exp = s.cookie?.expires ? new Date(s.cookie.expires).getTime() : Date.now() + this.defaultTtlMs;
    this.m.delete(sid);
    this.m.set(sid, { data: JSON.stringify(s), exp });
    cb?.();
  }
  override destroy(sid: string, cb?: (err?: unknown) => void) { this.m.delete(sid); cb?.(); }
  override touch(sid: string, s: session.SessionData, cb?: () => void) {
    const e = this.m.get(sid);
    if (e && s.cookie?.expires) e.exp = new Date(s.cookie.expires).getTime();
    cb?.();
  }
  get size() { return this.m.size; }
}

export const SESSION_COOKIE = "milano_mcp_sid";

export function sessionMiddleware(o: { secret: string; secure: boolean; trustProxy: boolean; store?: session.Store }) {
  return session({
    name: SESSION_COOKIE, secret: o.secret, store: o.store ?? new BoundedMemorySessionStore(),
    resave: false, saveUninitialized: false, rolling: false, unset: "destroy", proxy: o.trustProxy,
    cookie: { httpOnly: true, sameSite: "lax", secure: o.secure, maxAge: 15 * 60 * 1000, path: "/" },
  });
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };
export const escapeHtml = (s: string) => s.replace(/[&<>"'`]/g, c => ESC[c]!);

const CSS = `*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#061A14;color:#fff;font:16px/1.6 system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif;padding:16px}
.card{background:#0B241C;border:1px solid rgba(61,209,137,.25);border-radius:16px;max-width:440px;width:100%;padding:28px}
h1{font-size:20px;margin:0 0 12px;color:#3DD189}p{margin:8px 0;color:#8B9E96}.muted{color:#8B9E96;font-size:14px}
.name{color:#fff;font-weight:700;word-break:break-word}.host{display:block;direction:ltr;text-align:center;font-family:ui-monospace,monospace;font-size:18px;font-weight:700;color:#E5B54B;background:#061A14;border:1px solid #E5B54B;border-radius:10px;padding:10px;margin:8px 0;word-break:break-all}
.scope{border:1px solid rgba(139,158,150,.35);border-radius:10px;padding:10px 12px;margin:12px 0}.scope code{direction:ltr;color:#3DD189}
.warn{color:#E5B54B;font-size:14px}label{display:block;margin:12px 0 4px;color:#8B9E96}
input{width:100%;padding:10px 12px;border-radius:10px;border:1px solid rgba(139,158,150,.4);background:#061A14;color:#fff;font-size:16px}
.row{display:flex;gap:12px;margin-top:20px}button{flex:1;padding:12px;border-radius:10px;border:0;font-size:16px;font-weight:700;cursor:pointer}
.ok{background:#3DD189;color:#061A14}.no{background:transparent;color:#fff;border:1px solid #8B9E96}.err{color:#ff8a80}`;

type Page = { title: string; body: string; formAction?: string[] };
function sendPage(res: Response, status: number, p: Page) {
  const nonce = randomBytes(16).toString("base64");
  const formAction = ["'self'", ...(p.formAction ?? [])].join(" ");
  res.status(status)
    .set("Content-Type", "text/html; charset=utf-8")
    .set("Cache-Control", "no-store")
    .set("Pragma", "no-cache")
    .set("X-Frame-Options", "DENY")
    .set("Referrer-Policy", "same-origin")
    .set("Content-Security-Policy",
      `default-src 'none'; style-src 'nonce-${nonce}'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`)
    .send(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<meta name="robots" content="noindex"><title>${escapeHtml(p.title)}</title><style nonce="${nonce}">${CSS}</style></head>` +
      `<body><main class="card">${p.body}</main></body></html>`);
}
const errorPage = (res: Response, status: number, msg: string) =>
  sendPage(res, status, { title: "خطأ", body: `<h1>تعذّر إكمال الطلب</h1><p class="err">${escapeHtml(msg)}</p><p class="muted">ارجع إلى التطبيق وابدأ الاتصال من جديد.</p>` });

const hidden = (n: string, v: string) => `<input type="hidden" name="${n}" value="${escapeHtml(v)}">`;

export type ConsentDeps = {
  bundle: OAuthProviderBundle;
  publicOrigin: string;
  issuer: string;
  passwordLogin: PasswordLogin;
  resolveUserTenant: (sub: string) => Promise<AuthOutcome>;
  loginLimiter: express.RequestHandler;
  consentLimiter: express.RequestHandler;
  log: (m: string) => void;
};

export function consentRouter(d: ConsentDeps): Router {
  const r = express.Router();
  const form = express.urlencoded({ extended: false, limit: "8kb", parameterLimit: 10 });

  const pendingFor = (req: Request, id: unknown): PendingAuthorization | null => {
    if (typeof id !== "string" || id.length > 100) return null;
    const p = req.session.pending?.[id];
    if (!p || p.createdAt + PENDING_TTL_MS < d.bundle.now()) return null;
    return p;
  };
  const csrfOk = (req: Request) => {
    const sent = req.body?.csrf, have = req.session.csrf;
    if (typeof sent !== "string" || typeof have !== "string") return false;
    const a = Buffer.from(sent), b = Buffer.from(have);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const originOk = (req: Request) => {
    const o = req.get("origin");
    return o === undefined || o === "null" || o === d.publicOrigin;
  };
  const redirectBack = (res: Response, p: PendingAuthorization, params: Record<string, string>) => {
    const u = new URL(p.redirectUri);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    if (p.state !== null) u.searchParams.set("state", p.state);
    u.searchParams.set("iss", d.issuer); // RFC 9207
    res.set("Cache-Control", "no-store").redirect(303, u.href);
  };

  function loginPage(res: Response, req: Request, id: string, status = 200, error?: string) {
    sendPage(res, status, {
      title: "تسجيل الدخول",
      body: `<h1>تسجيل الدخول إلى ميلانو</h1><p>سجّل الدخول بحساب ميلانو للمتابعة إلى شاشة الموافقة.</p>` +
        (error ? `<p class="err" role="alert">${escapeHtml(error)}</p>` : "") +
        `<form method="post" action="/consent/login" autocomplete="on">${hidden("csrf", req.session.csrf ?? "")}${hidden("req", id)}` +
        `<label for="email">البريد الإلكتروني</label><input id="email" name="email" type="email" dir="ltr" required maxlength="254" autocomplete="username">` +
        `<label for="password">كلمة المرور</label><input id="password" name="password" type="password" dir="ltr" required maxlength="1024" autocomplete="current-password">` +
        `<div class="row"><button class="ok" type="submit">تسجيل الدخول</button></div></form>`,
    });
  }

  r.get("/consent", d.consentLimiter, async (req, res, next) => {
    try {
      const id = req.query.req;
      const p = pendingFor(req, id);
      if (!p) { errorPage(res, 400, "طلب التفويض غير صالح أو انتهت صلاحيته."); return; }
      if (!req.session.userId) { loginPage(res, req, id as string); return; }
      const client = await d.bundle.getClient(p.clientId);
      if (!client) { errorPage(res, 400, "التطبيق غير معروف."); return; }
      const name = client.clientName ?? "تطبيق بدون اسم";
      const target = new URL(p.redirectUri);
      sendPage(res, 200, {
        title: "طلب إذن",
        formAction: [target.origin],
        body: `<h1>طلب إذن بالوصول</h1>` +
          `<p>التطبيق <span class="name">«${escapeHtml(name)}»</span> يطلب الوصول إلى حسابك في ميلانو.</p>` +
          `<p class="muted">بعد الموافقة سيتم إرسالك إلى:</p><span class="host">${escapeHtml(target.host)}</span>` +
          `<p class="warn">تأكد أنك بدأت هذا الاتصال بنفسك وأنك تعرف هذا العنوان. إن لم تتعرف عليه فاضغط «رفض».</p>` +
          `<div class="scope"><strong>الصلاحية المطلوبة:</strong> <code>${escapeHtml(MCP_SCOPE)}</code><br>إنشاء وتعديل تدفقات الأتمتة</div>` +
          `<form method="post" action="/consent">${hidden("csrf", req.session.csrf ?? "")}${hidden("req", id as string)}` +
          `<div class="row"><button class="ok" type="submit" name="action" value="allow">سماح</button>` +
          `<button class="no" type="submit" name="action" value="deny">رفض</button></div></form>`,
      });
    } catch (e) { next(e); }
  });

  r.post("/consent/login", d.loginLimiter, form, async (req, res, next) => {
    try {
      if (!originOk(req) || !csrfOk(req)) { errorPage(res, 403, "رمز الحماية غير صالح. أعد المحاولة من التطبيق."); return; }
      const id = req.body.req;
      const p = pendingFor(req, id);
      if (!p) { errorPage(res, 400, "طلب التفويض غير صالح أو انتهت صلاحيته."); return; }
      const email = req.body.email, password = req.body.password;
      if (typeof email !== "string" || typeof password !== "string" || email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email.trim())
        || password.length < 1 || password.length > 1024) {
        loginPage(res, req, id, 400, "أدخل بريدًا إلكترونيًا وكلمة مرور صحيحين.");
        return;
      }
      const out = await d.passwordLogin(email.trim(), password);
      if (!out.ok) {
        if (out.reason === "invalid") loginPage(res, req, id, 401, "البريد الإلكتروني أو كلمة المرور غير صحيحة.");
        else errorPage(res, 503, "خدمة تسجيل الدخول غير متاحة حاليًا، حاول لاحقًا.");
        return;
      }
      const pending = req.session.pending;
      // New session id on login (session fixation); only the verified user id is kept.
      req.session.regenerate(err => {
        if (err) { next(err); return; }
        req.session.pending = pending;
        req.session.userId = out.userId;
        req.session.csrf = randomToken();
        req.session.save(e2 => {
          if (e2) { next(e2); return; }
          res.redirect(303, "/consent?req=" + encodeURIComponent(id));
        });
      });
    } catch (e) { next(e); }
  });

  r.post("/consent", d.consentLimiter, form, async (req, res, next) => {
    try {
      if (!originOk(req) || !csrfOk(req)) { errorPage(res, 403, "رمز الحماية غير صالح. أعد المحاولة من التطبيق."); return; }
      const id = req.body.req;
      const p = pendingFor(req, id);
      if (!p) { errorPage(res, 400, "طلب التفويض غير صالح أو انتهت صلاحيته."); return; }
      const userId = req.session.userId;
      if (!userId) { loginPage(res, req, id, 401, "سجّل الدخول أولًا."); return; }
      const action = req.body.action;
      if (action !== "allow" && action !== "deny") { errorPage(res, 400, "إجراء غير معروف."); return; }
      const pending = { ...req.session.pending };
      delete pending[id]; // single use, whatever the answer
      req.session.pending = pending;
      if (action === "deny") { redirectBack(res, p, { error: "access_denied" }); return; }
      const t = await d.resolveUserTenant(userId);
      if (!t.ok) {
        if (t.status === 503) errorPage(res, 503, "تعذّر التحقق من مساحة العمل، حاول لاحقًا.");
        else errorPage(res, 403, "لا توجد مساحة عمل مرتبطة بهذا الحساب.");
        return;
      }
      const client = await d.bundle.getClient(p.clientId);
      if (!client || !client.redirectUris.includes(p.redirectUri)) { errorPage(res, 400, "التطبيق غير معروف."); return; }
      const code = await d.bundle.createAuthorizationCode(p, userId);
      redirectBack(res, p, { code });
    } catch (e) { next(e); }
  });

  return r;
}
