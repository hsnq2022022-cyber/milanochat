-- ═══════════════════════════════════════════════════════════════════════════
-- Milano — Human Agent with 60-minute Sliding Timeout
-- يضيف دعم مؤقت 60 دقيقة قابل للتجديد (Sliding Window)
-- ═══════════════════════════════════════════════════════════════════════════

-- إضافة عمود human_agent_expires_at لتتبع وقت انتهاء Human Agent
-- إذا كان NULL أو في الماضي، فإن Human Agent غير فعال
ALTER TABLE public.conversations
ADD COLUMN IF NOT EXISTS human_agent_expires_at timestamptz;

-- إضافة عمود human_agent_activated_by لتتبع من فعّل Human Agent
ALTER TABLE public.conversations
ADD COLUMN IF NOT EXISTS human_agent_activated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- إنشاء فهرس للبحث السريع عن المحادثات النشطة حاليًا مع Human Agent
CREATE INDEX IF NOT EXISTS conversations_human_agent_active_idx 
ON public.conversations (tenant_id, human_agent_expires_at DESC)
WHERE human_agent_expires_at > NOW();

-- دالة لتفعيل Human Agent لمدة 60 دقيقة (قابلة للتجديد)
CREATE OR REPLACE FUNCTION public.enable_human_agent_timeout(
  p_conversation_id uuid,
  p_user_id uuid,
  p_duration_minutes integer DEFAULT 60
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  UPDATE public.conversations
  SET 
    transferred = true,
    auto_paused_reason = 'manual_takeover',
    human_agent_expires_at = NOW() + (p_duration_minutes || ' minutes')::interval,
    human_agent_activated_by = p_user_id
  WHERE id = p_conversation_id;
END;
$$;

-- دالة لإلغاء Human Agent يدويًا قبل انتهاء الوقت
CREATE OR REPLACE FUNCTION public.disable_human_agent_timeout(
  p_conversation_id uuid,
  p_user_id uuid
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  UPDATE public.conversations
  SET 
    transferred = false,
    auto_paused_reason = NULL,
    human_agent_expires_at = NULL,
    human_agent_activated_by = NULL
  WHERE id = p_conversation_id;
END;
$$;

-- دالة للتحقق مما إذا كان Human Agent نشطًا حاليًا (مع التحقق من الوقت)
CREATE OR REPLACE FUNCTION public.is_human_agent_active(
  p_conversation_id uuid
)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  SELECT 
    transferred = true 
    AND human_agent_expires_at > NOW()
  FROM public.conversations
  WHERE id = p_conversation_id;
$$;

-- دالة للحصول على الوقت المتبقي بالثواني (للعرض في الواجهة)
CREATE OR REPLACE FUNCTION public.get_human_agent_remaining_seconds(
  p_conversation_id uuid
)
RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  SELECT 
    CASE 
      WHEN transferred = true AND human_agent_expires_at > NOW() 
      THEN EXTRACT(EPOCH FROM (human_agent_expires_at - NOW()))::integer
      ELSE 0
    END
  FROM public.conversations
  WHERE id = p_conversation_id;
$$;

-- Trigger لتنظيف تلقائي عند انتهاء الوقت (اختياري - يمكن الاعتماد على التحقق في Backend)
-- ملاحظة: هذا الـ trigger لا يُنفّذ فعليًا لأن PostgreSQL لا تدعم triggers زمنية
-- بدلاً من ذلك، يتم التحقق من الوقت في Backend عند كل رسالة واردة

COMMENT ON COLUMN public.conversations.human_agent_expires_at IS 'وقت انتهاء Human Agent - إذا كان NULL أو في الماضي، فإن Human Agent غير فعال';
COMMENT ON COLUMN public.conversations.human_agent_activated_by IS 'المستخدم الذي فعّل Human Agent آخر مرة';
