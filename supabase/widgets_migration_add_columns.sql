-- ═══════════════════════════════════════════════════════════════════════════
-- Milano Widgets - Migration لإضافة الأعمدة الجديدة
-- نفّذ هذا الملف إذا كان جدول widgets موجوداً بالفعل
-- ═══════════════════════════════════════════════════════════════════════════

-- إضافة الأعمدة الجديدة لجدول widgets
ALTER TABLE public.widgets 
ADD COLUMN IF NOT EXISTS header_color text NOT NULL DEFAULT '#2ec27e',
ADD COLUMN IF NOT EXISTS text_color text NOT NULL DEFAULT '#ffffff',
ADD COLUMN IF NOT EXISTS logo_url text,
ADD COLUMN IF NOT EXISTS agent_name text NOT NULL DEFAULT 'مساعد ميلانو',
ADD COLUMN IF NOT EXISTS agent_tagline text NOT NULL DEFAULT 'يرد خلال ثوانٍ',
ADD COLUMN IF NOT EXISTS border_radius integer NOT NULL DEFAULT 16,
ADD COLUMN IF NOT EXISTS shadow text NOT NULL DEFAULT 'medium' CHECK (shadow IN ('none', 'light', 'medium', 'strong')),
ADD COLUMN IF NOT EXISTS window_width integer NOT NULL DEFAULT 380,
ADD COLUMN IF NOT EXISTS window_height integer NOT NULL DEFAULT 560,
ADD COLUMN IF NOT EXISTS launcher_size integer NOT NULL DEFAULT 60,
ADD COLUMN IF NOT EXISTS launcher_shape text NOT NULL DEFAULT 'circle' CHECK (launcher_shape IN ('circle', 'square', 'rounded')),
ADD COLUMN IF NOT EXISTS launcher_icon_url text,
ADD COLUMN IF NOT EXISTS show_status boolean NOT NULL DEFAULT true,
ADD COLUMN IF NOT EXISTS show_timestamps boolean NOT NULL DEFAULT true,
ADD COLUMN IF NOT EXISTS typing_indicator boolean NOT NULL DEFAULT true,
ADD COLUMN IF NOT EXISTS settings jsonb DEFAULT '{}'::jsonb;

-- تحديث القيم الافتراضية للأعمدة الموجودة
UPDATE public.widgets 
SET 
  header_color = primary_color,
  text_color = '#ffffff',
  agent_name = name,
  agent_tagline = 'يرد خلال ثوانٍ',
  border_radius = 16,
  shadow = 'medium',
  window_width = 380,
  window_height = 560,
  launcher_size = 60,
  launcher_shape = 'circle',
  show_status = true,
  show_timestamps = true,
  typing_indicator = true
WHERE header_color IS NULL OR header_color = '';
