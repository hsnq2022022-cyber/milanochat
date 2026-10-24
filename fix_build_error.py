import re

file_path = "src/pages/Widgets.tsx"

try:
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    # إزالة كود الزر المعطوب
    broken_block = '''
        {/* زر العودة المضافة تلقائياً */}
        <button 
          onClick={() => window.history.back()} 
          style={{ position: 'fixed', top: '20px', left: '20px', zIndex: 9999, padding: '8px 16px', background: '#2ec27e', color: 'white', borderRadius: '8px', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 'bold', boxShadow: '0 4px 10px rgba(46,194,126,0.3)' }}
        >
          <span>→</span> العودة للرئيسية
        </button>
'''
    if broken_block in content:
        content = content.replace(broken_block, "")
    
    # إزالة أي أثر لعلامات <>
    content = content.replace("return (<>\n", "return (\n")
    content = content.replace("</>\n);", ");")

    # إزالة كود الـ useEffect الذي أضفناه (لتفادي أي تعارض)
    broken_use_effect = '''  useEffect(() => {
    const btn = document.createElement('button');
    btn.innerText = '← العودة للرئيسية';
    btn.style.cssText = 'position:fixed; top:20px; right:20px; z-index:99999; padding:10px 20px; background:#2ec27e; color:white; border:none; border-radius:8px; cursor:pointer; font-weight:bold; box-shadow: 0 4px 6px rgba(0,0,0,0.1); font-family: inherit;';
    btn.onclick = () => window.location.hash = '#/';
    document.body.appendChild(btn);
    return () => { document.body.removeChild(btn); };
  }, []);

'''
    if broken_use_effect in content:
        content = content.replace(broken_use_effect, "")

    with open(file_path, "w", encoding="utf-8") as f:
        f.write(content)
    print("✅ تم إصلاح ملف Widgets.tsx وإزالة الكود المعطوب بنجاح!")
except Exception as e:
    print(f"❌ حدث خطأ: {e}")
