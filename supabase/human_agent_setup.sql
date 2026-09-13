-- ═══════════════════════════════════════════════════════════════════════════
-- Milano - Human Agent Setup
-- إضافة الأعمدة المطلوبة لدعم Human Agent مع Sliding Timeout لمدة 15 دقيقة
-- ═══════════════════════════════════════════════════════════════════════════

-- ملاحظة مهمة: يجب تشغيل هذا الملف في Supabase SQL Editor

-- إضافة عمود human_agent_expires_at لتحديد وقت انتهاء Human Agent
-- هذا العمود أساسي لعمل Sliding Timeout لمدة 15 دقيقة
ALTER TABLE public.conversations
ADD COLUMN IF NOT EXISTS human_agent_expires_at timestamptz;

-- إضافة عمود human_agent_activated_by لتتبع من فعّل Human Agent
ALTER TABLE public.conversations
ADD COLUMN IF NOT EXISTS human_agent_activated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- إنشاء فهرس لتحسين أداء الاستعلامات عن المحادثات النشطة
CREATE INDEX IF NOT EXISTS conversations_human_agent_idx
ON public.conversations (tenant_id, human_agent_expires_at DESC);

-- ملاحظات:
-- 1. transferred = true يعني أن المحادثة محولة للبشري
-- 2. human_agent_expires_at > now يعني أن Human Agent لا يزال نشطًا
-- 3. عند انتهاء الوقت، يعود AI تلقائيًا للرد
-- 4. الضغط مرة أخرى على Human Agent يعيد ضبط الوقت لـ 15 دقيقة جديدة
