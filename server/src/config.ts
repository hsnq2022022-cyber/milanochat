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
 * المصدر الأساسي لبناء عنوان الخادم المستخدم في OAuth/Webhooks.
 *
 * الأولوية:
 * 1. PUBLIC_URL
 *
 * ملاحظة:
 * - META_REDIRECT_URI و INSTAGRAM_REDIRECT_URI يتم التعامل معهما
 *   بشكل مستقل في الدوال الخاصة بكل تدفق OAuth.
 * - لا نستخدم META_REDIRECT_URI لبناء Instagram callback.
 */
export function buildServerBaseUrl(): string {
  const isProd = process.env.NODE_ENV === "production";

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
    throw new Error(
      `[config] PUBLIC_URL ليس رابطاً مطلقاً صالحاً: ${pub}`
    );
  }

  if (u.protocol !== "https:") {
    if (isProd) {
      throw new Error(
        `[config] PUBLIC_URL يجب أن يبدأ بـ https:// في بيئة الإنتاج: ${pub}`
      );
    }

    if (u.protocol !== "http:") {
      throw new Error(
        `[config] بروتوكول PUBLIC_URL غير مدعوم: ${pub}`
      );
    }
  }

  if (u.pathname !== "" && u.pathname !== "/") {
    throw new Error(
      `[config] PUBLIC_URL يجب أن يكون جذر النطاق بدون مسار (${u.pathname} غير مسموح): ${pub}`
    );
  }

  return `${u.protocol}//${u.host}`;
}

/**
 * رابط callback الخاص بـ Facebook OAuth.
 *
 * تدفق Facebook:
 *
 * facebook.com/dialog/oauth
 *        ↓
 * /api/auth/facebook/callback
 *
 * يمكن تثبيت الرابط حرفياً بواسطة:
 *
 * META_REDIRECT_URI
 *
 * وإذا لم يكن موجوداً، يتم بناؤه من PUBLIC_URL.
 */
export function buildMetaCallbackUrl(): string {
  const override = opt("META_REDIRECT_URI")
    .trim()
    .replace(/\/+$/, "");

  if (override && /^https?:\/\//.test(override)) {
    return override;
  }

  return `${buildServerBaseUrl()}/api/auth/facebook/callback`;
}

/**
 * رابط callback المستقل لـ Instagram Login.
 *
 * تدفق Instagram:
 *
 * instagram.com/oauth/authorize
 *        ↓
 * /api/auth/instagram/callback
 *
 * مهم:
 *
 * هذا الرابط مستقل تماماً عن Facebook OAuth.
 *
 * لا يستخدم:
 *
 * META_REDIRECT_URI
 *
 * ويمكن تثبيته صراحة بواسطة:
 *
 * INSTAGRAM_REDIRECT_URI
 *
 * وإذا لم يكن موجوداً، يتم بناؤه تلقائياً من PUBLIC_URL.
 */
export function buildInstagramCallbackUrl(): string {
  const override = opt("INSTAGRAM_REDIRECT_URI")
    .trim()
    .replace(/\/+$/, "");

  if (override && /^https?:\/\//.test(override)) {
    return override;
  }

  return `${buildServerBaseUrl()}/api/auth/instagram/callback`;
}

/**
 * إعدادات Instagram Login.
 *
 * هذه المتغيرات مستقلة عن:
 *
 * META_APP_ID
 * META_APP_SECRET
 *
 * يجب ضبطها في Railway:
 *
 * INSTAGRAM_APP_ID
 * INSTAGRAM_APP_SECRET
 * INSTAGRAM_REDIRECT_URI
 */
export const instagramOAuth = {
  appId: opt("INSTAGRAM_APP_ID"),
  appSecret: opt("INSTAGRAM_APP_SECRET"),
  redirectUri: opt("INSTAGRAM_REDIRECT_URI"),
};

/**
 * هل Instagram Login مهيأ؟
 *
 * لا يتم فحص قيمة الـ secret أو تسجيلها في الـ logs.
 */
export function isInstagramLoginConfigured(): boolean {
  return Boolean(
    instagramOAuth.appId &&
      instagramOAuth.appSecret
  );
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
    model: opt(
      "GEMINI_MODEL",
      "gemini-2.5-flash"
    ),
  },

  embed: {
    apiKey: req("GEMINI_API_KEY"),
    model: opt(
      "GEMINI_EMBED_MODEL",
      "gemini-embedding-001"
    ),
    dim: Number(
      opt("GEMINI_EMBED_DIM", "768")
    ),
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
    graphApiVersion: opt(
      "META_GRAPH_API_VERSION",
      "v19.0"
    ),
  },

  /**
   * Instagram Login — إعدادات مستقلة عن Facebook.
   *
   * يستخدمها backend لبناء Instagram OAuth
   * والتحقق من وجود credentials.
   */
  instagram: {
    appId: instagramOAuth.appId,
    appSecret: instagramOAuth.appSecret,
    redirectUri: instagramOAuth.redirectUri,
  },

  baseCredits: Number(
    opt("BASE_CREDITS", "1000")
  ),

  dataDir: opt(
    "DATA_DIR",
    "./data"
  ),

  ragThreshold: Number(
    opt("SIMILARITY_THRESHOLD", "0.25")
  ),

  ragTopK: Number(
    opt("RAG_TOP_K", "5")
  ),
} as const;

