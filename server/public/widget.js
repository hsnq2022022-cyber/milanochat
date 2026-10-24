/**
 * Milano Widget — يُحمّل من الخادم ويُضمّن في أي موقع
 * الاستخدام:
 * <script src="https://YOUR-DOMAIN/widget.js" data-token="WIDGET_TOKEN"></script>
 *
 * ═══════════════════════════════════════════════════════════════
 * إصلاحات النسخة (v2):
 * - Optimistic UI: رسالة العميل تظهر فورًا في الـ DOM قبل الـ API.
 * - لا يتم إعادة رسم الـ container كاملًا — فقط قائمة الرسائل.
 * - الحفاظ على قيمة الحقل والتركيز ومكان المؤشر.
 * - إذا فشل الطلب: تُعرض الرسالة بحالة "فشل" مع زر إعادة المحاولة.
 * - إذا كانت الجلسة غير صالحة: تُعرض رسالة فورية مع خطأ.
 * - scrollToBottom دقيق بعد كل تحديث (double RAF).
 * - ربط الأحداث عبر addEventListener بدل onclick inline.
 * ═══════════════════════════════════════════════════════════════
 */
(function () {
  'use strict';

  /* ═══════ قراءة token من script tag ═══════ */

  const scripts = document.getElementsByTagName('script');
  let token = null;
  let baseUrl = null;

  for (let i = 0; i < scripts.length; i++) {
    const src = scripts[i].src || '';
    if (src.includes('widget.js')) {
      token = scripts[i].getAttribute('data-token');
      const match = src.match(/^(https?:\/\/[^\/]+)/);
      baseUrl = match ? match[1] : window.location.origin;
      break;
    }
  }

  if (!token) {
    console.error('[Milano Widget] Missing data-token');
    return;
  }

  console.log('[Milano Widget] Initializing with baseUrl:', baseUrl, 'token:', token);

  /* ═══════ الحالة ═══════ */

  let config = null;
  let sessionId = null;
  let messages = [];              // { id, direction, body, kind, created_at, status, errorMessage? }
  let isOpen = false;
  let isLoading = false;
  let failedMessages = {};        // { msgId: originalText } — لإعادة المحاولة

  const getVisitorId = () => {
    const stored = localStorage.getItem('milano_visitor_id');
    if (stored) return stored;
    const newId = 'v_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
    localStorage.setItem('milano_visitor_id', newId);
    return newId;
  };

  const visitorId = getVisitorId();

  /* ═══════ أدوات مساعدة ═══════ */

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text == null ? '' : text);
    return div.innerHTML;
  }

  function formatTime(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  }

  function generateMsgId() {
    return 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  }

  function scrollToBottom() {
    const el = document.getElementById('milano-messages');
    if (!el) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    });
  }

  /* ═══════ API ═══════ */

  async function fetchConfig() {
    try {
      const res = await fetch(`${baseUrl}/functions/v1/milan-api?action=widget_public&token=${token}`);
      if (!res.ok) throw new Error('Widget not found');
      config = await res.json();
      return config;
    } catch (err) {
      console.error('[Milano Widget] Config error:', err);
      return null;
    }
  }

  async function createSession() {
    try {
      const res = await fetch(`${baseUrl}/functions/v1/milan-api?action=widget_session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, visitorId, origin: window.location.origin }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        console.error('[Milano Widget] Session error:', errorData);

        if (res.status === 403) {
          throw new Error(errorData.code === 'DOMAIN_NOT_ALLOWED'
            ? 'النطاق غير مسموح به'
            : 'خطأ في التحقق من النطاق');
        }
        throw new Error(errorData.error || 'Session error');
      }

      const data = await res.json();
      sessionId = data.sessionId;

      // تحويل الرسائل إلى الصيغة الداخلية (مع ID وحالة)
      messages = (data.messages || []).map((m) => ({
        id: m.id || generateMsgId(),
        direction: m.direction,
        body: m.body,
        kind: m.kind || 'text',
        created_at: m.created_at || new Date().toISOString(),
        status: 'sent',
      }));

      return data;
    } catch (err) {
      console.error('[Milano Widget] Session error:', err);
      return null;
    }
  }

  /* ═══════ إرسال الرسائل ═══════ */

  async function sendMessage(text) {
    if (!text || !text.trim()) return;
    text = text.trim();

    // ── 1) إضافة رسالة العميل إلى الحالة فورًا (Optimistic UI) ──
    const userMsgId = generateMsgId();
    const userMsg = {
      id: userMsgId,
      direction: 'in',
      body: text,
      kind: 'customer',
      created_at: new Date().toISOString(),
      status: 'sending',
    };
    messages.push(userMsg);

    // ── 2) عرض فوري ──
    renderMessages();
    scrollToBottom();

    // ── 3) تحقق من الجلسة ──
    if (!sessionId) {
      userMsg.status = 'failed';
      userMsg.errorMessage = 'جلسة غير صالحة — أعد تحميل الصفحة';
      failedMessages[userMsgId] = text;
      renderMessages();
      scrollToBottom();
      return;
    }

    // ── 4) تعليم الحالة "جارٍ الإرسال" ──
    isLoading = true;
    renderMessages();
    scrollToBottom();

    // ── 5) الإرسال للـ API ──
    try {
      const res = await fetch(`${baseUrl}/functions/v1/milan-api?action=widget_message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, sessionId, message: text, origin: window.location.origin }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        console.error('[Milano Widget] Message error:', errorData);

        if (res.status === 429 || errorData.quotaExceeded) {
          // نفاد الحصة
          userMsg.status = 'sent';
          messages.push({
            id: generateMsgId(),
            direction: 'out',
            body: errorData.reply || (config && config.quotaExceededMessage) || 'الخدمة غير متاحة مؤقتاً',
            kind: 'quota_exceeded',
            created_at: new Date().toISOString(),
            status: 'sent',
          });
        } else if (res.status === 400 && errorData.code === 'MESSAGE_TOO_LONG') {
          // الرسالة طويلة
          userMsg.status = 'sent';
          messages.push({
            id: generateMsgId(),
            direction: 'out',
            body: `الرسالة أطول من الحد المسموح (${(config && config.maxMessageLength) || 1000} حرف)`,
            kind: 'error',
            created_at: new Date().toISOString(),
            status: 'sent',
          });
        } else if (res.status === 403) {
          // نطاق غير مسموح
          userMsg.status = 'failed';
          userMsg.errorMessage = errorData.error || 'النطاق غير مسموح به';
          failedMessages[userMsgId] = text;
        } else {
          throw new Error(errorData.error || `HTTP ${res.status}`);
        }
      } else {
        const data = await res.json();
        userMsg.status = 'sent';
        messages.push({
          id: generateMsgId(),
          direction: 'out',
          body: data.reply,
          kind: data.kind || 'answer',
          created_at: new Date().toISOString(),
          status: 'sent',
        });
      }
    } catch (err) {
      console.error('[Milano Widget] Message error:', err);
      userMsg.status = 'failed';
      userMsg.errorMessage = err.message || 'تعذر الإرسال — حاول مرة أخرى';
      failedMessages[userMsgId] = text;
    } finally {
      isLoading = false;
      renderMessages();
      scrollToBottom();
    }
  }

  async function retryMessage(msgId) {
    const text = failedMessages[msgId];
    if (!text) return;

    // احذف الرسالة الفاشلة
    messages = messages.filter((m) => m.id !== msgId);
    delete failedMessages[msgId];
    renderMessages();

    // أعد الإرسال
    await sendMessage(text);
  }

  /* ═══════ CSS ═══════ */

  function getStyles() {
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
  }

  /* ═══════ Rendering ═══════ */

  function getAvatarHtml(isBot) {
    if (!isBot) return '';
    const avatarContent = `<img src="${config.avatarUrl || 'https://nmhefwvhoholcjrbbila.supabase.co/storage/v1/object/sign/widget-avatars/photo_2026-10-24_22-19-00.jpg?token=eyJraWQiOiIzMDcyNTQ5Ny04NDk0LTQ5NzMtYTNjZS1jMzViMWIzNzM2Y2MiLCJhbGciOiJIUzUxMiJ9.eyJ1cmwiOiJ3aWRnZXQtYXZhdGFycy9waG90b18yMDI2LTEwLTI0XzIyLTE5LTAwLmpwZyIsInNjb3BlIjoiZG93bmxvYWQiLCJpYXQiOjE3OTI4Njk1ODIsImV4cCI6MjEwODIyOTU4Mn0.nCZRh2ZOOLgdqAQnHHN1G4PilFYRyqU00xsMOt7n8ndbs3oCE00GBMdGl6q2d49Hici6tAM8HVzmzbfsAzg2fg'}" alt="Logo">`;
    return `<div class="milano-widget-message-avatar" style="background: ${config.primaryColor || '#2ec27e'}">${avatarContent}</div>`;
  }

  // ← هذه الدالة تُعيد رسم قائمة الرسائل فقط (وليس الـ container كامل)
  function renderMessages() {
    const messagesDiv = document.getElementById('milano-messages');
    if (!messagesDiv || !config) return;

    let html = '';

    if (messages.length === 0) {
      html = '';  // لا تعرض شيئًا — الخادم يُرسل الترحيب
    } else {
      html = messages.map((m) => {
        const isBot = m.direction === 'out';
        const statusClass =
          m.status === 'sending' ? 'sending'
          : m.status === 'failed' ? 'failed'
          : '';

        return `
          <div class="milano-widget-message ${m.direction === 'out' ? 'out' : 'in'} ${statusClass}">
            ${isBot ? getAvatarHtml(true) : ''}
            <div class="milano-widget-message-content">
              <div class="milano-widget-message-bubble">${escapeHtml(m.body)}</div>
              ${m.errorMessage ? `<div class="milano-widget-error-msg">${escapeHtml(m.errorMessage)}</div>` : ''}
              ${m.status === 'failed' ? `<button class="milano-widget-retry" data-retry-id="${m.id}">↻ إعادة المحاولة</button>` : ''}
              ${config.showTimestamp !== false ? `<div class="milano-widget-message-time">${formatTime(m.created_at)}</div>` : ''}
            </div>
          </div>
        `;
      }).join('');
    }

    if (isLoading) {
      html += `
        <div class="milano-widget-message in">
          ${getAvatarHtml(true)}
          <div class="milano-widget-message-content">
            <div class="milano-widget-message-bubble">
              <div class="milano-widget-loading">
                <span></span><span></span><span></span>
              </div>
            </div>
          </div>
        </div>
      `;
    }

    messagesDiv.innerHTML = html;

    // ربط أزرار إعادة المحاولة
    messagesDiv.querySelectorAll('[data-retry-id]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const msgId = btn.getAttribute('data-retry-id');
        retryMessage(msgId);
      });
    });
  }

  // ← الـ render الرئيسي: يُبنى مرة واحدة فقط (عند init وعند toggle)
  function render() {
    if (!config) return;
    const container = document.getElementById('milano-widget-container');
    if (!container) return;

    // الحفاظ على قيمة الحقل والتركيز إن وُجدا
    const oldInput = document.getElementById('milano-input');
    const preservedValue = oldInput ? oldInput.value : '';
    const wasFocused = oldInput && document.activeElement === oldInput;

    container.innerHTML = `
      <style>${getStyles()}</style>

      <button class="milano-widget-btn" id="milano-toggle-btn" aria-label="فتح المحادثة">
        ${config.launcherIconUrl
          ? `<img src="${config.launcherIconUrl}" alt="">`
          : `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12v3c0 1.66 1.34 3 3 3h3c1.66 0 3-1.34 3-3v-4c0-1.66-1.34-3-3-3H5.05C6.25 4.85 8.93 3 12 3s5.75 1.85 6.95 5H16c-1.66 0-3 1.34-3 3v4c0 1.66 1.34 3 3 3h3c1.66 0 3-1.34 3-3v-3c0-5.52-4.48-10-10-10zm-3 14H5c-.55 0-1-.45-1-1v-3h4c.55 0 1 .45 1 1v3zm10 0h-4v-3c0-.55.45-1 1-1h4v3c0 .55-.45 1-1 1z"/></svg>`}
      </button>

      <div class="milano-widget-window">
        <div class="milano-widget-header">
          ${config.logoUrl ? `<div class="milano-widget-logo"><img src="${config.logoUrl}" alt=""></div>` : ''}
          <div class="milano-widget-avatar">
            <img src="https://nmhefwvhoholcjrbbila.supabase.co/storage/v1/object/sign/widget-avatars/photo_2026-10-24_22-19-00.jpg?token=eyJraWQiOiIzMDcyNTQ5Ny04NDk0LTQ5NzMtYTNjZS1jMzViMWIzNzM2Y2MiLCJhbGciOiJIUzUxMiJ9.eyJ1cmwiOiJ3aWRnZXQtYXZhdGFycy9waG90b18yMDI2LTEwLTI0XzIyLTE5LTAwLmpwZyIsInNjb3BlIjoiZG93bmxvYWQiLCJpYXQiOjE3OTI4Njk1ODIsImV4cCI6MjEwODIyOTU4Mn0.nCZRh2ZOOLgdqAQnHHN1G4PilFYRyqU00xsMOt7n8ndbs3oCE00GBMdGl6q2d49Hici6tAM8HVzmzbfsAzg2fg" alt="Logo">
          </div>
          <div class="milano-widget-title">
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
      </div>
    `;

    // املأ القائمة
    renderMessages();

    /* ═══════ ربط الأحداث ═══════ */

    const closeBtn = document.getElementById('milano-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        isOpen = false;
        container.querySelector('.milano-widget-window').style.display = 'none';
      });
    }

    const toggleBtn = document.getElementById('milano-toggle-btn');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        isOpen = !isOpen;
        const win = container.querySelector('.milano-widget-window');
        if (win) win.style.display = isOpen ? 'flex' : 'none';
        if (isOpen) {
          renderMessages();
          scrollToBottom();
          const inp = document.getElementById('milano-input');
          if (inp) setTimeout(() => inp.focus(), 100);
        }
      });
    }

    const inputEl = document.getElementById('milano-input');
    const sendBtn = document.getElementById('milano-send-btn');

    if (inputEl) {
      inputEl.value = preservedValue;

      inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          handleSend();
        }
      });

      inputEl.addEventListener('input', () => {
        inputEl.style.height = 'auto';
        inputEl.style.height = Math.min(inputEl.scrollHeight, 100) + 'px';
      });

      if (wasFocused) {
        inputEl.focus();
        inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
      }
    }

    if (sendBtn) {
      sendBtn.addEventListener('click', (e) => {
        e.preventDefault();
        handleSend();
      });
    }

    // أزرار الاقتراحات
    container.querySelectorAll('[data-suggestion]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const q = btn.getAttribute('data-suggestion');
        handleSend(q);
      });
    });
  }

  /* ═══════ معالج الإرسال الموحّد ═══════ */

  function handleSend(predefinedText) {
    const input = document.getElementById('milano-input');
    let text = predefinedText;

    if (!text) {
      if (!input || !input.value.trim()) return;
      text = input.value.trim();
      input.value = '';
      input.style.height = 'auto';
    }

    sendMessage(text);
  }

  /* ═══════ Public API ═══════ */

  window.milanoWidget = {
    toggle: function () {
      isOpen = !isOpen;
      const container = document.getElementById('milano-widget-container');
      if (container) {
        const win = container.querySelector('.milano-widget-window');
        if (win) win.style.display = isOpen ? 'flex' : 'none';
        if (isOpen) {
          renderMessages();
          scrollToBottom();
        }
      }
    },
    send: function () {
      handleSend();
    },
    sendSuggestion: function (text) {
      handleSend(text);
    },
  };

  /* ═══════ Init ═══════ */

  async function init() {
    // Container
    const container = document.createElement('div');
    container.id = 'milano-widget-container';
    document.body.appendChild(container);

    // Config
    config = await fetchConfig();
    if (!config) {
      container.innerHTML = '<div style="display:none"></div>';
      return;
    }

    // Session
    await createSession();

    // Render
    render();
    scrollToBottom();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
