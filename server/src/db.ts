```ts
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import { config } from "./config.js";

/**
 * إعدادات Supabase المشتركة
 *
 * Node.js 20 لا يوفر WebSocket بشكل أصلي بالطريقة
 * التي يحتاجها Supabase Realtime، لذلك نستخدم مكتبة ws.
 */
const supabaseOptions = {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
  realtime: {
    transport: ws,
  },
};

/**
 * عميل خدمة (service role)
 *
 * يستخدم مفتاح Supabase Service Role ويتجاوز RLS.
 * العزل متعدد المستأجرين يتم فرضه في طبقة التطبيق
 * من خلال tenant_id في الاستعلامات.
 */
export const db = createClient(
  config.supabaseUrl,
  config.supabaseServiceKey,
  supabaseOptions
);

/**
 * عميل Supabase للتحقق من توكنات Supabase Auth
 * في مسارات لوحة التحكم.
 */
export const authClient = createClient(
  config.supabaseUrl,
  config.supabaseServiceKey,
  supabaseOptions
);

/**
 * بيانات المستأجر / المشروع.
 */
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

/**
 * بيانات المحادثة.
 */
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
```
