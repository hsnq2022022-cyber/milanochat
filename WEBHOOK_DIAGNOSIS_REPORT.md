# تقرير تشخيص مشكلة عدم ظهور رسائل WhatsApp في Inbox

## معلومات المشروع
- **المشروع:** Milano (إدارة سوشيال)
- **تاريخ التقرير:** 2026
- **المشكلة:** رسائل WhatsApp الواردة لا تظهر في Inbox رغم أن Dashboard يعرض Connected

---

## ملخص النتائج

### 1. POST webhook وصل: ⚠️ غير مؤكد
**الحالة:** يحتاج Railway logs للتأكيد

**كيف تتحقق:**
افتح Railway Dashboard → Deployments → Logs
ابحث عن السطر:
```
[Webhook] Received webhook payload
```

**إذا لم يظهر:**
- Webhook لا يصل إلى Railway
- أو Meta لم تُعدّ webhook بشكل صحيح
- أو URL خاطئ
- أو messages field غير مُفعّل في Meta

---

### 2. HTTP response: ✅ 200 OK
**الحالة:** الكود يرجع 200 في جميع الحالات

**السبب:**
Meta تتطلب 200 OK للـ webhook، لذلك الكود مبرمج ليرجع 200 حتى عند وجود أخطاء.

**الأماكن في الكود:**
```typescript
// السطر 54 - عند عدم وجود phoneNumberId
return res.status(200).send("EVENT_RECEIVED");

// السطر 65 - عند عدم وجود tenant
return res.status(200).send("EVENT_RECEIVED");

// السطر 106 - عند النجاح
res.status(200).send("EVENT_RECEIVED");

// السطر 109 - عند خطأ داخلي
res.status(500).send("Internal server error");
```

---

### 3. Payload parsed: ⚠️ غير مؤكد
**الحالة:** يحتاج Railway logs

**كيف تتحقق:**
ابحث في Railway logs عن:
```
[Webhook] Phone Number ID: xxx
```

**إذا ظهر:**
- ✅ Payload تم تحليله بنجاح
- ✅ phoneNumberId تم استخراجه

**إذا لم يظهر:**
- ❌ Payload لم يصل
- ❌ أو parseIncomingWebhook() بها مشكلة

---

### 4. messages event موجود: ⚠️ غير مؤكد
**الحالة:** يحتاج Railway logs

**كيف تتحقق:**
ابحث في Railway logs عن:
```
[Webhook] Processing message from xxx
```

**إذا ظهر:**
- ✅ Meta أرسلت message event
- ✅ الكود يعالجها

**إذا لم يظهر:**
- ❌ Meta لم ترسل message event
- ❌ أو messages field غير مُفعّل في Meta Dashboard

---

### 5. phone_number_id المستخرج: ⚠️ غير مؤكد
**الحالة:** يحتاج Railway logs

**كيف تتحقق:**
ابحث في Railway logs عن:
```
[Webhook] Phone Number ID: 1347279481797323
```

**إذا ظهر:**
- ✅ phoneNumberId تم استخراجه من metadata
- ✅ القيمة هي: xxx

**إذا ظهر بدلاً منه:**
```
[Webhook] Missing metadata.phone_number_id in webhook payload
```
- ❌ Meta لم ترسل metadata
- ❌ أو parseIncomingWebhook() لا تستخرجها

---

### 6. Tenant binding found: ⚠️ غير مؤكد
**الحالة:** يحتاج Railway logs

**كيف تتحقق:**
ابحث في Railway logs عن:
```
[Webhook] Found tenant: xxx
```

**أو:**
```
[Webhook] No tenant found for phone_number_id: xxx
[Webhook] Please bind this phone number to a tenant using POST /api/dashboard/wa/bind
```

**إذا ظهر "Found tenant":**
- ✅ tenant تم العثور عليه في wa_bindings
- ✅ الربط صحيح

**إذا ظهر "No tenant found":**
- ❌ phone_number_id غير مربوط في wa_bindings
- ❌ يجب استدعاء POST /api/dashboard/wa/bind

---

