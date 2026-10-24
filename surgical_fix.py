import os

file_path = "src/components/WidgetEditor.tsx"

try:
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    # 1. إصلاح الكود المعطوب في تبويب (Branding)
    # استبدال وسم label المعلق بـ div متوافق
    broken_branding = """          <span className="text-verde font-bold text-lg">✓</span>

          <span className="text-sm text-bone">
            مدعوم من إدارة سوشيال (إجباري)
          </span>
        </label>"""
        
    fixed_branding = """          <div className="flex items-center gap-2">
            <span className="text-verde font-bold text-lg">✓</span>
            <span className="text-sm text-bone">
              مدعوم من إدارة سوشيال (إجباري)
            </span>
          </div>"""

    if broken_branding in content:
        content = content.replace(broken_branding, fixed_branding)
        print("✅ تم إصلاح تنسيق خيار (مدعوم من إدارة سوشيال)")

    # 2. إصلاح الكود المعطوب في تبويب (Chat)
    broken_chat = """        <span className="text-verde font-bold text-lg">✓</span>

          <span className="text-sm text-bone">
            إظهار مؤشر الكتابة
          </span>
        </label>"""
        
    fixed_chat = """        <div className="flex items-center gap-2 mt-4">
          <span className="text-verde font-bold text-lg">✓</span>
          <span className="text-sm text-bone">
            إظهار مؤشر الكتابة
          </span>
        </div>"""

    if broken_chat in content:
        content = content.replace(broken_chat, fixed_chat)
        print("✅ تم إصلاح تنسيق خيار (إظهار مؤشر الكتابة)")

    # حفظ الملف
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(content)
    print("✅ تم حفظ الملف بنجاح!")
    
except Exception as e:
    print(f"❌ حدث خطأ: {e}")
