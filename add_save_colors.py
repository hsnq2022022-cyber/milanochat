import os
import shutil

file_path = "supabase/functions/milan-api/index.ts"

if not os.path.exists(file_path):
    print(f"❌ الملف غير موجود.")
    exit(1)

with open(file_path, "r", encoding="utf-8") as f:
    content = f.read()

# النص المتوقع بدقة (نهاية معالجة الإعدادات)
target_text = """          if (
            settings.avatarUrl !==
            undefined
          ) {
            patch.avatar_url =
              settings.avatarUrl ??
              null;
          }
        }"""

# النص الجديد (إضافة حفظ الألوان والوضع)
replacement_text = """          if (
            settings.avatarUrl !==
            undefined
          ) {
            patch.avatar_url =
              settings.avatarUrl ??
              null;
          }

          if (
            settings.theme !==
            undefined
          ) {
            patch.theme =
              String(
                settings.theme
              ).slice(
                0,
                20
              );
          }

          if (
            settings.backgroundColor !==
            undefined
          ) {
            patch.background_color =
              settings.backgroundColor ??
              null;
          }

          if (
            settings.headerBackgroundColor !==
            undefined
          ) {
            patch.header_background_color =
              settings.headerBackgroundColor ??
              null;
          }
        }"""

# التحقق من وجود النص مرة واحدة فقط
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
print("✅ تم إضافة حفظ الألوان والوضع الليلي في الباك-إند بنجاح!")