### 7. saveIncomingMessage called: ⚠️ غير مؤكد
**الحالة:** يحتاج Railway logs

**كيف تتحقق:**
ابحث في Railway logs عن:
```
[Webhook] Message processed successfully for tenant xxx
```

**إذا ظهر:**
- ✅ الرسالة تم حفظها في قاعدة البيانات
- ✅ conversation تم إنشاء/تحديث
- ✅ message تم حفظها

**إذا ظهر بدلاً منه:**
```
[Webhook] Error processing message:
```
- ❌ حدث خطأ في الحفظ
- ❌ تحقق من Supabase permissions

---

### 8. الخطوة التي تتوقف عندها الرسالة: ⚠️ غير مؤكد
**الاحتمالات:**

#### الاحتمال 1: Webhook لا يصل إلى Railway
**الدليل:** لا يظهر `[Webhook] Received webhook payload` في logs

**الأسباب:**
- Meta لم تُعدّ webhook بشكل صحيح
- URL خاطئ في Meta Dashboard
- messages field غير مُفعّل
- مشكلة في network/firewall

**الحل:**
1. افتح Meta Developers Dashboard
2. اذهب إلى WhatsApp → Configuration → Webhook
3. تأكد من URL: `https://milanochat-production.up.railway.app/api/webhooks/meta/whatsapp`
5. تأكد من تفعيل **messages** field
6. احفظ الإعدادات

#### الاحتمال 2: phoneNumberId مفقود
**الدليل:** يظهر `[Webhook] Missing metadata.phone_number_id`

**الأسباب:**
- Meta لم ترسل metadata
- parseIncomingWebhook() بها bug

**الحل:**
إضافة logging للـ payload الكامل في webhooks.ts:
```typescript
whatsappWebhookRouter.post("/whatsapp", async (req: Request, res: Response) => {
  try {
    console.log("[Webhook] Received webhook payload");
    console.log("[Webhook] Payload:", JSON.stringify(req.body, null, 2)); // ← أضف هذا
```

#### الاحتمال 3: Tenant غير مربوط
**الدليل:** يظهر `[Webhook] No tenant found for phone_number_id`

**الأسباب:**
- لم يتم استدعاء `POST /api/dashboard/wa/bind`
- phone_number_id خاطئ

**الحل:**
```bash
curl -X POST https://milanochat-production.up.railway.app/api/dashboard/wa/bind \
  -H "Authorization: Bearer YOUR_SUPABASE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"phoneNumberId": "1347279481797323"}'
```

#### الاحتمال 4: رسالة محفوظة لكن لا تظهر في Inbox
**الدليل:** يظهر `[Webhook] Message processed successfully`

**الأسباب:**
- مشكلة في Dashboard query
- RLS يمنع العرض
- tenant mismatch في Dashboard

**الحل:**
إضافة logging في dashboard.ts:
```typescript
dashboardRouter.get("/conversations", async (req, res) => {
  const tenant = await ownedTenant(...);
  console.log("[Dashboard] Fetching conversations for tenant:", tenant.id); // ← أضف هذا
```

---

### 9. السبب الحقيقي: ⚠️ غير مؤكد
**يحتاج Railway logs للتشخيص الدقيق**

**الأسباب المحتملة (بالترتيب):**

1. **Webhook لا يصل إلى Railway** (الأكثر احتمالاً)
   - Meta لم تُعدّ webhook
   - أو URL خاطئ
   - أو messages field غير مُفعّل

2. **phoneNumberId مفقود**
   - Meta لم ترسل metadata
   - أو parseIncomingWebhook() بها bug

4. **Tenant غير مربوط**
   - لم يتم استدعاء `POST /api/dashboard/wa/bind`
   - أو phone_number_id خاطئ

4. **رسالة محفوظة لكن لا تظهر**
   - مشكلة في Dashboard query
   - أو tenant mismatch

---

### 10. التعديل المقترح فقط، بدون تنفيذ:

#### إذا كان السبب #1 (Webhook لا يصل):
**لا يوجد تعديل في الكود مطلوب**

