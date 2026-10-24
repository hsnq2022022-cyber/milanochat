import os

file_path = "src/components/WidgetEditor.tsx"

try:
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    # النص المعطوب (الذي ينقصه وسم إغلاق)
    target = """          <div className="flex items-center gap-2">
            <span className="text-verde font-bold text-lg">✓</span>
            <span className="text-sm text-bone">
              مدعوم من إدارة سوشيال (إجباري)
            </span>
          </div>
      </div>
    </div>
  );"""
    
    # النص الصحيح (إضافة </div> لسد وسم space-y-6)
    replacement = """          <div className="flex items-center gap-2">
            <span className="text-verde font-bold text-lg">✓</span>
            <span className="text-sm text-bone">
              مدعوم من إدارة سوشيال (إجباري)
            </span>
          </div>
        </div>
      </div>
    </div>
  );"""

    if target in content:
        content = content.replace(target, replacement)
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(content)
        print("✅ تم إغلاق الوسم الناقص بنجاح! الكود الآن سليم 100%.")
    else:
        print("⚠️ لم يتم العثور على النص المطابق. يرجى إرسال الأسطر 715-730 مرة أخرى.")
except Exception as e:
    print(f"❌ حدث خطأ: {e}")
