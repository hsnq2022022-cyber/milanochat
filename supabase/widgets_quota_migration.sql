-- ═══════════════════════════════════════════════════════════════════════════
-- Migration: إضافة حدود الردود إلى جدول widgets
-- نفّذ هذا إذا كان جدول widgets موجوداً مسبقاً
-- ═══════════════════════════════════════════════════════════════════════════

-- إضافة أعمدة حدود الردود
ALTER TABLE public.widgets 
ADD COLUMN IF NOT EXISTS responses_limit integer,
ADD COLUMN IF NOT EXISTS responses_used integer NOT NULL DEFAULT 0;

-- إضافة دالة للتحقق من حد الردود
CREATE OR REPLACE FUNCTION public.check_widget_quota(p_widget_id uuid)
RETURNS TABLE(can_respond boolean, remaining integer, limit_value integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_limit integer;
  v_used integer;
BEGIN
  SELECT responses_limit, responses_used 
  INTO v_limit, v_used
  FROM public.widgets 
  WHERE id = p_widget_id;
  
  -- إذا لم يكن هناك حد، يمكن الرد دائماً
  IF v_limit IS NULL THEN
    RETURN QUERY SELECT true, -1, -1;
  ELSE
    RETURN QUERY SELECT 
      v_used < v_limit,
      v_limit - v_used,
      v_limit;
  END IF;
END;
$$;

-- إضافة دالة لزيادة عداد الردود
CREATE OR REPLACE FUNCTION public.increment_widget_responses(p_widget_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_new_count integer;
BEGIN
  UPDATE public.widgets
  SET responses_used = responses_used + 1
  WHERE id = p_widget_id
  RETURNING responses_used INTO v_new_count;
  
  RETURN v_new_count;
END;
$$;
