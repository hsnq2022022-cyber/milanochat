import os
import shutil

file_path = "src/components/WidgetEditor.tsx"
backup_path = "src/components/WidgetEditor.tsx.bak"

if not os.path.exists(file_path):
    print("❌ الملف غير موجود.")
    exit(1)

# 1. إنشاء نسخة احتياطية
shutil.copy2(file_path, backup_path)
print(f"✅ تم إنشاء نسخة احتياطية: {backup_path}")

with open(file_path, "r", encoding="utf-8") as f:
    lines = f.readlines()

# 2. تحديد مكان الإضافة بدقة متناهية
in_appearance = False
insert_index = -1

for i, line in enumerate(lines):
    if "function AppearanceTab" in line:
        in_appearance = True
    
    # نبحث عن بداية الدالة التالية لنعرف أين تنتهي الحالية
    if in_appearance and "function ChatTab" in line:
        # نعود للخلف للبحث عن نقطة إغلاق return
        for j in range(i-1, -1, -1):
            if lines[j].strip() == ");":
                # وجدنا نهاية الـ return. الآن نبحث عن آخر </div> يغلق الـ space-y-6
                for k in range(j-1, -1, -1):
                    if "</div>" in lines[k]:
                        insert_index = k
                        break
                break
        break

if insert_index != -1:
    ui_code = """        {/* قسم المظهر والألوان */}
        <div className="border-t border-verde/15 pt-6 mt-6">
          <h3 className="text-sm font-bold text-bone mb-4">المظهر والألوان</h3>
          
          <div className="mb-4">
            <label className="text-xs text-sage mb-2 block">الوضع (Theme)</label>
            <select
              value={settings.theme || "auto"}
              onChange={(e) => updateSettings("theme", e.target.value)}
              className="input-field"
            >
              <option value="auto">تلقائي (يتماشى مع المتجر)</option>
              <option value="light">فاتح دائماً</option>
              <option value="dark">داكن دائماً</option>
            </select>
          </div>

          <div className="mb-4">
            <label className="text-xs text-sage mb-2 block">لون رأس المحادثة</label>
            <div className="flex gap-3 items-center">
              <input
                type="color"
                value={settings.headerBackgroundColor || "#2ec27e"}
                onChange={(e) => updateSettings("headerBackgroundColor", e.target.value)}
                className="w-10 h-10 rounded cursor-pointer bg-transparent border-none"
              />
              <span className="text-xs text-bone font-mono">{settings.headerBackgroundColor || "#2ec27e"}</span>
            </div>
          </div>

          <div className="mb-4">
            <label className="text-xs text-sage mb-2 block">لون الخلفية الداخلي</label>
            <div className="flex gap-3 items-center">
              <input
                type="color"
                value={settings.backgroundColor || "#f8f9fa"}
                onChange={(e) => updateSettings("backgroundColor", e.target.value)}
                className="w-10 h-10 rounded cursor-pointer bg-transparent border-none"
              />
              <span className="text-xs text-bone font-mono">{settings.backgroundColor || "#f8f9fa"}</span>
            </div>
          </div>
        </div>
"""
    # إضافة الكود في السطر المحدد بدقة
    lines.insert(insert_index, ui_code)
    
    with open(file_path, "w", encoding="utf-8") as f:
        f.writelines(lines)
    print("✅ تمت إضافة حقول المظهر والألوان بنجاح (بدون المساس بأي كود آخر)!")
else:
    print("❌ لم يتم العثور على نقطة الحقن. تم إيقاف التنفيذ لحماية الملف.")
