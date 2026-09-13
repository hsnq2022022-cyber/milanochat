-- ═══════════════════════════════════════════════════════════════════════════
-- Milano - Supabase Realtime Setup for Conversations & Messages
-- تمكين Realtime للجداول المطلوبة لتحديث المحادثات فورياً
-- ═══════════════════════════════════════════════════════════════════════════

-- ملاحظة: يجب تشغيل هذا الملف في Supabase SQL Editor لتفعيل Realtime

-- إضافة جدول conversations إلى publication الخاص بـ Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.conversations;

-- إضافة جدول messages إلى publication الخاص بـ Realtime  
ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;

-- التحقق من أن الأعمدة المطلوبة متاحة للـ Realtime
-- (Supabase 2.x يجعل جميع الأعمدة متاحة افتراضياً)

-- ملاحظات مهمة:
-- 1. هذا لا يؤثر على RLS - سياسات الأمان تظل سارية
-- 2. العميل سيستقبل فقط الأحداث التي يملك صلاحية قراءتها عبر RLS
-- 3. يجب أن يكون لدى المستخدم جلسة صالحة للاشتراك في القنوات

-- لإيقاف Realtime لاحقاً إذا لزم الأمر:
-- ALTER PUBLICATION supabase_realtime DROP TABLE public.conversations;
-- ALTER PUBLICATION supabase_realtime DROP TABLE public.messages;
