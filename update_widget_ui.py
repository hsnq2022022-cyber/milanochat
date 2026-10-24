import re

file_path = "server/public/widget.js"
logo_url = "https://nmhefwvhoholcjrbbila.supabase.co/storage/v1/object/sign/widget-avatars/photo_2026-10-24_22-19-00.jpg?token=eyJraWQiOiIzMDcyNTQ5Ny04NDk0LTQ5NzMtYTNjZS1jMzViMWIzNzM2Y2MiLCJhbGciOiJIUzUxMiJ9.eyJ1cmwiOiJ3aWRnZXQtYXZhdGFycy9waG90b18yMDI2LTEwLTI0XzIyLTE5LTAwLmpwZyIsInNjb3BlIjoiZG93bmxvYWQiLCJpYXQiOjE3OTI4Njk1ODIsImV4cCI6MjEwODIyOTU4Mn0.nCZRh2ZOOLgdqAQnHHN1G4PilFYRyqU00xsMOt7n8ndbs3oCE00GBMdGl6q2d49Hici6tAM8HVzmzbfsAzg2fg"

try:
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    # 1. تحديث دالة getStyles لدعم الوضع الليلي والنهاري
    new_styles = '''function getStyles() {
    if (!config) return '';
    const position = config.position === 'right' ? 'right: 20px;' : 'left: 20px;';
    const primaryColor = config.primaryColor || '#2ec27e';
    const radius = config.borderRadius || 16;
    
    // تحديد الوضع (ليلي أو نهاري)
    const isDark = config.theme === 'dark';
    const bgColor = isDark ? '#1e1e1e' : '#f8f9fa';
    const headerColor = isDark ? '#2a2a2a' : (config.headerBackgroundColor || primaryColor);
    const textColor = isDark ? '#e5e5e5' : '#333';
    const inputBg = isDark ? '#2a2a2a' : '#ffffff';
    const inputBorder = isDark ? '#444' : '#e5e7eb';
    const msgInBg = isDark ? '#333' : '#ffffff';

    return `
      #milano-widget-container * {
        box-sizing: border-box;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      }
      .milano-widget-btn {
        position: fixed;
        bottom: ${config.launcherOffsetY || 20}px;
        ${position}
        width: ${config.launcherSize || 60}px;
        height: ${config.launcherSize || 60}px;
        border-radius: ${config.launcherShape === 'square' ? '12px' : config.launcherShape === 'capsule' ? '30px' : '50%'};
        background: ${primaryColor};
        border: none;
        cursor: pointer;
        box-shadow: 0 4px 20px rgba(0,0,0,0.15);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 999999;
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      }
      .milano-widget-btn:hover { transform: scale(1.08); box-shadow: 0 6px 24px rgba(0,0,0,0.2); }
      .milano-widget-btn svg { width: ${(config.launcherSize || 60) * 0.45}px; height: ${(config.launcherSize || 60) * 0.45}px; fill: white; }

      .milano-widget-window {
        position: fixed;
        bottom: ${(config.launcherOffsetY || 20) + (config.launcherSize || 60) + 10}px;
        ${position}
        width: ${config.windowWidth || 380}px;
        max-width: calc(100vw - 40px);
        height: ${config.windowHeight || 560}px;
        max-height: calc(100vh - 120px);
        background: ${bgColor};
        border-radius: ${radius}px;
        box-shadow: 0 12px 48px rgba(0,0,0,0.15);
        display: ${isOpen ? 'flex' : 'none'};
        flex-direction: column;
        z-index: 999999;
        overflow: hidden;
        border: 1px solid ${isDark ? '#333' : 'rgba(0,0,0,0.05)'};
        animation: milano-fade-in 0.3s ease;
      }
      @keyframes milano-fade-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

      .milano-widget-header {
        background: ${headerColor};
        color: ${isDark ? '#fff' : 'white'};
        padding: 16px;
        display: flex;
        align-items: center;
        gap: 12px;
        flex-shrink: 0;
      }
      .milano-widget-close {
        margin-${config.rtl ? 'right' : 'left'}: auto;
        background: rgba(255,255,255,0.2);
        border: none;
        color: ${isDark ? '#fff' : 'white'};
        width: 32px;
        height: 32px;
        border-radius: 50%;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 18px;
      }
      .milano-widget-avatar { width: 40px; height: 40px; border-radius: 50%; background: rgba(255,255,255,0.2); display: flex; align-items: center; justify-content: center; overflow: hidden; }
      .milano-widget-avatar img { width: 100%; height: 100%; object-fit: cover; }
      .milano-widget-title { flex: 1; }
      .milano-widget-title h3 { margin: 0; font-size: 16px; font-weight: 600; }
      .milano-widget-title p { margin: 2px 0 0; font-size: 12px; opacity: 0.9; }
      .milano-widget-status { display: flex; align-items: center; gap: 4px; font-size: 11px; opacity: 0.9; margin-top: 4px; }
      .milano-widget-status-dot { width: 8px; height: 8px; border-radius: 50%; background: #4ade80; animation: milano-pulse 2s infinite; }
      @keyframes milano-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }

      .milano-widget-messages { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 12px; }
      .milano-widget-message { display: flex; gap: 8px; max-width: 85%; }
      .milano-widget-message.out { align-self: ${config.rtl ? 'flex-start' : 'flex-end'}; flex-direction: ${config.rtl ? 'row' : 'row-reverse'}; }
      .milano-widget-message.in { align-self: ${config.rtl ? 'flex-end' : 'flex-start'}; flex-direction: ${config.rtl ? 'row-reverse' : 'row'}; }
      
      .milano-widget-message-avatar { width: 28px; height: 28px; border-radius: 50%; background: ${primaryColor}; color: white; display: flex; align-items: center; justify-content: center; font-size: 12px; flex-shrink: 0; overflow: hidden; }
      .milano-widget-message-avatar img { width: 100%; height: 100%; object-fit: cover; }
      
      .milano-widget-message-bubble { padding: 12px 16px; border-radius: 18px; font-size: 14px; line-height: 1.5; word-wrap: break-word; box-shadow: 0 1px 2px rgba(0,0,0,0.05); }
      .milano-widget-message.out .milano-widget-message-bubble { background: ${primaryColor}; color: white; border-bottom-${config.rtl ? 'left' : 'right'}-radius: 4px; }
      .milano-widget-message.in .milano-widget-message-bubble { background: ${msgInBg}; color: ${textColor}; border: 1px solid ${isDark ? '#444' : '#e5e7eb'}; border-bottom-${config.rtl ? 'right' : 'left'}-radius: 4px; }
      
      .milano-widget-message-time { font-size: 10px; color: #9ca3af; margin-top: 4px; ${config.rtl ? 'text-align: left;' : 'text-align: right;'} }

      .milano-widget-input-area { padding: 12px 16px; background: ${inputBg}; border-top: 1px solid ${inputBorder}; display: flex; gap: 8px; align-items: center; }
      .milano-widget-input { flex: 1; padding: 10px 16px; border: 1px solid ${inputBorder}; border-radius: 24px; font-size: 14px; outline: none; resize: none; max-height: 100px; min-height: 40px; font-family: inherit; background: ${isDark ? '#333' : '#f9fafb'}; color: ${textColor}; transition: border 0.2s; }
      .milano-widget-input:focus { border-color: ${primaryColor}; }
      .milano-widget-send { width: 40px; height: 40px; border-radius: 50%; background: ${primaryColor}; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
      .milano-widget-send svg { width: 18px; height: 18px; fill: white; transform: ${config.rtl ? 'rotate(180deg)' : 'none'}; }

      /* العبارة الثابتة */
      .milano-widget-branding { text-align: center; padding: 8px; font-size: 11px; color: #888; background: ${inputBg}; border-top: 1px solid ${inputBorder}; direction: rtl; }
      .milano-widget-branding a { color: ${primaryColor}; text-decoration: none; font-weight: bold; }

      @media (max-width: 480px) {
        .milano-widget-window { width: calc(100vw - 20px); height: calc(100vh - 100px); bottom: 80px; ${config.position === 'right' ? 'right: 10px;' : 'left: 10px;'} border-radius: 12px; }
      }
    `;
  }'''

    content = re.sub(r'function getStyles\(\) \{[\s\S]*?\n  \}', new_styles, content, count=1)

    # 2. تحديث دالة render لإضافة زر الإغلاق، والعبارة الثابتة، والشعار
    render_old = '''<div class="milano-widget-title">
            <h3>${escapeHtml(config.agentName || config.name || '')}</h3>
            <p>${escapeHtml(config.agentTagline || config.businessName || '')}</p>
            ${config.showStatus !== false ? '<div class="milano-widget-status"><span class="milano-widget-status-dot"></span> متصل الآن</div>' : ''}
          </div>
        </div>

        <div class="milano-widget-messages" id="milano-messages"></div>
        ${config.suggestedQuestions && config.suggestedQuestions.length > 0 ? `
          <div class="milano-widget-suggestions" id="milano-suggestions">
            ${config.suggestedQuestions.map((q) => `<button class="milano-widget-suggestion" data-suggestion="${escapeHtml(q)}">${escapeHtml(q)}</button>`).join('')}
          </div>
        ` : ''}

        <div class="milano-widget-input-area">
          <textarea
            class="milano-widget-input"
            placeholder="${escapeHtml(config.placeholder || 'اكتب رسالتك...')}"
            id="milano-input"
            rows="1"
          ></textarea>
          <button class="milano-widget-send" id="milano-send-btn" aria-label="إرسال">
            <svg viewBox="0 0 24 24">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
            </svg>
          </button>
        </div>
      </div>'''

    render_new = f'''<div class="milano-widget-title">
            <h3>${{escapeHtml(config.agentName || config.name || '')}}</h3>
            <p>${{escapeHtml(config.agentTagline || config.businessName || '')}}</p>
            ${{config.showStatus !== false ? '<div class="milano-widget-status"><span class="milano-widget-status-dot"></span> متصل الآن</div>' : ''}}
          </div>
          <button class="milano-widget-close" id="milano-close-btn">✕</button>
        </div>

        <div class="milano-widget-messages" id="milano-messages"></div>
        
        ${{config.suggestedQuestions && config.suggestedQuestions.length > 0 ? `
          <div class="milano-widget-suggestions" id="milano-suggestions">
            ${{config.suggestedQuestions.map((q) => `<button class="milano-widget-suggestion" data-suggestion="${{escapeHtml(q)}}">${{escapeHtml(q)}}</button>`).join('')}}
          </div>
        ` : ''}}

        <div class="milano-widget-input-area">
          <textarea
            class="milano-widget-input"
            placeholder="${{escapeHtml(config.placeholder || 'اكتب رسالتك...')}}"
            id="milano-input"
            rows="1"
          ></textarea>
          <button class="milano-widget-send" id="milano-send-btn" aria-label="إرسال">
            <svg viewBox="0 0 24 24">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
            </svg>
          </button>
        </div>
        <div class="milano-widget-branding">
          مدعوم من <a href="https://salla.sa" target="_blank">إدارة سوشيال</a>
        </div>
      </div>'''

    content = content.replace(render_old, render_new)

    # 3. وضع الشعار في الـ Avatar
    avatar_old = '''${config.avatarUrl ? `<img src="${config.avatarUrl}" alt="">` : '💬'}'''
    avatar_new = f'''<img src="{logo_url}" alt="Logo">'''
    content = content.replace(avatar_old, avatar_new)

    # 4. ربط زر الإغلاق
    event_target = '''    const toggleBtn = document.getElementById('milano-toggle-btn');'''
    event_replacement = '''    const closeBtn = document.getElementById('milano-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        isOpen = false;
        container.querySelector('.milano-widget-window').style.display = 'none';
      });
    }

    const toggleBtn = document.getElementById('milano-toggle-btn');'''
    
    if 'const closeBtn = document.getElementById' not in content:
        content = content.replace(event_target, event_replacement)

    # 5. تغيير أيقونة الزر العائم إلى أيقونة دعم فني (Headset) افتراضياً
    icon_old = '''<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12c0 1.54.36 3 1 4.29L2 22l5.71-1C9 21.64 10.46 22 12 22c5.52 0 10-4.48 10-10S17.52 2 12 2zm0 18c-1.38 0-2.67-.33-3.82-.91l-.27-.15-3.18.56.56-3.18-.15-.27C4.33 14.67 4 13.38 4 12c0-4.41 3.59-8 8-8s8 3.59 8 8-3.59 8-8 8z"/></svg>'''
    icon_new = '''<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12v3c0 1.66 1.34 3 3 3h3c1.66 0 3-1.34 3-3v-4c0-1.66-1.34-3-3-3H5.05C6.25 4.85 8.93 3 12 3s5.75 1.85 6.95 5H16c-1.66 0-3 1.34-3 3v4c0 1.66 1.34 3 3 3h3c1.66 0 3-1.34 3-3v-3c0-5.52-4.48-10-10-10zm-3 14H5c-.55 0-1-.45-1-1v-3h4c.55 0 1 .45 1 1v3zm10 0h-4v-3c0-.55.45-1 1-1h4v3c0 .55-.45 1-1 1z"/></svg>'''
    content = content.replace(icon_old, icon_new)

    with open(file_path, "w", encoding="utf-8") as f:
        f.write(content)
    print("✅ تم تحديث تصميم الـ Widget بالكامل (الشعار، الوضع الليلي، العبارة الثابتة) بنجاح!")
except Exception as e:
    print(f"❌ حدث خطأ: {e}")
