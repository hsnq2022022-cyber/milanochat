#!/bin/bash

# ═══════════════════════════════════════════════════════════════════════════
# اختبار Webhook POST - Milano
# ═══════════════════════════════════════════════════════════════════════════

echo "═══════════════════════════════════════════════════════════"
echo "اختبار Webhook POST إلى Railway"
echo "═══════════════════════════════════════════════════════════"
echo ""

# المتغيرات
ENDPOINT="https://milanochat-production.up.railway.app/api/webhooks/meta/whatsapp"
PHONE_NUMBER_ID="1347279481797323"
TENANT_ID="906eded7-6c3e-4f26-b7d1-60dadcc10c00"

# JSON payload
JSON_PAYLOAD=$(cat <<EOF
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "1785877425882405",
    "changes": [{
      "value": {
        "messaging_product": "whatsapp",
        "metadata": {
          "display_phone_number": "15556171244",
          "phone_number_id": "${PHONE_NUMBER_ID}"
        },
        "contacts": [{
          "profile": {
            "name": "الميلاني"
          },
          "wa_id": "9647764533213",
          "user_id": "IQ.965763846551001"
        }],
        "messages": [{
          "from": "9647764533213",
          "id": "wamid.test123",
          "timestamp": "1234567890",
          "type": "text",
          "text": {
            "body": "اهلا وسهلا - اختبار webhook"
          }
        }]
      },
      "field": "messages"
    }]
  }]
}
EOF
)

echo "Endpoint: ${ENDPOINT}"
echo "Phone Number ID: ${PHONE_NUMBER_ID}"
echo "Tenant ID: ${TENANT_ID}"
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "إرسال POST request..."
echo "═══════════════════════════════════════════════════════════"
echo ""

# إرسال POST request
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${ENDPOINT}" \
  -H "Content-Type: application/json" \
  -d "${JSON_PAYLOAD}")

# استخراج HTTP status code
HTTP_STATUS=$(echo "$RESPONSE" | tail -n1)
RESPONSE_BODY=$(echo "$RESPONSE" | sed '$d')

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "النتيجة:"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "HTTP Status: ${HTTP_STATUS}"
echo ""
echo "Response Body:"
echo "${RESPONSE_BODY}"
echo ""

# التحقق من النتيجة
if [ "$HTTP_STATUS" = "200" ]; then
  echo "✅ ✅ ✅"
  echo "✅ POST request نجح - HTTP 200"
  echo "✅ ✅ ✅"
  echo ""
  echo "الخطوة التالية:"
  echo "1. افتح Railway Dashboard"
  echo "2. اذهب إلى Deployments → Logs"
  echo "3. ابحث عن:"
  echo "   [Webhook POST] POST request received"
  echo "   [Webhook POST] Body.object: whatsapp_business_account"
  echo "   [Webhook POST] Body.entry?.length: 1"
  echo "   [Webhook] Phone Number ID: ${PHONE_NUMBER_ID}"
  echo "   [Webhook] Found tenant: ${TENANT_ID}"
  echo "   [Webhook] Message processed successfully"
elif [ "$HTTP_STATUS" = "404" ]; then
  echo "❌ ❌ ❌"
  echo "❌ POST request فشل - HTTP 404"
  echo "❌ المسار غير موجود"
  echo "❌ ❌ ❌"
elif [ "$HTTP_STATUS" = "500" ]; then
  echo "⚠️ ⚠️ ⚠️"
  echo "⚠️ POST request وصل لكن حدث خطأ داخلي - HTTP 500"
  echo "⚠️ افحص Railway logs لمعرفة السبب"
  echo "⚠️ ⚠️ ⚠️"
else
  echo "⚠️ ⚠️ ⚠️"
  echo "⚠️ HTTP Status: ${HTTP_STATUS}"
  echo "⚠️ افحص Railway logs لمعرفة التفاصيل"
  echo "⚠️ ⚠️ ⚠️"
fi

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "انتهى الاختبار"
echo "═══════════════════════════════════════════════════════════"
