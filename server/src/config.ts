import "dotenv/config";

const req = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") {
    throw new Error(`[config] المتغير البيئي المطلوب غير موجود: ${name}`);
  }
  return v;
};

const opt = (name: string, fallback = ""): string => process.env[name] ?? fallback;

export const config = {
  port: Number(opt("PORT", "4000")),
  frontendOrigin: opt("FRONTEND_ORIGIN", "http://localhost:5173"),
  publicUrl: opt("PUBLIC_URL", "http://localhost:4000"),

  supabaseUrl: req("SUPABASE_URL"),
  supabaseServiceKey: req("SUPABASE_SERVICE_ROLE_KEY"),

  /** مفتاح AES-256 لتشفير الحقول الحساسة عند الراحة */
  fieldEncryptionKey: req("FIELD_ENCRYPTION_KEY"),

  llm: {
    provider: opt("LLM_PROVIDER", "openai") as "openai" | "anthropic",
    apiKey: opt("LLM_API_KEY"),
    baseUrl: opt("LLM_BASE_URL", "https://api.openai.com/v1"),
    model: opt("LLM_MODEL", "gpt-4o-mini"),
  },

  embed: {
    apiKey: opt("EMBED_API_KEY"),
    baseUrl: opt("EMBED_BASE_URL", "https://api.openai.com/v1"),
    model: opt("EMBED_MODEL", "text-embedding-3-small"),
    dim: Number(opt("EMBED_DIM", "1536")),
  },

  moyasar: {
    secretKey: opt("MOYASAR_SECRET_KEY"),
    publishableKey: opt("MOYASAR_PUBLISHABLE_KEY"),
    webhookSecret: opt("MOYASAR_WEBHOOK_SECRET"),
  },

  baseCredits: Number(opt("BASE_CREDITS", "1000")),
  dataDir: opt("DATA_DIR", "./data"),

  /** الميزة 3: عتبة التشابه الدلالي — ما دونها يُسجَّل السؤال عالقًا بدل إجبار رد ضعيف */
  ragThreshold: Number(opt("SIMILARITY_THRESHOLD", "0.25")),
  /** عدد أقرب النتائج الممررة كسياق للموديل */
  ragTopK: Number(opt("RAG_TOP_K", "5")),
} as const;
