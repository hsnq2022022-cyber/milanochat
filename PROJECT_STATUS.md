# 📑 توثيق حالة مشروع MilanoChat (إدارة سوشيال) - Checkpoint

## 🛠️ معلومات البنية التحتية (Infrastructure):
- **مستودع GitHub**: `hsnq2022022-cyber/milanochat`
- **مسار المشروع المحلي**: `~/milanochat`
- **مشروع Supabase الفعال**: `nmhefwvhoholcjrbbila` (الرابط: `https://nmhefwvhoholcjrbbila.supabase.co`)
- **المحرك**: Supabase Edge Functions (Deno) + Vanilla JS (Widget) + Google Gemini (للـ Embeddings والـ LLM).

## ✅ ما تم إنجازه بنجاح (Completed):
1. **نقل الـ Widget**: تم فك ارتباط الـ Widget القديم بـ Express/Railway، وتعديل ملف `server/public/widget.js` ليتصل بـ Supabase `milan-api`.
2. **تقديم الـ Widget**: تمت إضافة `case "widget.js"` في `milan-api/index.ts` لجلب كود الـ Widget من GitHub وتقديمه كـ `application/javascript`.
3. **إصلاح الـ Embeddings**: تم تعديل دالة `embed` في `milan-api` لتستخدم Google Gemini API (`text-embedding-004` عبر إصدار `v1`) بدلاً من OpenAI، ليتوافق مع مفتاح Google الخاص بالمشروع.
4. **إضافة مزامنة سلة**: تمت إضافة إجراء `sync_salla_products` في `milan-api` لجلب المنتجات من Salla API وحفظها كـ Embeddings في قاعدة المعرفة.
5. **تجاوز قيود قاعدة البيانات**: 
   - تم إزالة القيد `knowledge_sources_kind_check` من Supabase للسماح بإدخال أنواع جديدة مثل `salla_products`.
   - تم إدخال توكن وهمي في جدول `channel_accounts` (القناة: `salla`) لاختبار الاتصال، وتم حذفه لاحقاً.
6. **الاختبار الناجح (RAG)**: تم إدخال منتج (بنطرون جينز بـ 25 ألف دينار) في `knowledge_add`، ورد الـ Widget في متجر سلة بالإجابة الصحيحة! (مما يؤكد نجاح دورة RAG بالكامل).
7. **تثبيت الـ Snippet**: تم ربط الـ Widget في بوابة شركاء سلة عبر `App Snippets` وإعادة تثبيت التطبيق على المتجر التجريبي `Milano`.

## ⏳ الخطوة التالية (Next Steps):
- **برمجة Salla OAuth Webhook**: 
  - استقبال الكود من سلة عند التثبيت.
  - استبداله بـ `Access Token` حقيقي.
  - تشفيره بـ `encryptField` وحفظه في جدول `channel_accounts` (القناة: `salla`).
  - تفعيل المزامنة التلقائية للمنتجات.

## ⚠️ ملاحظات هامة:
- التوكنات (Tokens) الخاصة بالدخول (JWT) تنتهي صلاحيتها كل ساعة، ويجب جلب توكن جديد من `Local Storage` في المتصفح عند اختبار الـ API يدوياً.
- يتم استخدام `Authorization: Bearer <TOKEN>` في ترويسات طلبات الـ `curl`.
- عند تعديل `index.ts` محلياً، يجب رفعه لـ GitHub ثم نسخه ولصقه يدوياً في محرر Supabase وعمل Deploy.
