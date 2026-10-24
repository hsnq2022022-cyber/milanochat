import re

file_path = "supabase/functions/milan-api/index.ts"

try:
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    if 'case "widget.js"' in content:
        print("⚠️ المعالج widget.js موجود بالفعل، لن يتم التعديل.")
    else:
        injection = '''
      /* ────────────────────────────────────────────────────────────────
         تقديم ملف الـ Widget كـ JavaScript
      ──────────────────────────────────────────────────────────────── */
      case "widget.js": {
        try {
          const ghUrl = "https://raw.githubusercontent.com/hsnq2022022-cyber/milanochat/main/server/public/widget.js";
          const ghResponse = await fetch(ghUrl);
          if (!ghResponse.ok) {
            return err("Failed to load widget script from GitHub", 500);
          }
          const jsContent = await ghResponse.text();
          return new Response(jsContent, {
            status: 200,
            headers: {
              ...CORS,
              "content-type": "application/javascript; charset=utf-8",
              "Cache-Control": "public, max-age=3600",
            },
          });
        } catch (error) {
          console.error("[widget.js] Error fetching script:", error);
          return err("Internal server error", 500);
        }
      }

'''
        pattern = r'switch\s*\(\s*action\s*\)\s*\{'
        new_content = re.sub(pattern, lambda m: m.group(0) + "\n" + injection, content, count=1)

        if new_content != content:
            with open(file_path + ".bak", "w", encoding="utf-8") as f:
                f.write(content)

            with open(file_path, "w", encoding="utf-8") as f:
                f.write(new_content)
            print("✅ تم إضافة معالج widget.js بنجاح إلى milan-api!")
            print("💾 تم إنشاء نسخة احتياطية باسم index.ts.bak")
        else:
            print("❌ لم يتم العثور على جملة switch (action). لم يتم التعديل.")
except Exception as e:
    print(f"❌ حدث خطأ: {e}")
