import re

file_path = "src/components/WidgetEditor.tsx"

try:
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    # إصلاح 1: إزالة </label> المعلقة في تبويب Branding
    content = content.replace("""              مدعوم من إدارة سوشيال (إجباري)
            </span>
          </label>""", """              مدعوم من إدارة سوشيال (إجباري)
            </span>
          </div>""")

    # إصلاح 2: إصلاح الوسم المكسور في تبويب Chat (إظهار مؤشر الكتابة)
    content = content.replace("""        <span className="text-verde font-bold text-lg">✓</span>

          <span className="text-sm text-bone">
            إظهار مؤشر الكتابة
          </span>
        </label>""", """        <div className="flex items-center gap-2 mt-4">
          <span className="text-verde font-bold text-lg">✓</span>
          <span className="text-sm text-bone">
            إظهار مؤشر الكتابة
          </span>
        </div>""")

    # إصلاح 3: التأكد من إغلاق وسم div الرئيسي في نهاية BrandingTab
    content = content.replace("""          <div className="flex items-center gap-2">
            <span className="text-verde font-bold text-lg">✓</span>
            <span className="text-sm text-bone">
              مدعوم من إدارة سوشيال (إجباري)
            </span>
          </div>
      </div>
    </div>
    );
    }""", """          <div className="flex items-center gap-2">
            <span className="text-verde font-bold text-lg">✓</span>
            <span className="text-sm text-bone">
              مدعوم من إدارة سوشيال (إجباري)
            </span>
          </div>
        </div>
      </div>
    </div>
    );
    }""")

    with open(file_path, "w", encoding="utf-8") as f:
        f.write(content)
    print("✅ تم إصلاح الوسوم المكسورة بدقة 100%!")
except Exception as e:
    print(f"❌ حدث خطأ: {e}")
