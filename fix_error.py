import re

file_path = "supabase/functions/milan-api/index.ts"

try:
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    # استبدال علامات التنصيص بعلامات backticks في سطر fullText
    pattern = r'let fullText = "قائمة منتجات المتجر الحالية:[\s\S]*?";'
    replacement = 'let fullText = `قائمة منتجات المتجر الحالية:\\n`;'
    content = re.sub(pattern, replacement, content)

    with open(file_path, "w", encoding="utf-8") as f:
        f.write(content)
    print("✅ تم إصلاح الخطأ البرمجي بنجاح!")
except Exception as e:
    print(f"❌ حدث خطأ: {e}")
