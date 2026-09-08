-- ═══════════════════════════════════════════════════════════════════════════
-- Migration: إنشاء Supabase Storage bucket للـ Widget Assets
-- ═══════════════════════════════════════════════════════════════════════════

-- إنشاء bucket للصور (Logo, Avatar, إلخ)
INSERT INTO storage.buckets (id, name, public)
VALUES ('widget-assets', 'widget-assets', true)
ON CONFLICT (id) DO NOTHING;

-- سياسة RLS: السماح بالقراءة العامة
CREATE POLICY "Public Access"
ON storage.objects FOR SELECT
USING (bucket_id = 'widget-assets');

-- سياسة RLS: السماح بالرفع للمالكين فقط
CREATE POLICY "Authenticated Upload"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'widget-assets' AND
  auth.role() = 'authenticated'
);

-- سياسة RLS: السماح بالحذف للمالكين فقط
CREATE POLICY "Authenticated Delete"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'widget-assets' AND
  auth.role() = 'authenticated'
);

-- سياسة RLS: السماح بالتحديث للمالكين فقط
CREATE POLICY "Authenticated Update"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'widget-assets' AND
  auth.role() = 'authenticated'
);
