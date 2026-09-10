import { createClient } from "@supabase/supabase-js";
import { config } from "./config.js";

/**
 * إعدادات Supabase.
 *
 * Node.js 22 يوفر WebSocket أصليًا، لذلك لا نحتاج
 * إلى مكتبة ws لتشغيل Supabase Realtime.
 */
const supabaseOptions = {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
};

/**
 * عميل خدمة Supabase.
 *
 * يستخدم Service Role Key، لذلك يتجاوز RLS.
 * يجب أن يتم فرض tenant_id في طبقة التطبيق.
 */
export const db = createClient(
  config.supabaseUrl,
  config.supabaseServiceKey,
  supabaseOptions
);

/**
 * عميل Supabase للتحقق من توكنات Auth
 * في مسارات لوحة التحكم.
 */
export const authClient = createClient(
  config.supabaseUrl,
  config.supabaseServiceKey,
  supabaseOptions
);

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
