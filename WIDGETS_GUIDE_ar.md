# Milano Widgets — دليل الاستخدام

## ما هو Widget؟

Widget هو نافذة محادثة صغيرة يمكنك تضمينها في أي موقع ويب، تتصل بـ Agent الخاص بك وتستخدم قاعدة المعرفة الخاصة بك للرد على الزوار تلقائياً.

## الميزات

- ✅ **تخصيص كامل**: الاسم، اللون، رسالة الترحيب، الموقع (يمين/يسار)، placeholder
- ✅ **معاينة حية**: شاهد كيف سيظهر الـ widget قبل تضمينه
- ✅ **Embed Code**: كود JavaScript بسيط للتضمين في أي موقع
- ✅ **جلسات مستمرة**: يتذكر الزائر ومحادثته عند العودة
- ✅ **RTL**: دعم كامل للعربية
- ✅ **Mobile Responsive**: يعمل بشكل ممتاز على الجوال
- ✅ **أمان**: تحقق من Token، Rate Limiting، عزل بين الـ tenants

## كيفية الاستخدام

### 1. إنشاء Widget من لوحة التحكم

1. افتح لوحة التحكم: `https://hsnq2022022-cyber.github.io/milanochat/#/dashboard`
2. سجّل الدخول
3. انتقل إلى تبويب **Widgets**
4. املأ النموذج:
   - **الاسم**: اسم وصفي للـ widget (مثال: "Widget الموقع الرئيسي")
   - **رسالة الترحيب**: الرسالة الأولى التي يراها الزائر
   - **اللون الأساسي**: لون الـ widget (يتطابق مع هوية علامتك)
   - **الموقع**: يسار أو يمين الشاشة
   - **Placeholder**: النص التوضيحي في حقل الإدخال
5. اضغط **إنشاء Widget**

### 2. نسخ كود التضمين

بعد الإنشاء، ستظهر قائمة بالـ widgets. اضغط **نسخ الكود** لنسخ كود JavaScript:

```html
<script src="https://milanochat-production.up.railway.app/widget.js" data-token="YOUR_WIDGET_TOKEN"></script>
```

### 3. تضمين الكود في موقعك

الصق الكود قبل إغلاق `</body>` في صفحة HTML:

```html
<!DOCTYPE html>
<html>
<head>
  <title>موقعي</title>
</head>
<body>
  <h1>مرحباً بكم</h1>
  
  <!-- Milano Widget -->
  <script src="https://milanochat-production.up.railway.app/widget.js" data-token="abc123xyz"></script>
</body>
</html>
```

### 4. معاينة الـ Widget

من لوحة التحكم، اضغط **معاينة** بجانب أي widget لرؤية كيف سيظهر للزوار.

## إدارة Widgets

### تفعيل/تعطيل

- اضغط **تعطيل** لإخفاء الـ widget من الموقع (لا يحذف البيانات)
- اضغط **تفعيل** لإعادة إظهاره

### تعديل الإعدادات

1. اضغط **تعديل** بجانب الـ widget
2. غيّر الإعدادات المطلوبة
3. اضغط **حفظ التعديلات**

### حذف Widget

1. اضغط **حذف** بجانب الـ widget
2. أكّد الحذف
3. سيُحذف الـ widget وجميع بياناته (محادثات، جلسات)

## API Endpoints

### للوحة التحكم (محمية بـ Auth)

- `GET /api/widgets/dashboard` — قائمة widgets
- `POST /api/widgets/dashboard` — إنشاء widget
- `PUT /api/widgets/dashboard/:id` — تحديث widget
- `DELETE /api/widgets/dashboard/:id` — حذف widget

### للـ Widget العام (بدون Auth)

- `GET /api/widgets/public/:token` — جلب إعدادات widget
- `POST /api/widgets/public/:token/session` — إنشاء/استرجاع جلسة
- `POST /api/widgets/public/:token/message` — إرسال رسالة والحصول على رد

## الأمان

- **Token فريد**: كل widget له `public_token` فريد
- **Rate Limiting**: حماية من الإرسال المفرط
- **عزل Tenants**: كل widget مرتبط بـ tenant محدد
- **RLS Policies**: سياسات أمان على مستوى الصفوف في Supabase
- **تحقق من Token**: الخادم يتحقق من صحة الـ token قبل أي عملية

## قاعدة البيانات

### الجداول الجديدة

1. **widgets**: تخزين إعدادات الـ widgets
2. **widget_sessions**: تتبع جلسات الزوار
3. **widget_messages**: سجل المحادثات

### تشغيل المخطط

نفّذ ملف `supabase/widgets_schema.sql` في Supabase SQL Editor **بعد** تشغيل `schema.sql` الأساسي.

## أمثلة استخدام

### مثال 1: Widget بسيط

```javascript
{
  name: "Widget الموقع الرئيسي",
  welcomeMessage: "مرحباً! كيف يمكنني مساعدتك؟",
  primaryColor: "#2ec27e",
  position: "left",
  placeholder: "اكتب رسالتك..."
}
```

### مثال 2: Widget بألوان مخصصة

```javascript
{
  name: "Widget الدعم الفني",
  welcomeMessage: "أهلاً بك! أنا هنا لمساعدتك في أي مشكلة تقنية.",
  primaryColor: "#3b82f6",
  position: "right",
  placeholder: "صف مشكلتك هنا..."
}
```

## استكشاف الأخطاء

### الـ Widget لا يظهر

1. تأكد من أن الـ widget **مفعّل** في لوحة التحكم
2. تحقق من أن `data-token` صحيح
3. افتح Console في المتصفح وتحقق من الأخطاء
4. تأكد من أن رابط الخادم صحيح في `src`

### الـ Widget يظهر لكن لا يرد

1. تأكد من أن لديك **رصيد ردود** كافٍ في لوحة التحكم
2. تحقق من أن قاعدة المعرفة تحتوي على معلومات ذات صلة
3. افتح Network tab وتحقق من استجابة `/api/widgets/public/:token/message`

### خطأ CORS

تأكد من أن `FRONTEND_ORIGIN` في Railway يحتوي على نطاق موقعك.

## التطوير المستقبلي

- [ ] دعم الصور والملفات
- [ ] أسئلة مقترحة
- [ ] تحليلات وإحصائيات
- [ ] تحويل المحادثة لبشري
- [ ] إشعارات للزائر
- [ ] تخصيصات إضافية (avatar، خطوط، إلخ)

## الدعم

للأسئلة أو المشاكل، افتح issue في المستودع أو راسل الدعم الفني.
