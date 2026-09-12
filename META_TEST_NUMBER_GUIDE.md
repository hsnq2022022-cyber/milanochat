# Meta WhatsApp Test Number - دليل الاختبار

## نظرة عامة

هذا الدليل يشرح كيفية استخدام **Meta WhatsApp Test Number** مع إدارة سوشيال لاختبار التكامل مع WhatsApp Cloud API قبل التقديم لـ Meta App Review.

---

## المتطلبات

### 1. Meta Developers App

يجب أن يكون لديك:
- ✅ Meta Developers App (Business type)
- ✅ WhatsApp product مضاف
- ✅ Test Number مُفعّل
- ✅ أرقام هواتف مضافة للقائمة المسموح لها

### 2. Environment Variables

في Railway أو `.env`:

```env
WHATSAPP_ACCESS_TOKEN=your-access-token
WHATSAPP_PHONE_NUMBER_ID=your-phone-number-id
WHATSAPP_BUSINESS_ACCOUNT_ID=your-waba-id
WHATSAPP_VERIFY_TOKEN=your-verify-token
META_GRAPH_API_VERSION=v19.0
```

---

## كيفية الحصول على Meta Test Number

### 1. إنشاء Meta App

1. اذهب إلى [Meta Developers](https://developers.facebook.com/)
2. اضغط **My Apps** → **Create App**
3. اختر **Business** type
4. املأ البيانات واضغط **Create App**

### 2. إضافة WhatsApp

1. في لوحة التطبيق، اضغط **Add Product**
2. ابحث عن **WhatsApp** واضغط **Set Up**
3. ستظهر صفحة WhatsApp Quickstart

### 3. الحصول على Test Number

1. في قسم **WhatsApp > API Setup**
2. ستجد **Temporary access token** (صالح 24 ساعة)
3. انسخ **Phone number ID**
4. انسخ **WhatsApp Business Account ID**

### 4. إضافة أرقام مسموح لها

1. في قسم **WhatsApp > API Setup**
2. ابحث عن **To numbers**
3. اضغط **Manage phone number list**
4. أضف الأرقام التي تريد إرسال رسائل إليها
5. كل رقم يجب أن يتم التحقق منه عبر رمز SMS

---

## الحصول على Permanent Access Token

الـ Temporary Access Token صالح 24 ساعة فقط. للحصول على token دائم:

### الطريقة 1: System User Token (موصى بها)

1. اذهب إلى [Business Settings](https://business.facebook.com/settings)
2. **Users** → **System Users** → **Add**
3. اختر **Admin** role
4. اضغط **Add Assets** → **Apps** → اختر تطبيقك
5. اختر **whatsapp_business_messaging** permission
6. اضغط **Generate Token**
7. انسخ الـ token

### الطريقة 2: Permanent Token عبر Graph API Explorer

1. اذهب إلى [Graph API Explorer](https://developers.facebook.com/tools/explorer/)
2. اختر تطبيقك
3. اضغط **Generate Access Token**
4. اختر permissions: `whatsapp_business_messaging`
5. اضغط **Generate Access Token**
6. انسخ الـ token (صالح 60 يوم، يمكن تمديده)

---

## إعداد Webhook

### 1. Configure Webhook

1. في Meta Developers → تطبيقك → **WhatsApp > Configuration**
2. اضغط **Edit** في قسم **Webhook**
3. املأ البيانات:

```
Callback URL: https://milanochat-production.up.railway.app/api/webhooks/meta/whatsapp
Verify token: your-verify-token (نفس القيمة في WHATSAPP_VERIFY_TOKEN)
```

4. اضغط **Verify and save**

### 2. Subscribe to Fields

1. بعد التحقق، ستظهر قائمة fields
2. اضغط **Subscribe** بجانب **messages**
3. تأكد من ظهور ✅ بجانب messages

---

## اختبار التكامل

### اختبار 1: إرسال رسالة من Test Endpoint

```bash
curl -X POST https://milanochat-production.up.railway.app/api/whatsapp/send-test \
  -H "Content-Type: application/json" \
  -d '{
    "to": "+1234567890",
    "message": "Hello from Milano Test!"
  }'
```

**الاستجابة المتوقعة:**
```json
{
  "success": true,
  "messageId": "wamid.xxx",
  "message": "تم إرسال الرسالة بنجاح عبر Meta Cloud API"
}
```

### اختبار 2: إرسال رسالة من Human Agent

1. افتح Dashboard
2. اذهب إلى **Conversations**
3. اختر أو أنشئ محادثة
4. اكتب رسالة
5. اضغط **Send**
6. تحقق من وصول الرسالة إلى WhatsApp

### اختبار 3: استقبال رسالة

1. من WhatsApp، أرسل رسالة إلى Meta Test Number
2. تحقق من ظهورها في Human Agent
3. تحقق من logs في Railway

---

## البنية المعمارية

```
┌─────────────────────────────────────────────────────────────┐
│                    إدارة سوشيال (Frontend)                   │
│  - Human Agent UI                                           │
│  - Dashboard                                                │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                    Backend (Railway)                         │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │         Meta WhatsApp Cloud API                      │  │
│  │  - metaCloudAPI.ts (sendMessage)                    │  │
│  │  - webhooks.ts (receive messages)                   │  │
│  │  - /api/whatsapp/send-test (test endpoint)          │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                    Meta Graph API                            │
│  POST /v19.0/{phone-number-id}/messages                     │
│  Webhook: /api/webhooks/meta/whatsapp                       │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                    WhatsApp                                  │
│  - Test Number                                              │
│  - Allowed Numbers                                          │
└─────────────────────────────────────────────────────────────┘
```

---

## Endpoints

### إرسال رسالة (Test)

```
POST /api/whatsapp/send-test
Content-Type: application/json

{
  "to": "+1234567890",
  "message": "Test message"
}
```

### Webhook Verification

```
GET /api/webhooks/meta/whatsapp
?hub.mode=subscribe
&hub.verify_token=your-token
&hub.challenge=challenge-string
```

### Webhook Messages

```
POST /api/webhooks/meta/whatsapp
Content-Type: application/json

{
  "object": "whatsapp_business_account",
  "entry": [{
    "changes": [{
      "value": {
        "messages": [{
          "from": "1234567890",
          "id": "wamid.xxx",
          "timestamp": "1234567890",
          "type": "text",
          "text": { "body": "Hello" }
        }]
      },
      "field": "messages"
    }]
  }]
}
```

---

## استكشاف الأخطاء

### المشكلة: الرسالة لا تصل

**الحلول:**
1. تحقق من Environment Variables في Railway
2. تحقق من أن الرقم في قائمة الأرقام المسموح لها
3. تحقق من logs في Railway
5. تحقق من صلاحية الـ Access Token

### المشكلة: Webhook لا يعمل

**الحلول:**
1. تحقق من Callback URL
3. تحقق من Verify Token
4. تحقق من logs في Railway
5. تحقق من CORS settings

### المشكلة: Error "Unsupported URL"

**السبب:** الـ Graph API version غير صحيح

**الحل:**
- تأكد من `META_GRAPH_API_VERSION=v19.0`
- أو استخدم version آخر مدعوم

---

## Meta App Review

بعد نجاح الاختبارات، يمكنك تسجيل فيديو يوضح:

1. ✅ فتح إدارة سوشيال
2. ✅ فتح Human Agent
3. ✅ فتح محادثة
4. ✅ كتابة رسالة
5. ✅ الضغط على Send
6. ✅ ظهور الرسالة في WhatsApp
8. ✅ إظهار رسالة واردة من WhatsApp

### Checklist للتقديم

- [ ] Video يوضح إرسال رسالة
- [ ] Video يوضح استقبال رسالة
- [ ] Privacy Policy
- [ ] Terms of Service
- [ ] App Details
- [ ] Screenshots
- [ ] Business Verification

---

## ملاحظات مهمة

### ⚠️ قيود Test Number

- يمكن إرسال الرسائل فقط للأرقام المسموح لها
- Temporary Access Token صالح 24 ساعة
- يجب استخدام Permanent Token للاختبار الطويل

### ⚠️ الأمان

- ❌ لا تشارك Access Token
- ❌ لا تضع Token في Frontend
- ❌ لا ترفع Token إلى Git
- ✅ استخدم Environment Variables
- ✅ استخدم System User Token

### ⚠️ Limits

- Rate limit: 50 رسالة/ثانية
- Message templates مطلوبة للرسائل الأولية
- 24-hour customer service window

---

## الدعم

للأسئلة أو المشاكل:
1. راجع [Meta WhatsApp Documentation](https://developers.facebook.com/docs/whatsapp)
2. راجع logs في Railway
3. تحقق من Meta Developers status

---

**آخر تحديث:** 2026
**الإصدار:** 1.0.0
