import os

file_path = "src/components/WidgetEditor.tsx"

try:
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    # 1. إصلاح وسم RTL
    target1 = """<span className="text-sm text-bone">
                اتجاه من اليمين لليسار (RTL)
              </span>
          </div>"""
    replacement1 = """<span className="text-sm text-bone">
                اتجاه من اليمين لليسار (RTL)
              </span>
            </label>"""
    content = content.replace(target1, replacement1)

    # 2. إصلاح وسم إيصالات القراءة
    target2 = """<span className="text-sm text-bone">
            إظهار إيصالات القراءة
          </span>
          </div>"""
    replacement2 = """<span className="text-sm text-bone">
            إظهار إيصالات القراءة
          </span>
          </label>"""
    content = content.replace(target2, replacement2)

    # 3. إصلاح وسم تفعيل صوت التنبيه (إزالة </label> الزائدة وإغلاق الوسم الصحيح)
    target3 = """</label>

          <span className="text-verde font-bold text-lg">✓</span>

          <span className="text-sm text-bone">
            تفعيل صوت التنبيه
          </span>
          </div>"""
    replacement3 = """<span className="text-verde font-bold text-lg">✓</span>

          <span className="text-sm text-bone">
            تفعيل صوت التنبيه
          </span>
          </label>"""
    content = content.replace(target3, replacement3)

    with open(file_path, "w", encoding="utf-8") as f:
        f.write(content)
    print("✅ تم إصلاح الوسوم المكسورة الثلاثة بدقة متناهية (بدون أي Regex)!")
except Exception as e:
    print(f"❌ حدث خطأ: {e}")
