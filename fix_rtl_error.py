import re

file_path = "src/components/WidgetEditor.tsx"

try:
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    # الكود المعطوب الذي ظهر في التيرمنال
    broken_code = """          <div className="flex items-center gap-4">
            <span className="text-verde font-bold text-lg">✓</span>

          <span className="text-sm text-bone">
            اتجاه من اليمين لليسار (RTL)
          </span>
        </label>
      </div>
    </div>
  );
}"""

    # الكود الصحيح (إعادة زر التحديد الخاص بـ RTL)
    fixed_code = """          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={settings?.rtl || false}
                onChange={(e) => updateSettings("rtl", e.target.checked)}
                className="w-4 h-4 accent-verde"
              />
              <span className="text-sm text-bone">
                اتجاه من اليمين لليسار (RTL)
              </span>
            </label>
          </div>
        </div>
      </div>
    );
}"""

    if broken_code in content:
        content = content.replace(broken_code, fixed_code)
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(content)
        print("✅ تم إصلاح الخطأ البرمجي وإرجاع خيار RTL بنجاح!")
    else:
        print("⚠️ لم يتم العثور على الكود المعطوب بالنص الدقيق. جاري محاولة إصلاح بديلة...")
        # محاولة إصلاح بديلة في حال اختلاف المسافات البادئة
        content = re.sub(
            r'<div className="flex items-center gap-4">\s*<span className="text-verde font-bold text-lg">✓</span>\s*<span className="text-sm text-bone">\s*اتجاه من اليمين لليسار \(RTL\)\s*</span>\s*</label>\s*</div>\s*</div>\s*\);\s*\}',
            fixed_code,
            content
        )
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(content)
        print("✅ تمت محاولة الإصلاح البديلة.")

except Exception as e:
    print(f"❌ حدث خطأ: {e}")
