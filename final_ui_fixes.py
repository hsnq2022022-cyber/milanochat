import os

# 1. جعل العبارة إجبارية وتغيير النص في المحرر (WidgetEditor.tsx)
p1 = "src/components/WidgetEditor.tsx"
if os.path.exists(p1):
    with open(p1, "r", encoding="utf-8") as f: c1 = f.read()
    c1 = c1.replace('إظهار "مدعوم بواسطة إدارة ســوشـــيــــال"', 'مدعوم من إدارة سوشيال (إجباري)')
    with open(p1, "w", encoding="utf-8") as f: f.write(c1)
    print("✅ تم تعديل WidgetEditor.tsx")

# 2. تغيير النص في المعاينة (WidgetPreview.tsx)
p2 = "src/components/WidgetPreview.tsx"
if os.path.exists(p2):
    with open(p2, "r", encoding="utf-8") as f: c2 = f.read()
    c2 = c2.replace('مدعوم بواسطة{" "}', 'مدعوم من إدارة سوشيال{" "}')
    with open(p2, "w", encoding="utf-8") as f: f.write(c2)
    print("✅ تم تعديل WidgetPreview.tsx")

# 3. إضافة زر العودة في لوحة التحكم (Widgets.tsx)
p3 = "src/pages/Widgets.tsx"
if os.path.exists(p3):
    with open(p3, "r", encoding="utf-8") as f: c3 = f.read()
    if 'window.location.hash = "#/"' not in c3:
        btn_code = '''
  useEffect(() => {
    const btn = document.createElement('button');
    btn.innerText = '← العودة للرئيسية';
    btn.style.cssText = 'position:fixed; top:20px; right:20px; z-index:99999; padding:10px 20px; background:#2ec27e; color:white; border:none; border-radius:8px; cursor:pointer; font-weight:bold; box-shadow: 0 4px 6px rgba(0,0,0,0.1); font-family: inherit;';
    btn.onclick = () => window.location.hash = '#/';
    document.body.appendChild(btn);
    return () => { document.body.removeChild(btn); };
  }, []);

'''
        idx = c3.find('return (')
        if idx != -1:
            c3 = c3[:idx] + btn_code + c3[idx:]
            with open(p3, "w", encoding="utf-8") as f: f.write(c3)
            print("✅ تم إضافة زر العودة في Widgets.tsx")

# 4. إضافة الشعار إلى الـ Widget (server/public/widget.js)
p4 = "server/public/widget.js"
if os.path.exists(p4):
    with open(p4, "r", encoding="utf-8") as f: c4 = f.read()
    logo_url = "https://nmhefwvhoholcjrbbila.supabase.co/storage/v1/object/sign/widget-avatars/photo_2026-10-24_22-19-00.jpg?token=eyJraWQiOiIzMDcyNTQ5Ny04NDk0LTQ5NzMtYTNjZS1jMzViMWIzNzM2Y2MiLCJhbGciOiJIUzUxMiJ9.eyJ1cmwiOiJ3aWRnZXQtYXZhdGFycy9waG90b18yMDI2LTEwLTI0XzIyLTE5LTAwLmpwZyIsInNjb3BlIjoiZG93bmxvYWQiLCJpYXQiOjE3OTI4Njk1ODIsImV4cCI6MjEwODIyOTU4Mn0.nCZRh2ZOOLgdqAQnHHN1G4PilFYRyqU00xsMOt7n8ndbs3oCE00GBMdGl6q2d49Hici6tAM8HVzmzbfsAzg2fg"
    
    old_avatar1 = """const avatarContent = config.avatarUrl
      ? `<img src="${config.avatarUrl}" alt="">`
      : (config.agentName ? config.agentName.charAt(0) : '🤖');"""
    
    old_avatar2 = """${config.avatarUrl ? `<img src="${config.avatarUrl}" alt="">` : '💬'}"""

    new_avatar = f"""`<img src="${{config.avatarUrl || '{logo_url}'}}" alt="Logo">`"""
    
    if old_avatar1 in c4:
        c4 = c4.replace(old_avatar1, f"const avatarContent = {new_avatar};")
    if old_avatar2 in c4:
        c4 = c4.replace(old_avatar2, new_avatar)
        
    with open(p4, "w", encoding="utf-8") as f: f.write(c4)
    print("✅ تم إضافة الشعار إلى widget.js")