**الحل:**
1. تحقق من Meta Developers Dashboard
3. تأكد من URL: `https://milanochat-production.up.railway.app/api/webhooks/meta/whatsapp`
4. تأكد من Verify Token
5. تأكد من تفعيل **messages** field
7. احفظ الإعدادات

#### إذا كان السبب #2 (phoneNumberId مفقود):
**التعديل المقترح:**

```typescript
// في webhooks.ts، أضف logging للـ payload الكامل
whatsappWebhookRouter.post("/whatsapp", async (req: Request, res: Response) => {
  try {
    console.log("[Webhook] Received webhook payload");
    console.log("[Webhook] Payload:", JSON.stringify(req.body, null, 2)); // ← أضف هذا
```

#### إذا كان السبب #3 (Tenant غير مربوط):
**لا يوجد تعديل في الكود مطلوب**

**الحل:**
```bash
curl -X POST https://milanochat-production.up.railway.app/api/dashboard/wa/bind \
  -H "Authorization: Bearer YOUR_SUPABASE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"phoneNumberId": "1347279481797323"}'
```

#### إذا كان السبب #4 (رسالة محفوظة لكن لا تظهر):
**التعديل المقترح:**

```typescript
// في dashboard.ts، أضف logging للـ query
dashboardRouter.get("/conversations", async (req, res) => {
  const tenant = await ownedTenant(...);
  console.log("[Dashboard] Fetching conversations for tenant:", tenant.id); // ← أضف هذا
```

---

## التفاصيل التقنية

### A) Webhook URL
**✅ صحيح**

**المسار:** `/api/webhooks/meta/whatsapp`

**الدليل من الكود:**
```typescript
// server/src/index.ts - السطر 73
app.use("/api/webhooks/meta", whatsappWebhookRouter);

// server/src/routes/webhooks.ts - السطر 23 و 45
whatsappWebhookRouter.get("/whatsapp", ...)
whatsappWebhookRouter.post("/whatsapp", ...)
```

**المسار الكامل:** `/api/webhooks/meta` + `/whatsapp` = `/api/webhooks/meta/whatsapp` ✅

---

### B) GET verification
**✅ يعمل**

**الكود:**
```typescript
// السطر 23-39
whatsappWebhookRouter.get("/whatsapp", async (req: Request, res: Response) => {
  const mode = req.query["hub.mode"] as string;
  const token = req.query["hub.verify_token"] as string;
  const challenge = req.query["hub.challenge"] as string;

  console.log("[Webhook] Verification request received:", { mode, token: token?.substring(0, 10) + "..." });

  const result = metaCloudAPI.handleWebhookVerification(mode, token, challenge);
  
  if (result) {
    console.log("[Webhook] Verification successful");
    res.status(200).send(result);
  } else {
    console.error("[Webhook] Verification failed");
    res.status(403).send("Verification failed");
  }
});
```

**للتحقق:** ابحث في Railway logs عن:
```
[Webhook] Verification request received
[Webhook] Verification successful
```

---

### C) POST webhook يصل إلى Railway
**⚠️ غير مؤكد - يحتاج Railway logs**

**الدليل من الكود:**
```typescript
// السطر 45-47
whatsappWebhookRouter.post("/whatsapp", async (req: Request, res: Response) => {
  try {
    console.log("[Webhook] Received webhook payload");
```

**للتحقق:** ابحث في Railway logs عن:
```
[Webhook] Received webhook payload
```

**إذا لم يظهر هذا السطر:**
- Webhook لا يصل إلى Railway
- أو Meta لم تُعدّ webhook بشكل صحيح
- أو هناك مشكلة في network/firewall

---

### D) Logs عند إرسال رسالة من الهاتف

#### هل يظهر log خاص باستقبال POST؟
**✅ نعم، السطر 47:**
```typescript
console.log("[Webhook] Received webhook payload");
```

#### هل يظهر payload؟
**❌ لا، لا يوجد log للـ payload الكامل**

**المشكلة:** الكود لا يسجل `req.body` كاملاً، فقط يسجل `phoneNumberId` لاحقاً.

