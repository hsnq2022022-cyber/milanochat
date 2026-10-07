-- ═══ Migration: حقول توجيه الرسائل في conversations ═══
-- مطلوبة لـ sendToConversation() في supabase/functions/milan-api/index.ts
-- - recipient_id : معرّف المستلم الخام (رقم واتساب / PSID / IG-scoped ID)
-- - phone_id     : phone_number_id الخاص بالحساب المرتبط بالمحادثة
-- آمنة للتكرار (IF NOT EXISTS) ولا تغيّر أي بيانات موجودة.

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS recipient_id text;

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS phone_id text;

-- تعبئة recipient_id من wa_chat_id للمحادثات الموجودة (يُزال البادئة فقط)
UPDATE public.conversations
SET recipient_id = REPLACE(wa_chat_id, 'whatsapp:', '')
WHERE recipient_id IS NULL
  AND wa_chat_id IS NOT NULL;
