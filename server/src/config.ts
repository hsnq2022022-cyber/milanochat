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

  baseCredits: Number(opt("BASE_CREDITS", "1000")),
  dataDir: opt("DATA_DIR", "./data"),

  ragThreshold: Number(
    opt("SIMILARITY_THRESHOLD", "0.25")
  ),

  ragTopK: Number(
    opt("RAG_TOP_K", "5")
  ),
} as const;
