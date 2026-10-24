import os
import re
import shutil

file_path = "src/components/WidgetEditor.tsx"

if not os.path.exists(file_path):
    print("❌ الملف غير موجود.")
    exit(1)

with open(file_path, "r", encoding="utf-8") as f:
    content = f.read()

# التعبير البحثي يلتقط نهاية شريط RTL وإغلاق الـ div الخاص به
# نستخدم Regex هنا للبحث عن الكتلة فقط (وليس للحذف العشوائي)
# نبحث عن شريط RTL ثم الإغلاق الخاص به
pattern = r'(<span className="text-sm text-bone">\s*اتجاه من اليمين لليسار \(RTL\)\s*</span>\s*</label>\s*</div>\s*</div>)'

match = re.search(pattern, content)

if not match:
    print("❌ إيقاف التنفيذ: لم يتم العثور على المكان المحدد بدقة. لم يتم تعديل أي شيء.")
    exit(1)

# الكود الذي سنحقنه (محتوى التبويبات)
tabs_code = """
        {/* محتوى التبويبات */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === "general" && <GeneralTab settings={settings} updateSettings={updateSettings} />}
          {activeTab === "appearance" && <AppearanceTab widget={widget} settings={settings} updateSettings={updateSettings} applyPreset={applyPreset} errors={errors} authToken={authToken} />}
          {activeTab === "chat" && <ChatTab settings={settings} updateSettings={updateSettings} />}
          {activeTab === "behavior" && <BehaviorTab settings={settings} updateSettings={updateSettings} />}
          {activeTab === "forms" && <FormsTab settings={settings} updateSettings={updateSettings} />}
          {activeTab === "embed" && <EmbedTab widget={widget} copyEmbedCode={copyEmbedCode} />}
        </div>
"""

# إدراج الكود بعد الكتلة التي تم العثور عليها
new_content = content[:match.end()] + tabs_code + content[match.end():]

# إنشاء نسخة احتياطية
shutil.copy2(file_path, file_path + ".bak")
print(f"✅ تم إنشاء نسخة احتياطية: {file_path}.bak")

# حفظ الملف
with open(file_path, "w", encoding="utf-8") as f:
    f.write(new_content)

print("✅ تم إعادة كود عرض التبويبات بنجاح! الشاشة لن تكون فارغة بعد الآن.")
