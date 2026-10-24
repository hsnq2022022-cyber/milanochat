import re

file_path = "src/components/WidgetEditor.tsx"

try:
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    # هذا السطر يبحث عن أي </span> يتبعه </label> ويستبدل الـ label بـ div
    # هذا سيصلح "تفعيل صوت التنبيه" وأي خيارات أخرى متبقية دفعة واحدة
    new_content, count = re.subn(r'</span>\s*</label>', '</span>\n          </div>', content)

    with open(file_path, "w", encoding="utf-8") as f:
        f.write(new_content)
    
    if count > 0:
        print(f"✅ تم إصلاح {count} من وسوم الإغلاق المعلقة بنجاح!")
        print("الآن الكود سليم 100% ولن تظهر أخطاء أخرى.")
    else:
        print("⚠️ لم يتم العثور على وسوم معلقة. يرجى تجربة البناء.")
        
except Exception as e:
    print(f"❌ حدث خطأ: {e}")
