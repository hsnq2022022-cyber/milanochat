import re

file_path = "supabase/functions/salla-webhook/index.ts"

try:
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    # البحث عن السطر الذي يحدد الـ finalTenantId واستبداله
    target = 'const finalTenantId = tenantId || merchantEmail || merchantId;'
    replacement = 'const finalTenantId = tenantId || "e4318f83-ce13-4996-98e0-de53d8e5a04f"; // استخدام حساب المطور كاحتياطي للتجربة'

    if target in content:
        content = content.replace(target, replacement)
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(content)
        print("✅ تم تعديل كود Webhook لاستخدام tenant_id الصحيح!")
    else:
        print("⚠️ لم يتم العثور على السطر المطلوب. ربما تم تعديله مسبقاً.")
except Exception as e:
    print(f"❌ حدث خطأ: {e}")
