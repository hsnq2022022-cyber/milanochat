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
      const res = await fetch(`${baseUrl}/api/widgets/public/${token}`);
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
      const res = await fetch(`${baseUrl}/api/widgets/public/${token}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitorId, origin: window.location.origin }),
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
      const res = await fetch(`${baseUrl}/api/widgets/public/${token}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message: text, origin: window.location.origin }),
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
        box-shadow: 0 4px 20px rgba(0,0,0,0.2);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 999999;
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      }
      .milano-widget-btn:hover {
        transform: scale(1.08);
        box-shadow: 0 6px 24px rgba(0,0,0,0.25);
      }
      .milano-widget-btn svg {
        width: ${(config.launcherSize || 60) * 0.45}px;
        height: ${(config.launcherSize || 60) * 0.45}px;
        fill: white;
      }
      .milano-widget-btn img { width: 70%; height: 70%; object-fit: cover; border-radius: inherit; }

      .milano-widget-window {
        position: fixed;
        bottom: ${(config.launcherOffsetY || 20) + (config.launcherSize || 60) + 10}px;
        ${position}
        width: ${config.windowWidth || 380}px;
        max-width: calc(100vw - 40px);
        height: ${config.windowHeight || 560}px;
        max-height: calc(100vh - 120px);
        background: white;
        border-radius: ${radius}px;
        box-shadow: ${config.shadow === 'none' ? 'none' : config.shadow === 'light' ? '0 4px 16px rgba(0,0,0,0.1)' : config.shadow === 'strong' ? '0 12px 48px rgba(0,0,0,0.25)' : '0 8px 32px rgba(0,0,0,0.2)'};
        display: ${isOpen ? 'flex' : 'none'};
        flex-direction: column;
        z-index: 999999;
        overflow: hidden;
        border: 1px solid rgba(0,0,0,0.08);
      }

      .milano-widget-header {
        background: ${config.headerBackgroundColor || primaryColor};
        color: ${config.headerTextColor || 'white'};
        padding: 16px;
        display: flex;
        align-items: center;
        gap: 12px;
        border-radius: ${radius}px ${radius}px 0 0;
        flex-shrink: 0;
      }
      .milano-widget-avatar {
        width: 40px; height: 40px; border-radius: 50%;
        background: rgba(255,255,255,0.2);
        display: flex; align-items: center; justify-content: center;
        font-size: 20px; overflow: hidden;
      }
      .milano-widget-avatar img { width: 100%; height: 100%; object-fit: cover; }
      .milano-widget-logo {
        width: 32px; height: 32px; border-radius: 8px; overflow: hidden;
        background: rgba(255,255,255,0.2);
        display: flex; align-items: center; justify-content: center;
      }
      .milano-widget-logo img { width: 100%; height: 100%; object-fit: cover; }
      .milano-widget-title { flex: 1; }
      .milano-widget-title h3 { margin: 0; font-size: 16px; font-weight: 600; }
      .milano-widget-title p { margin: 2px 0 0; font-size: 12px; opacity: 0.9; }
      .milano-widget-status { display: flex; align-items: center; gap: 4px; font-size: 11px; opacity: 0.9; margin-top: 4px; }
      .milano-widget-status-dot { width: 8px; height: 8px; border-radius: 50%; background: #4ade80; animation: milano-pulse 2s infinite; }
      @keyframes milano-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }

      .milano-widget-messages {
        flex: 1; overflow-y: auto; padding: 16px;
        background: #f8f9fa; min-height: 0;
      }
      .milano-widget-message {
        margin-bottom: 12px; display: flex; gap: 8px;
        ${config.rtl ? 'flex-direction: row-reverse;' : ''}
      }
      .milano-widget-message.in { ${config.rtl ? 'flex-direction: row;' : ''} }
      .milano-widget-message-avatar {
        width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0;
        overflow: hidden; background: ${primaryColor};
        display: flex; align-items: center; justify-content: center;
        color: white; font-size: 14px; font-weight: bold;
      }
      .milano-widget-message-avatar img { width: 100%; height: 100%; object-fit: cover; }
      .milano-widget-message-content { flex: 1; max-width: calc(100% - 40px); }
      .milano-widget-message-bubble {
        padding: 10px 14px; border-radius: ${radius}px;
        font-size: 14px; line-height: 1.5;
        word-wrap: break-word; white-space: pre-wrap;
      }
      .milano-widget-message.out .milano-widget-message-bubble {
        background: ${primaryColor}; color: white;
        border-bottom-${config.rtl ? 'left' : 'right'}-radius: 4px;
      }
      .milano-widget-message.in .milano-widget-message-bubble {
        background: white; color: #333;
        border-bottom-${config.rtl ? 'right' : 'left'}-radius: 4px;
        box-shadow: 0 1px 2px rgba(0,0,0,0.05);
      }
      .milano-widget-message.sending .milano-widget-message-bubble { opacity: 0.6; }
      .milano-widget-message.failed .milano-widget-message-bubble {
        background: #fee2e2 !important; color: #991b1b !important;
        border: 1px solid #fca5a5;
      }
      .milano-widget-message-time {
        font-size: 10px; color: #999; margin-top: 4px;
        ${config.rtl ? 'text-align: left;' : 'text-align: right;'}
      }
      .milano-widget-retry {
        margin-top: 6px; font-size: 11px; color: #dc2626;
        background: none; border: none; cursor: pointer;
        padding: 2px 0; text-decoration: underline;
        font-family: inherit;
      }
      .milano-widget-retry:hover { color: #991b1b; }
      .milano-widget-error-msg { margin-top: 6px; font-size: 11px; color: #991b1b; }

      .milano-widget-input-area {
        padding: 12px; background: white;
        border-top: 1px solid #e0e0e0;
        display: flex; gap: 8px;
        flex-shrink: 0; align-items: flex-end;
      }
      .milano-widget-input {
        flex: 1; padding: 10px 14px;
        border: 1px solid #e0e0e0; border-radius: 20px;
        font-size: 14px; outline: none; resize: none;
        max-height: 100px; min-height: 40px;
        font-family: inherit; line-height: 1.4;
      }
      .milano-widget-input:focus { border-color: ${primaryColor}; }
      .milano-widget-send {
        width: 40px; height: 40px; border-radius: 50%;
        background: ${primaryColor}; border: none;
        cursor: pointer; display: flex;
        align-items: center; justify-content: center;
        flex-shrink: 0; transition: opacity 0.2s;
      }
      .milano-widget-send:disabled { opacity: 0.5; cursor: not-allowed; }
      .milano-widget-send svg { width: 18px; height: 18px; fill: white; }

      .milano-widget-loading { display: flex; gap: 4px; padding: 4px 0; }
      .milano-widget-loading span {
        width: 8px; height: 8px; border-radius: 50%;
        background: ${primaryColor};
        animation: milano-bounce 1.4s infinite ease-in-out both;
      }
      .milano-widget-loading span:nth-child(1) { animation-delay: -0.32s; }
      .milano-widget-loading span:nth-child(2) { animation-delay: -0.16s; }
      @keyframes milano-bounce {
        0%, 80%, 100% { transform: scale(0); }
        40% { transform: scale(1); }
      }

      .milano-widget-suggestions {
        padding: 8px 12px; display: flex; gap: 8px;
        overflow-x: auto; background: white;
        border-top: 1px solid #e0e0e0; flex-shrink: 0;
      }
      .milano-widget-suggestion {
        padding: 6px 12px; background: #f0f0f0;
        border-radius: 16px; font-size: 12px;
        white-space: nowrap; cursor: pointer;
        border: none; font-family: inherit;
      }
      .milano-widget-suggestion:hover { background: #e0e0e0; }

      @media (max-width: 480px) {
        .milano-widget-window {
          width: calc(100vw - 20px);
          height: calc(100vh - 100px);
          bottom: 80px;
          ${config.position === 'right' ? 'right: 10px;' : 'left: 10px;'}
        }
      }
    `;
  }

  /* ═══════ Rendering ═══════ */

  function getAvatarHtml(isBot) {
    if (!isBot) return '';
    const avatarContent = config.avatarUrl
      ? `<img src="${config.avatarUrl}" alt="">`
      : (config.agentName ? config.agentName.charAt(0) : '🤖');
    return `<div class="milano-widget-message-avatar" style="background: ${config.primaryColor || '#2ec27e'}">${avatarContent}</div>`;
  }

  // ← هذه الدالة تُعيد رسم قائمة الرسائل فقط (وليس الـ container كامل)
  function renderMessages() {
    const messagesDiv = document.getElementById('milano-messages');
    if (!messagesDiv || !config) return;

    let html = '';

    if (messages.length === 0) {
      html = `
        <div class="milano-widget-message out">
          ${getAvatarHtml(true)}
          <div class="milano-widget-message-content">
            <div class="milano-widget-message-bubble">${escapeHtml(config.welcomeMessage)}</div>
          </div>
        </div>
      `;
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
          : `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12c0 1.54.36 3 1 4.29L2 22l5.71-1C9 21.64 10.46 22 12 22c5.52 0 10-4.48 10-10S17.52 2 12 2zm0 18c-1.38 0-2.67-.33-3.82-.91l-.27-.15-3.18.56.56-3.18-.15-.27C4.33 14.67 4 13.38 4 12c0-4.41 3.59-8 8-8s8 3.59 8 8-3.59 8-8 8z"/></svg>`}
      </button>

      <div class="milano-widget-window">
        <div class="milano-widget-header">
          ${config.logoUrl ? `<div class="milano-widget-logo"><img src="${config.logoUrl}" alt=""></div>` : ''}
          <div class="milano-widget-avatar">
            ${config.avatarUrl ? `<img src="${config.avatarUrl}" alt="">` : '💬'}
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
