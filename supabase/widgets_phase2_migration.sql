-- ═══════════════════════════════════════════════════════════════════════════════
-- Milano Widgets - المرحلة الثانية: عداد الردود والـ AI Auto-Theme
-- ═══════════════════════════════════════════════════════════════════════════════

-- إضافة حقول العداد (quota) لجدول widgets
ALTER TABLE public.widgets 
ADD COLUMN IF NOT EXISTS replies_used INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS replies_limit INTEGER DEFAULT NULL;

-- جدول لتتبع استخدام AI Auto-Theme
CREATE TABLE IF NOT EXISTS public.ai_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('site_analysis', 'theme_generation')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_usage_tenant_idx 
ON public.ai_usage (tenant_id, created_at DESC);

-- جدول لتخزين الصور المرفوعة (avatars, logos)
CREATE TABLE IF NOT EXISTS public.widget_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  widget_id UUID REFERENCES public.widgets(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('avatar', 'logo', 'launcher_icon', 'header_background')),
  url TEXT NOT NULL,
  original_name TEXT,
  size_bytes INTEGER,
  mime_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS widget_assets_tenant_idx 
ON public.widget_assets (tenant_id);

CREATE INDEX IF NOT EXISTS widget_assets_widget_idx 
ON public.widget_assets (widget_id);

-- تحديث دالة consume_reply لتتبع widget_id
CREATE OR REPLACE FUNCTION public.consume_reply(
  p_tenant_id UUID,
  p_message_id UUID,
  p_widget_id UUID DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_remaining INTEGER;
BEGIN
  -- منع الخصم المزدوج
  INSERT INTO public.reply_ledger (tenant_id, message_id)
  VALUES (p_tenant_id, p_message_id)
  ON CONFLICT (message_id) DO NOTHING;
  
  IF NOT FOUND THEN
    RETURN -2; -- سبق خصم هذه الرسالة
  END IF;

  -- خصم من الرصيد العام
  UPDATE public.tenants
     SET credits_remaining = credits_remaining - 1
   WHERE id = p_tenant_id AND credits_remaining > 0
  RETURNING credits_remaining INTO v_remaining;
  
  IF NOT FOUND THEN
    RETURN -1; -- نفد الرصيد
  END IF;

  -- تحديث عداد الـ widget إذا تم تحديده
  IF p_widget_id IS NOT NULL THEN
    UPDATE public.widgets
       SET replies_used = replies_used + 1
     WHERE id = p_widget_id
       AND (replies_limit IS NULL OR replies_used < replies_limit);
  END IF;

  RETURN v_remaining;
END;
$$;

-- دالة للتحقق من استخدام AI
CREATE OR REPLACE FUNCTION public.check_ai_usage(p_tenant_id UUID, p_limit INTEGER DEFAULT 5)
RETURNS TABLE(used INTEGER, remaining INTEGER, reset_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_used INTEGER;
  v_reset_at TIMESTAMPTZ;
BEGIN
  -- حساب عدد الاستخدامات اليوم
  SELECT COUNT(*)::INTEGER INTO v_used
  FROM public.ai_usage
  WHERE tenant_id = p_tenant_id
    AND created_at >= CURRENT_DATE;
  
  -- حساب وقت إعادة التعيين
  v_reset_at := (CURRENT_DATE + INTERVAL '1 day')::TIMESTAMPTZ;
  
  RETURN QUERY SELECT v_used, (p_limit - v_used), v_reset_at;
END;
$$;

-- دالة لتسجيل استخدام AI
CREATE OR REPLACE FUNCTION public.record_ai_usage(p_tenant_id UUID, p_action TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.ai_usage (tenant_id, action)
  VALUES (p_tenant_id, p_action);
END;
$$;
