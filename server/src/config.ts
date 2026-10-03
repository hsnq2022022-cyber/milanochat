import "dotenv/config";

const req = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;

  if (v === undefined || v === "") {
    throw new Error(`[config] Required environment variable is missing: ${name}`);
  }

  return v;
};

const opt = (name: string, fallback = ""): string => {
  return process.env[name] ?? fallback;
};

const extraOrigins = opt("CORS_ORIGINS")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const corsOrigins: string[] = [
  opt("FRONTEND_ORIGIN", "http://localhost:5173"),
  "https://hsnq2022022-cyber.github.io",
  "http://localhost:5173",
  "http://localhost:3000",
  ...extraOrigins,
].filter(Boolean);

export const corsOriginPatterns: RegExp[] = [
  /\.preview\.qwenlm\.io$/,
  /\.qwenlm\.io$/,
];

/**
 * المصدر الوحيد الموثوق لبناء روابط OAuth (callback/webhook) على الخادم.
 * - META_REDIRECT_URI اختياري لتثبيت القيمة حرفياً كما هي مسجلة في Meta؛
 *   إن وُجد يجب أن يكون https ولا يحمل مساراً أو شرطة مائلة نهائية زائدة،
 *   وإلا يُتجاهل مع تسجيل تحذير (مصدر واحد فقط هو المعتمد).
 * - PUBLIC_URL إلزامي في الإنتاج ويجب أن يكون https بلا مسار.
 * - لا يسجل أي أسرار — العنوان نفسه ليس سراً.
 */
export function buildServerBaseUrl(): string {
  const isProd = process.env.NODE_ENV === "production";
  const override = opt("META_REDIRECT_URI").trim().replace(/\/+$/, "");

  if (override) {
    try {
      const u = new URL(override);
      const pathOk = u.pathname === "" || u.pathname === "/";
      const schemeOk = u.protocol === "https:" || (!isProd && u.protocol === "http:");
      if (schemeOk && pathOk && u.hostname) return `${u.protocol}//${u.host}`;
      console.warn(
        "[config] META_REDIRECT_URI غير صالح (يجب أن يكون جذر https بلا مسار) — سيتم الاعتماد على PUBLIC_URL:",
        override
      );
    } catch {
      console.warn("[config] META_REDIRECT_URI ليس رابطاً مطلقاً صالحاً — سيتم الاعتماد على PUBLIC_URL");
    }
  }

  const pub = opt("PUBLIC_URL").trim();
  if (!pub) {
    throw new Error(
      "[config] PUBLIC_URL مفقود — اضبطه على Railway كرابط الجذر الكامل مثل: https://milanochat-production.up.railway.app"
    );
  }
  let u: URL;
  try {
    u = new URL(pub);
  } catch {
    throw new Error(`[config] PUBLIC_URL ليس رابطاً مطلقاً صالحاً: ${pub}`);
  }
  if (u.protocol !== "https:") {
    if (isProd) {
      throw new Error(
        `[config] PUBLIC_URL يجب أن يبدأ بـ https:// في بيئة الإنتاج: ${pub}`
      );
    }
    if (u.protocol !== "http:") {
      throw new Error(`[config] بروتوكول PUBLIC_URL غير مدعوم: ${pub}`);
    }
  }
  if (u.pathname !== "" && u.pathname !== "/") {
    throw new Error(
      `[config] PUBLIC_URL يجب أن يكون جذر النطاق بدون مسار (${u.pathname} غير مسموح): ${pub}`
    );
  }
  return `${u.protocol}//${u.host}`;
}

/** رابط callback الرسمي لـ Meta OAuth (Facebook Login) — ثابت عبر كل مراحل التدفق.
 *  ملاحظة: إن كان META_REDIRECT_URI مضبوطًا فهو مصدر الحقيقة الحرفي الوحيد
 *  (يجب أن يطابق حرفيًا ما هو مسجل في Meta Dashboard)، ولا يُلحق به مسار آخر.
 *  بدونه يُبنى من PUBLIC_URL + المسار الثابت /api/auth/facebook/callback.
 *  استثناء متوافق مع الإنتاج: إذا كانت القيمة المضبوطة تنتهي بـ
 *  /api/auth/instagram/callback (المسار المسجَّل حرفيًا في Facebook Business Login
 *  بلوحة Meta) تُستخدم كما هي أيضًا — لأن نفس المسار يعالجه الخادم للتدفقين. */
