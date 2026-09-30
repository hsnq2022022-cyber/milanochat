# إعداد Instagram Login في MilanoChat

## التدفق المعتمد (مستقل عن Facebook Login)
- البداية: POST /api/auth/instagram/start → يبني الخادم رابط التفويض الرسمي
  https://www.instagram.com/oauth/authorize (وليس facebook.com/dialog/oauth).
- العودة: GET /api/auth/instagram/callback على نطاق Railway العام.
- تبادل الرمز: POST https://graph.instagram.com/access_token ثم ترقية إلى 60 يومًا
  عبر GET https://graph.instagram.com/upgradetoken.
- بيانات الحساب: GET https://graph.instagram.com/me?fields=user_id,username,account_type.
- الحفظ: جدول channel_accounts (تشفير access token بمفتاح FIELD_ENCRYPTION_KEY —
  لا يصل الرمز أبدًا إلى المتصفح أو logs).
- إعادة التوجيه بعد النجاح:
  https://hsnq2022022-cyber.github.io/milanochat/#/dashboard?channel_connected=instagram&...

## الصلاحيات المطلوبة (Instagram Login)
| Scope | الغرض | ملاحظات |
|---|---|---|
| user_profile | user_id + username + account_type عبر graph.instagram.com/me | بديل instagram_basic الملغاة، بدون App Review |
| business_management | الوصول لأصول Business المرتبطة | يتطلب إضافة منتج Instagram للتطبيق |
| instagram_business_manage_messages | استقبال/إرسال DMs عبر /v21.0/{ig_id}/messages + Webhook messages | يتطلب App Review؛ في وضع Development يعمل لحسابات Admin/Developer/Tester فقط إذا كان منتج Instagram Messaging API مفعّلًا ومربوطة به حساب IG احترافي |

إذا لم يكن منتج Messaging مفعّلًا بعد، اضبط على Railway:
INSTAGRAM_DISABLE_MESSAGES_SCOPE=true مؤقتًا ليكتمل الربط بصلاحية الملف الشخصي فقط.

## إعداد Meta App Dashboard (التطبيق الحالي — لا تنشئ جديدًا)
1. Products → Add Instagram → إعداد Basic Display + Login with Instagram.
2. Valid OAuth Redirect URIs أضف حرفيًا:
   https://milanochat-production.up.railway.app/api/auth/instagram/callback
3. App domains: milanochat-production.up.railway.app و hsnq2022022-cyber.github.io.
4. Products → Messenger/Instagram Messaging: فعّل Webhook:
   - Callback URL: https://milanochat-production.up.railway.app/api/webhooks/instagram
   - Verify token = قيمة INSTAGRAM_VERIFY_TOKEN في Railway.
   - Subscribe الحقول: messages, messaging_postbacks (وحساب IG من صفحة Connected Accounts).
5. For Public Use: حوّل التطبيق Live قبل الاختبار بحسابات غير مرتبطة بفريق التطوير.

## متغيرات Railway
    PUBLIC_URL=https://milanochat-production.up.railway.app   # إلزامي، https بلا مسار
    FRONTEND_ORIGIN=https://hsnq2022022-cyber.github.io
    META_APP_ID / META_APP_SECRET                              # نفس تطبيق Meta الحالي
    INSTAGRAM_VERIFY_TOKEN=...                                 # رمز تحقق webhook IG
    FIELD_ENCRYPTION_KEY=...                                   # موجود مسبقًا
    # اختياري مؤقتًا: INSTAGRAM_DISABLE_MESSAGES_SCOPE=true
متغير META_REDIRECT_URI القديم (نطاق -2ac3) غير مستخدم في تدفق Instagram — يُحذف أو يُصحّح.

## اختبار Demo قبل App Review
1. أضف حساب Instagram التجريبي ضمن Roles → Testers لحساب مستخدم Meta لديه صلاحية إدارة الحساب.
2. سجّل الدخول للوحة → تبويب القنوات → «ربط Instagram» → شاشة Instagram الرسمية → السماح.
3. Expected: العودة إلى GitHub Pages مع رسالة «تم ربط Instagram بنجاح ✅ (@username)».
4. أرسل DM من حساب آخر إلى الحساب المرتبط → يجب أن يظهر في Inbox ويرد الوكيل تلقائيًا.

## حدود معروفة
- إرسال الردود يستخدم graph.facebook.com/v21.0/{ig_user_id}/messages بنفس رمز Instagram Login —
  هذا مدعوم رسميًا لـ Instagram Messaging API لكنه يتطلب منح instagram_business_manage_messages فعليًا.
- الحسابات الشخصية (غير الاحترافية) تُربط لكن تُعلَّم بتنبيه عدم أهليتها للمراسلة.
