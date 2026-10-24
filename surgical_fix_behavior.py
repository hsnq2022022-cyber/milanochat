import os

file_path = "src/components/WidgetEditor.tsx"

try:
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    # الكتلة المعطوبة كما ظهرت في التيرمنال
    broken_block = """                  <label className="text-xs text-sage mb-2 block">
                    التأخير (ثواني)
                  <span className="text-verde font-bold text-lg">✓</span>

                  <span className="text-sm text-bone">
                    تفعيل صوت التنبيه
                  </span>
                  </label>
              </div>

              <div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <span className="text-verde font-bold text-lg">✓</span>

                  <span className="text-sm text-bone">
                    إخفاء على الجوال
                  </span>
                  </div>
              </div>"""

    # الكتلة السليمة (إرجاع حقل الإدخال، وإصلاح الوسوم)
    fixed_block = """                  <label className="text-xs text-sage mb-2 block">
                    التأخير (ثواني)
                  </label>
                  <input
                    type="number"
                    value={settings.behavior.autoOpen.delay || 5}
                    onChange={(e) => updateSettings("behavior.autoOpen.delay", Number(e.target.value))}
                    className="input-field"
                  />
                </div>
              )}

              <div className="flex items-center gap-2 mt-4">
                <span className="text-verde font-bold text-lg">✓</span>
                <span className="text-sm text-bone">
                  تفعيل صوت التنبيه
                </span>
              </div>

              <div className="flex items-center gap-2 mt-4">
                <span className="text-verde font-bold text-lg">✓</span>
                <span className="text-sm text-bone">
                  إخفاء على الجوال
                </span>
              </div>"""

    if broken_block in content:
        content = content.replace(broken_block, fixed_block)
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(content)
        print("✅ تم إصلاح كتلة (Behavior) بالكامل بدقة متناهية!")
    else:
        print("⚠️ لم يتم العثور على النص المطابق بالضبط. يرجى إرسال الأسطر 830-860.")

except Exception as e:
    print(f"❌ حدث خطأ: {e}")
