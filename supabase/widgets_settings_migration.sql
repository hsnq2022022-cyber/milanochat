-- ═══════════════════════════════════════════════════════════════════════════════
-- Milano Widgets Schema - تحديث للمحرر المتقدم
-- نفّذ هذا الملف في Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════════

-- إضافة عمود settings كـ JSONB لتخزين الإعدادات الموسعة
ALTER TABLE public.widgets 
ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}'::jsonb;

-- إنشاء فهرس للبحث السريع
CREATE INDEX IF NOT EXISTS widgets_settings_idx 
ON public.widgets USING GIN (settings);

-- دالة للتحقق من صحة الإعدادات (اختياري)
CREATE OR REPLACE FUNCTION public.validate_widget_settings()
RETURNS TRIGGER AS $$
BEGIN
  -- التحقق من وجود الحقول الأساسية
  IF NOT (NEW.settings ? 'appearance' AND NEW.settings ? 'chat') THEN
    RAISE EXCEPTION 'Settings must contain appearance and chat objects';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger للتحقق (اختياري - يمكن تعطيله إذا سبب مشاكل)
-- DROP TRIGGER IF EXISTS validate_widget_settings_trigger ON public.widgets;
-- CREATE TRIGGER validate_widget_settings_trigger
-- BEFORE INSERT OR UPDATE ON public.widgets
-- FOR EACH ROW EXECUTE FUNCTION public.validate_widget_settings();
