import os
import shutil

file_path = "src/components/WidgetEditor.tsx"

# النص المتوقع بدقة (نهاية دالة AppearanceTab)
target_text = """                  <div className="flex items-center gap-2">
                    <span className="text-verde font-bold text-lg">✓</span>
                    <span className="text-sm text-bone">
                      مدعوم من إدارة سوشيال (إجباري)
                    </span>
                  </div>
                </div>
              </div>
            </div>
          );
        }"""

# النص الجديد (إضافة حقول الألوان والوضع الليلي قبل الإغلاق)
replacement_text = """                  <div className="flex items-center gap-2">
                    <span className="text-verde font-bold text-lg">✓</span>
                    <span className="text-sm text-bone">
                      مدعوم من إدارة سوشيال (إجباري)
                    </span>
                  </div>
                </div>
              </div>

              {/* قسم المظهر والألوان */}
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

            </div>
          );
        }"""

try:
    if not os.path.exists(file_path):
        print(f"❌ خطأ: الملف {file_path} غير موجود.")
        exit(1)

    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    # التحقق من وجود النص المتوقع بالضبط (مرة واحدة فقط)
    occurrences = content.count(target_text)
    
    if occurrences != 1:
        print(f"❌ إيقاف التنفيذ: تم العثور على النص المتوقع {occurrences} مرة. يجب أن يكون مرة واحدة فقط.")
        exit(1)

    # إنشاء نسخة احتياطية
    backup_path = file_path + ".bak"
    shutil.copy2(file_path, backup_path)
    print(f"✅ تم إنشاء نسخة احتياطية: {backup_path}")

    # تنفيذ التعديل
    new_content = content.replace(target_text, replacement_text)

    with open(file_path, "w", encoding="utf-8") as f:
        f.write(new_content)
    print("✅ تم إضافة حقول المظهر والألوان بنجاح!")

except Exception as e:
    print(f"❌ حدث خطأ غير متوقع: {e}")
