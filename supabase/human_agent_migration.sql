-- ═══════════════════════════════════════════════════════════════════════════
-- Milano - Human Agent Migration
-- إضافة حقول إضافية لدعم Human Agent الاحترافي
-- ═══════════════════════════════════════════════════════════════════════════

-- إضافة حقل human_agent_enabled للمحادثات
-- هذا الحقل يتحكم في تفعيل/تعطيل Human Agent بشكل صريح
ALTER TABLE public.conversations
ADD COLUMN IF NOT EXISTS human_agent_enabled boolean NOT NULL DEFAULT false;

-- إضافة حقل human_agent_activated_at لتتبع وقت التفعيل
ALTER TABLE public.conversations
ADD COLUMN IF NOT EXISTS human_agent_activated_at timestamptz;

-- إضافة حقل human_agent_user_id لتتبع المستخدم الذي فعّل Human Agent
ALTER TABLE public.conversations
ADD COLUMN IF NOT EXISTS human_agent_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- إضافة حقل human_agent_deactivated_at لتتبع وقت التعطيل
ALTER TABLE public.conversations
ADD COLUMN IF NOT EXISTS human_agent_deactivated_at timestamptz;

-- إضافة حقل human_agent_deactivated_by لتتبع المستخدم الذي عطّل Human Agent
ALTER TABLE public.conversations
ADD COLUMN IF NOT EXISTS human_agent_deactivated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- إضافة حقل last_human_message_at لتتبع آخر رسالة من Human Agent
ALTER TABLE public.conversations
ADD COLUMN IF NOT EXISTS last_human_message_at timestamptz;

-- إضافة حقل last_ai_message_at لتتبع آخر رسالة من AI
ALTER TABLE public.conversations
ADD COLUMN IF NOT EXISTS last_ai_message_at timestamptz;

-- إنشاء فهرس للبحث السريع عن المحادثات المحولة للبشري
CREATE INDEX IF NOT EXISTS conversations_human_agent_idx 
ON public.conversations (tenant_id, human_agent_enabled, last_message_at DESC);

-- إنشاء فهرس للبحث السريع عن المحادثات المحولة للبشري حسب المستخدم
CREATE INDEX IF NOT EXISTS conversations_human_agent_user_idx 
ON public.conversations (tenant_id, human_agent_user_id, last_message_at DESC);

-- إنشاء دالة لتفعيل Human Agent
CREATE OR REPLACE FUNCTION public.enable_human_agent(
  p_conversation_id uuid,
  p_user_id uuid
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  UPDATE public.conversations
  SET human_agent_enabled = true,
      human_agent_activated_at = now(),
      human_agent_user_id = p_user_id,
      human_agent_deactivated_at = NULL,
      human_agent_deactivated_by = NULL
  WHERE id = p_conversation_id;
END;
$$;

-- إنشاء دالة لتعطيل Human Agent
CREATE OR REPLACE FUNCTION public.disable_human_agent(
  p_conversation_id uuid,
  p_user_id uuid
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  UPDATE public.conversations
  SET human_agent_enabled = false,
      human_agent_deactivated_at = now(),
      human_agent_deactivated_by = p_user_id
  WHERE id = p_conversation_id;
END;
$$;

-- إنشاء دالة لتحديث آخر رسالة من Human Agent
CREATE OR REPLACE FUNCTION public.update_last_human_message(
  p_conversation_id uuid
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  UPDATE public.conversations
  SET last_human_message_at = now()
  WHERE id = p_conversation_id;
END;
$$;

-- إنشاء دالة لتحديث آخر رسالة من AI
CREATE OR REPLACE FUNCTION public.update_last_ai_message(
  p_conversation_id uuid
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  UPDATE public.conversations
  SET last_ai_message_at = now()
  WHERE id = p_conversation_id;
END;
$$;

-- إنشاء trigger لتحديث last_human_message_at عند إضافة رسالة من Human Agent
CREATE OR REPLACE FUNCTION public.trigger_update_last_human_message()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NEW.kind = 'manual' AND NEW.is_auto = false THEN
    UPDATE public.conversations
    SET last_human_message_at = NEW.created_at
    WHERE id = NEW.conversation_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trigger_update_last_human_message
AFTER INSERT ON public.messages
FOR EACH ROW
EXECUTE FUNCTION public.trigger_update_last_human_message();

-- إنشاء trigger لتحديث last_ai_message_at عند إضافة رسالة من AI
CREATE OR REPLACE FUNCTION public.trigger_update_last_ai_message()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NEW.kind IN ('answer', 'refusal', 'handoff') AND NEW.is_auto = true THEN
    UPDATE public.conversations
    SET last_ai_message_at = NEW.created_at
    WHERE id = NEW.conversation_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trigger_update_last_ai_message
AFTER INSERT ON public.messages
FOR EACH ROW
EXECUTE FUNCTION public.trigger_update_last_ai_message();
