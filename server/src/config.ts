```ts
import "dotenv/config";

const req = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;

  if (v === undefined || v === "") {
    throw new Error(`[config] المتغير البيئي المطلوب غير موجود: ${name}`);
  }

  return v;
};

const opt = (name: string, fallback = ""): string => {
  return process.env[name] ?? fallback;
};

/**
 * الأصول المسموحة (CORS)
 */
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

  /**
   * مفتاح AES-256 لتشفير الحقول الحساسة عند الراحة.
   */
  fieldEncryptionKey: req("FIELD_ENCRYPTION_KEY"),

  /**
   * إعدادات Gemini.
   *
   * يمكن وضع GEMINI_API_KEY مباشرة في Railway.
   * LLM_API_KEY يبقى كـ fallback للتوافق مع الإعداد القديم.
   */
  llm: {
    provider: "gemini" as const,

    apiKey: opt(
      "GEMINI_API_KEY",
      opt("LLM_API_KEY")
    ),

    model: opt(
      "GEMINI_MODEL",
      opt("LLM_MODEL", "gemini-2.5-flash")
    ),
  },

  /**
   * إعدادات Gemini Embeddings.
   *
   * gemini-embedding-001 يدعم outputDimensionality.
   * نستخدم 768 لتقليل حجم المتجهات والتخزين.
   *
   * إذا كانت لديك بيانات قديمة بأبعاد مختلفة فلا تخلط
   * المتجهات القديمة مع الجديدة.
   */
  embed: {
    apiKey: opt(
      "GEMINI_API_KEY",
      opt("EMBED_API_KEY", opt("LLM_API_KEY"))
    ),

    model: opt(
      "GEMINI_EMBED_MODEL",
      opt("EMBED_MODEL", "gemini-embedding-001")
    ),

    dim: Number(
      opt("GEMINI_EMBED_DIM", opt("EMBED_DIM", "768"))
    ),
  },

  moyasar: {
    secretKey: opt("MOYASAR_SECRET_KEY"),
    publishableKey: opt("MOYASAR_PUBLISHABLE_KEY"),
    webhookSecret: opt("MOYASAR_WEBHOOK_SECRET"),
  },

  baseCredits: Number(opt("BASE_CREDITS", "1000")),
  dataDir: opt("DATA_DIR", "./data"),

  /**
   * عتبة التشابه الدلالي.
   */
  ragThreshold: Number(
    opt("SIMILARITY_THRESHOLD", "0.25")
  ),

  /**
   * عدد النتائج التي تمرر إلى الموديل.
   */
  ragTopK: Number(
    opt("RAG_TOP_K", "5")
  ),
} as const;
```
