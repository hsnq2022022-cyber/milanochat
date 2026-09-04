import { createClient } from "@supabase/supabase-js";
import { config } from "./config.js";

/**
 * عميل خدمة (service role) — يتجاوز RLS لأن العزل متعدد المستأجرين
 * يُفرض في طبقة التطبيق: كل استعلام يحمل tenant_id صراحةً.
 */
export const db = createClient(config.supabaseUrl, config.supabaseServiceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** للتحقق من توكنات Supabase Auth في مسارات لوحة التحكم */
export const authClient = createClient(config.supabaseUrl, config.supabaseServiceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export type Tenant = {
  id: string;
  user_id: string | null;
  claim_token: string;
  business_name: string;
  source_type: "gmaps" | "website" | "manual";
  source_url: string | null;
  phone_encrypted: string | null;
  credits_remaining: number;
  is_active: boolean;
  activated_at: string | null;
  created_at: string;
};

export type Conversation = {
  id: string;
  tenant_id: string;
  wa_chat_id: string;
  customer_phone_encrypted: string;
  transferred: boolean;
  auto_paused_reason: string | null;
  last_message_at: string;
  created_at: string;
};
