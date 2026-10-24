import re

file_path = "src/components/WidgetEditor.tsx"

try:
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    # الكود المعطوب (نهاية الملف)
    target = """              <span className="text-sm text-bone">
                اتجاه من اليمين لليسار (RTL)
              </span>
            </label>
          </div>
        </div>
      </div>
    );
}"""
    
    # الكود الصحيح (إضافة </div> قبل );
    replacement = """              <span className="text-sm text-bone">
                اتجاه من اليمين لليسار (RTL)
              </span>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}"""

    if target in content:
        content = content.replace(target, replacement)
        print("✅ تم إضافة وسم الإغلاق الناقص بنجاح (Exact Match)!")
    else:
        # محاولة إصلاح بديلة في حال اختلفت المسافات
        pattern = r'(</label>\s*</div>\s*</div>\s*</div>\s*);\s*\}'
        content, count = re.subn(pattern, r'\1</div>\n  );\n}', content)
        if count > 0:
            print(f"✅ تم إضافة وسم الإغلاق الناقص بنجاح (Regex Match) - {count} تعديل.")
        else:
            print("⚠️ لم يتم العثور على النمط، جاري إصلاح شامل...")
            # إصلاح شامل لأي return ينتهي بشكل خاطئ
            content = content.replace("      </div>\n    );\n}", "      </div>\n    </div>\n  );\n}")

    with open(file_path, "w", encoding="utf-8") as f:
        f.write(content)

except Exception as e:
    print(f"❌ حدث خطأ: {e}")
