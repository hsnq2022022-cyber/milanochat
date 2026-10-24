import re

file_path = "src/components/WidgetEditor.tsx"

try:
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    # استبدال مربع الاختيار بعلامة صح ثابتة
    # نبحث عن الـ input الذي له نفس الـ class ونستبدله
    pattern = r'<input[\s\S]*?type="checkbox"[\s\S]*?className="w-4 h-4 accent-verde"\s*/>'
    
    # علامة صح ثابتة بلون أخضر
    replacement = '<span className="text-verde font-bold text-lg">✓</span>'
    
    new_content = re.sub(pattern, replacement, content)

    if new_content != content:
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(new_content)
        print("✅ تم إزالة مربع الاختيار وجعل العبارة إجبارية 100%!")
    else:
        print("⚠️ لم يتم العثور على مربع الاختيار، ربما تم تعديله مسبقاً.")
except Exception as e:
    print(f"❌ حدث خطأ: {e}")
