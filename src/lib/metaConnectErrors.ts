/**
 * Customer-facing (Arabic) messages for a failed Meta channel connection. The Edge function `meta-auth` redirects
 * back with `channel_error=<code>`; every code it can emit must map to a clear message (never a raw English code).
 * Messages that already existed in the dashboard are kept verbatim. Unknown codes get a generic message plus a short,
 * sanitised support code (letters/digits/_/: only, max 48 chars), never arbitrary text from the URL.
 */
const MESSAGES: Record<string, string> = {
  user_cancelled: "تم إلغاء الربط — لم تُمنح صلاحيات Meta.",
  oauth_denied: "رفضت Meta طلب الربط — أعد المحاولة ووافق على الصلاحيات المطلوبة.",
  missing_params: "لم تكتمل بيانات العودة من Meta — أعد المحاولة.",
  oauth_state: "انتهت صلاحية جلسة الربط — ابدأ الربط من جديد.",
  "oauth_state:state_signature": "تعذر التحقق من جلسة الربط — أعد المحاولة.",
  "oauth_state:state_expired": "انتهت صلاحية جلسة الربط.",
  "oauth_state:state_reused": "تم استخدام جلسة الربط مسبقًا.",
  oauth_token_exchange: "رفضت Meta تبادل الرمز — تحقق من Valid OAuth Redirect URI.",
  config_redirect_uri: "إعداد PUBLIC_URL على الخادم غير صحيح.",
  config_missing: "ربط Meta غير مُهيّأ حاليًا على الخادم — تواصل مع الدعم.",
  account_already_linked: "هذا الحساب مرتبط مسبقًا بحساب آخر في المنصة. افصله من الحساب الآخر أولًا أو تواصل مع الدعم.",
  db_save_failed: "تعذر حفظ الربط — أعد المحاولة بعد قليل، وإن تكرر الأمر تواصل مع الدعم.",
  graph_error: "تعذر الاتصال بـ Meta الآن — أعد المحاولة بعد قليل.",
  no_pages: "لم نجد أي صفحة Facebook تديرها بهذا الحساب. تأكد أنك مدير للصفحة ومنحتها الصلاحيات.",
  no_eligible_instagram: "حساب Instagram يجب أن يكون من نوع Business أو Creator ومرتبطًا بصفحة Facebook.",
  unknown: "حدث خطأ غير متوقع أثناء الربط — أعد المحاولة.",
};
/** Legacy `?error=` codes (older redirect format). */
const LEGACY: Record<string, string> = {
  oauth_missing: "لم يكتمل تفويض Meta.",
  oauth_state: "انتهت صلاحية جلسة الربط.",
  oauth_channel: "قناة غير معروفة.",
  oauth_not_configured: "تطبيق Meta غير مُهيّأ.",
  oauth_token: "رفضت Meta تبادل الرمز.",
  oauth_failed: "حدث خطأ أثناء الربط.",
};
const GENERIC = "تعذر إتمام ربط Meta — أعد المحاولة، وإن تكرر الأمر تواصل مع الدعم.";

const supportCode = (code: string): string => {
  const c = code.replace(/[^A-Za-z0-9_:]/g, "").slice(0, 48);
  return c ? ` (رمز: ${c})` : "";
};

export function metaConnectErrorMessage(rawCode: string): string {
  const code = String(rawCode ?? "").trim();
  if (MESSAGES[code]) return MESSAGES[code];
  // meta-auth once appended an Arabic hint after the code ("no_eligible_instagram — ...").
  const head = code.split(/\s|—/)[0];
  if (head && MESSAGES[head]) return MESSAGES[head];
  return GENERIC + supportCode(head || code);
}

export function metaLegacyErrorMessage(rawCode: string): string {
  return LEGACY[String(rawCode ?? "")] ?? "تعذر إتمام ربط Meta.";
}