export function buildMetaCallbackUrl(): string {
  const override = opt("META_REDIRECT_URI").trim();
  if (override && /^https?:\/\//.test(override)) {
    const normalized = override.replace(/\/+$/, "");
    const isFullCallbackPath =
      normalized.endsWith("/api/auth/facebook/callback") ||
      normalized.endsWith("/api/auth/instagram/callback");
    // قيمة كاملة صالحة (تحتوي المسار بنفسها) — تُستخدم كما هي لضمان التطابق الحرفي مع Meta
    if (isFullCallbackPath) return normalized;
    // غير ذلك يُعامل كنطاق جذر فقط (سلوك buildServerBaseUrl) — وإلا يكسر تدفق Facebook
  }
  return `${buildServerBaseUrl()}/api/auth/facebook/callback`;
}

/**
 * رابط callback المستقل لتدفق Instagram Login المباشر (instagram.com/oauth/authorize).
 * - INSTAGRAM_REDIRECT_URI اختياري لتثبيت القيمة حرفياً كما هي مسجلة في
 *   Meta Developers (Valid OAuth Redirect URIs لمنتج Instagram Login).
 * - بدونه يُبنى من PUBLIC_URL + المسار الثابت /api/auth/instagram/callback.
 * ملاحظة: لا يستخدم META_REDIRECT_URI إطلاقًا — هذا مسار منفصل تمامًا عن Facebook.
 */
export function buildInstagramCallbackUrl(): string {
  const override = opt("INSTAGRAM_REDIRECT_URI").trim();
  if (override && /^https?:\/\//.test(override)) {
    // قيمة كاملة صالحة (تحتوي المسار بنفسها) — تُستخدم كما هي لضمان التطابق الحرفي مع Meta
    return override.replace(/\/+$/, "");
  }
  return `${buildServerBaseUrl()}/api/auth/instagram/callback`;
}

export const config = {
  port: Number(opt("PORT", "4000")),

  frontendOrigin: opt(
    "FRONTEND_ORIGIN",
    "https://hsnq2022022-cyber.github.io"
  ),

  publicUrl: opt(
    "PUBLIC_URL",
    "https://milanochat-production.up.railway.app"
  ),

  supabaseUrl: req("SUPABASE_URL"),
  supabaseServiceKey: req("SUPABASE_SERVICE_ROLE_KEY"),

  fieldEncryptionKey: req("FIELD_ENCRYPTION_KEY"),

  llm: {
    provider: "gemini" as const,
    apiKey: req("GEMINI_API_KEY"),
    model: opt("GEMINI_MODEL", "gemini-2.5-flash"),
  },

  embed: {
    apiKey: req("GEMINI_API_KEY"),
    model: opt("GEMINI_EMBED_MODEL", "gemini-embedding-001"),
    dim: Number(opt("GEMINI_EMBED_DIM", "768")),
  },

  moyasar: {
    secretKey: opt("MOYASAR_SECRET_KEY"),
    publishableKey: opt("MOYASAR_PUBLISHABLE_KEY"),
    webhookSecret: opt("MOYASAR_WEBHOOK_SECRET"),
  },

  meta: {
    accessToken: opt("WHATSAPP_ACCESS_TOKEN"),
    phoneNumberId: opt("WHATSAPP_PHONE_NUMBER_ID"),
    businessAccountId: opt("WHATSAPP_BUSINESS_ACCOUNT_ID"),
    verifyToken: opt("WHATSAPP_VERIFY_TOKEN"),
    graphApiVersion: opt("META_GRAPH_API_VERSION", "v19.0"),
  },
  
  baseCredits: Number(opt("BASE_CREDITS", "1000")),  dataDir: opt("DATA_DIR", "./data"),

  ragThreshold: Number(
    opt("SIMILARITY_THRESHOLD", "0.25")
  ),

  ragTopK: Number(
    opt("RAG_TOP_K", "5")
  ),
} as const;
