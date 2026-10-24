import re

file_path = "src/pages/Widgets.tsx"

try:
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    if "window.history.back" in content:
        print("⚠️ زر العودة موجود بالفعل في الملف.")
    else:
        back_btn = '''
        {/* زر العودة المضافة تلقائياً */}
        <button 
          onClick={() => window.history.back()} 
          style={{ position: 'fixed', top: '20px', left: '20px', zIndex: 9999, padding: '8px 16px', background: '#2ec27e', color: 'white', borderRadius: '8px', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 'bold', boxShadow: '0 4px 10px rgba(46,194,126,0.3)' }}
        >
          <span>→</span> العودة للرئيسية
        </button>
'''
        # البحث عن أول return ( في الملف
        match = re.search(r'return\s*\(\s*', content)
        if match:
            # إضافة <> لضمان عدم كسر الـ JSX
            content = content[:match.end()] + "<>\n" + back_btn + content[match.end():]
            # إغلاق الـ Fragment في نهاية الملف
            # نبحث عن آخر ); في الملف
            last_paren_idx = content.rfind(');')
            if last_paren_idx != -1:
                content = content[:last_paren_idx] + "</>\n" + content[last_paren_idx:]
            
            with open(file_path, "w", encoding="utf-8") as f:
                f.write(content)
            print("✅ تم إضافة زر العودة للرئيسية بنجاح إلى صفحة Widgets!")
        else:
            print("❌ لم يتم العثور على دالة return في الملف.")
except Exception as e:
    print(f"❌ حدث خطأ: {e}")
