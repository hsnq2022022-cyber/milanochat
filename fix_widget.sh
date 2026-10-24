#!/bin/bash
FILE="server/public/widget.js"

# 1. إنشاء نسخة احتياطية
cp $FILE ${FILE}.bak

# 2. تعديل رابط جلب الإعدادات
sed -i 's|/api/widgets/public/${token}`|/functions/v1/milan-api?action=widget_public\&token=${token}`|g' $FILE

# 3. تعديل رابط جلب الجلسة وإضافة الـ token للبيانات
sed -i 's|/api/widgets/public/${token}/session|/functions/v1/milan-api?action=widget_session|g' $FILE
sed -i 's|JSON.stringify({ visitorId, origin: window.location.origin })|JSON.stringify({ token, visitorId, origin: window.location.origin })|g' $FILE

# 4. تعديل رابط إرسال الرسالة وإضافة الـ token للبيانات
sed -i 's|/api/widgets/public/${token}/message|/functions/v1/milan-api?action=widget_message|g' $FILE
sed -i 's|JSON.stringify({ sessionId, message: text, origin: window.location.origin })|JSON.stringify({ token, sessionId, message: text, origin: window.location.origin })|g' $FILE

echo "✅ تم التعديل بنجاح! وتم إنشاء نسخة احتياطية باسم widget.js.bak"
