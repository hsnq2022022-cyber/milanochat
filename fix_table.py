import re

file_path = "supabase/functions/milan-api/index.ts"

try:
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    # البحث عن الكود الذي أضفناه سابقاً واستبدال اسم الجدول
    target = '''const { data: sallaAcc } = await sb
          .from("accounts")
          .select("access_token_encrypted")
          .eq("tenant_id", tenant.id)
          .eq("channel", "salla")
          .maybeSingle();'''

    replacement = '''const { data: sallaAcc } = await sb
          .from("channel_accounts")
          .select("access_token_encrypted")
          .eq("tenant_id", tenant.id)
          .eq("channel", "salla")
          .maybeSingle();'''

    if target in content:
        content = content.replace(target, replacement)
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(content)
        print("✅ تم تصحيح اسم الجدول إلى channel_accounts بنجاح!")
    else:
        print("⚠️ لم يتم العثور على الكود المطلوب تعديله. ربما تم تعديله مسبقاً.")
except Exception as e:
    print(f"❌ حدث خطأ: {e}")