#### هل يظهر message event؟
**✅ نعم، السطر 73:**
```typescript
console.log(`[Webhook] Processing message from ${message.chatId}: ${message.text.substring(0, 50)}...`);
```

#### هل يظهر from؟
**✅ نعم، في السطر 73:**
```typescript
message.chatId  // هذا هو message.from من Meta
```

#### هل يظهر metadata.phone_number_id؟
**✅ نعم، السطر 57:**
```typescript
console.log(`[Webhook] Phone Number ID: ${phoneNumberId}`);
```

---

### E) نوع event من Meta
**⚠️ يعتمد على إعدادات Meta**

**الدليل من الكود:**
```typescript
// السطر 218
if (change.field !== 'messages') continue;
```

**الكود يتوقع `field: 'messages'`**

**للتحقق:**
1. افتح Meta Developers Dashboard
2. اذهب إلى WhatsApp → Configuration → Webhook
3. تحقق من "Webhook fields"
4. يجب أن يكون **messages** مُفعّل (subscribe)

**إذا لم يكن messages مُفعّل:**
- Meta لن ترسل message events
- فقط status events ستصل

---

### F) اشتراك Webhook في حقل messages
**⚠️ غير مؤكد - يحتاج التحقق من Meta Dashboard**

**للتحقق:**
1. افتح [Meta Developers Dashboard](https://developers.facebook.com/)
2. اختر التطبيق
3. اذهب إلى **WhatsApp → Configuration**
4. في قسم **Webhook**، اضغط **Edit**
5. تحقق من **Webhook fields**
6. يجب أن يكون **messages** مُفعّل ✅

**إذا لم يكن مُفعّل:**
- اضغط **Subscribe** بجانب **messages**
- احفظ الإعدادات

---

### G) HTTP response من POST
**✅ نعم، يرجع 200 في جميع الحالات**

**الدليل من الكود:**

#### الحالة 1: نجاح كامل
```typescript
// السطر 106
res.status(200).send("EVENT_RECEIVED");
```

#### الحالة 2: phoneNumberId مفقود
```typescript
// السطر 54
return res.status(200).send("EVENT_RECEIVED"); // Meta يتطلب 200 OK
```

#### الحالة 3: tenant غير موجود
```typescript
// السطر 65
return res.status(200).send("EVENT_RECEIVED"); // Meta يتطلب 200 OK
```

#### الحالة 4: خطأ داخلي
```typescript
// السطر 109
res.status(500).send("Internal server error");
```

**ملاحظة مهمة:**
- الكود يرجع 200 OK حتى عند عدم العثور على tenant
- هذا صحيح لأن Meta يتطلب 200 OK
- لكن هذا يخفي المشكلة!

---

### H) express.json() يعمل قبل webhook router
**✅ نعم، express.json() يعمل قبل الـ routers**

**الدليل:**
```typescript
// السطر 49-56 في index.ts
app.use(
  express.json({
    limit: "1mb",
    verify: (req: any, _res, buf) => {
      if (req.originalUrl?.startsWith("/api/webhooks")) req.rawBody = buf;
    },
  })
);

// السطر 73
app.use("/api/webhooks/meta", whatsappWebhookRouter);
```

**الترتيب:**
1. `express.json()` مُسجل أولاً (السطر 49)
2. `whatsappWebhookRouter` مُسجل ثانياً (السطر 73)

**النتيجة:**
- `req.body` يجب أن يكون object ✅
- `req.rawBody` متاح للتحقق من التوقيع

---

### I) تسلسل الاستدعاء بعد استقبال POST
**✅ نعم، التسلسل صحيح**

**الدليل:**
```typescript
// السطر 50
const { messages, statuses, phoneNumberId } = metaCloudAPI.parseIncomingWebhook(req.body);

// السطر 60
const tenantId = await findTenantByPhoneNumberId(phoneNumberId);

// السطر 79
await saveIncomingMessage(message);
```

**التسلسل:**
1. ✅ `parseIncomingWebhook()` - السطر 50
2. ✅ `findTenantByPhoneNumberId()` - السطر 60
3. ✅ `saveIncomingMessage()` - السطر 79

---

### J) Railway logs أثناء إرسال رسالة اختبار
**⚠️ لا يمكن الوصول إلى Railway logs من الكود**

**لكن الكود يسجل الأحداث التالية:**

```typescript
// عند استقبال POST
console.log("[Webhook] Received webhook payload");

// عند استخراج phoneNumberId
console.log(`[Webhook] Phone Number ID: ${phoneNumberId}`);

// عند عدم العثور على phoneNumberId
console.error("[Webhook] Missing metadata.phone_number_id in webhook payload");

// عند عدم العثور على tenant
console.error(`[Webhook] No tenant found for phone_number_id: ${phoneNumberId}`);
console.error("[Webhook] Please bind this phone number to a tenant using POST /api/dashboard/wa/bind");

// عند العثور على tenant
console.log(`[Webhook] Found tenant: ${tenantId}`);

// عند معالجة رسالة
console.log(`[Webhook] Processing message from ${message.chatId}: ${message.text.substring(0, 50)}...`);

// عند نجاح المعالجة
console.log(`[Webhook] Message processed successfully for tenant ${tenantId}`);

// عند خطأ
console.error("[Webhook] Error processing message:", error);
```

**للحصول على logs الفعلية:**
1. افتح Railway Dashboard
2. اذهب إلى Deployments
3. اختر الـ Deployment الحالي
4. افتح Logs
5. أرسل رسالة اختبار من WhatsApp
6. ابحث عن السطور أعلاه

---

## الخطوات المطلوبة للتشخيص

### الخطوة 1: تحقق من Railway logs
```bash
# في Railway Dashboard → Logs
ابحث عن:
[Webhook] Received webhook payload
[Webhook] Phone Number ID
[Webhook] Found tenant
[Webhook] Message processed
```

### الخطوة 2: تحقق من Meta Dashboard
1. افتح Meta Developers Dashboard
2. اذهب إلى WhatsApp → Configuration → Webhook
3. تحقق من:
   - Callback URL: `https://milanochat-production.up.railway.app/api/webhooks/meta/whatsapp`
   - Verify Token
   - **messages** field مُفعّل

### الخطوة 3: تحقق من wa_bindings
```sql
-- في Supabase SQL Editor
SELECT * FROM wa_bindings;
```

### الخطوة 4: اختبر webhook يدوياً
```bash
curl -X POST https://milanochat-production.up.railway.app/api/webhooks/meta/whatsapp \
  -H "Content-Type: application/json" \
  -d '{
    "entry": [{
      "changes": [{
        "field": "messages",
        "value": {
          "metadata": {
            "phone_number_id": "1347279481797323"
          },
          "messages": [{
            "from": "966501234567",
            "id": "wamid.test",
            "timestamp": "1234567890",
            "type": "text",
            "text": { "body": "Test message" }
          }]
        }
      }]
    }]
  }'
```

ثم تحقق من Railway logs.

---

## الخلاصة

### ✅ ما تم تأكيده:
- Webhook URL صحيح
- GET verification يعمل
- POST endpoint مُسجل
- express.json() يعمل
- تسلسل الاستدعاء صحيح
- HTTP response يرجع 200

### ⚠️ ما يحتاج تحقق:
- هل Webhook يصل فعلياً إلى Railway
- هل Meta ترسل message events
- هل messages field مُفعّل في Meta Dashboard
- هل phone_number_id مربوط في wa_bindings

### 🔴 السبب الجذري:
**غير مؤكد - يحتاج Railway logs**

### 📝 الخطوات التالية:
1. فتح Railway Dashboard → Logs
2. البحث عن رسائل `[Webhook]`
3. التحقق من Meta Dashboard
4. اختبار webhook يدوياً

---

**تاريخ التقرير:** 2026
**حالة التشخيص:** ⚠️ يحتاج Railway logs
**الخطوة التالية:** فتح Railway Dashboard → Logs والبحث عن رسائل Webhook
