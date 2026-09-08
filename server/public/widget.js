/**
 * Milano Widget — يُحمّل من الخادم ويُضمّن في أي موقع
 * الاستخدام:
 * <script src="https://YOUR-DOMAIN/widget.js" data-token="WIDGET_TOKEN"></script>
 */
(function() {
  'use strict';

  // قراءة الـ token من الـ script tag
  const scripts = document.getElementsByTagName('script');
  let token = null;
  let baseUrl = null;

  for (let i = 0; i < scripts.length; i++) {
    const src = scripts[i].src || '';
    if (src.includes('widget.js')) {
      token = scripts[i].getAttribute('data-token');
      const match = src.match(/^(https?:\/\/[^\/]+)/);
      baseUrl = match ? match[1] : '';
      break;
    }
  }

  if (!token || !baseUrl) {
    console.error('[Milano Widget] Missing data-token or invalid src');
    return;
  }

  // متغيرات الحالة
  let config = null;
  let sessionId = null;
  let messages = [];
  let isOpen = false;
  let isLoading = false;

  // إنشاء visitor ID فريد
  const visitorId = 'v_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();

  // ═══════════ API Calls ═══════════

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
        body: JSON.stringify({ visitorId }),
      });
      if (!res.ok) throw new Error('Session error');
      const data = await res.json();
      sessionId = data.sessionId;
      messages = data.messages || [];
      return data;
    } catch (err) {
      console.error('[Milano Widget] Session error:', err);
      return null;
    }
  }

  async function sendMessage(text) {
    if (!sessionId || isLoading) return;
    isLoading = true;
    render();

    try {
      const res = await fetch(`${baseUrl}/api/widgets/public/${token}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message: text }),
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        if (res.status === 429 || errorData.quotaExceeded) {
          // نفاد الحصة
          const quotaMessage = config.quotaExceededMessage || 'الخدمة غير متاحة مؤقتاً، اترك بريدك وسنتواصل معك';
          messages.push({ direction: 'in', body: text, kind: 'customer', created_at: new Date().toISOString() });
          messages.push({ direction: 'out', body: quotaMessage, kind: 'quota_exceeded', created_at: new Date().toISOString() });
        } else {
          throw new Error(errorData.error || 'Message error');
        }
      } else {
        const data = await res.json();
        messages.push({ direction: 'in', body: text, kind: 'customer', created_at: new Date().toISOString() });
        messages.push({ direction: 'out', body: data.reply, kind: data.kind, created_at: new Date().toISOString() });
      }
      
      isLoading = false;
      render();
    } catch (err) {
      console.error('[Milano Widget] Message error:', err);
      messages.push({ direction: 'in', body: text, kind: 'customer', created_at: new Date().toISOString() });
      messages.push({ direction: 'out', body: 'عذراً، حدث خطأ. يرجى المحاولة مرة أخرى.', kind: 'error', created_at: new Date().toISOString() });
      isLoading = false;
      render();
    }
  }

  // ═══════════ UI Rendering ═══════════

  function render() {
    if (!config) return;

    const container = document.getElementById('milano-widget-container');
    if (!container) return;

    const position = config.position === 'right' ? 'right: 20px;' : 'left: 20px;';
    const primaryColor = config.primaryColor || '#2ec27e';

    container.innerHTML = `
      <style>
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
          width: ${config.launcherSize ? config.launcherSize * 0.45 : 28}px;
          height: ${config.launcherSize ? config.launcherSize * 0.45 : 28}px;
          fill: white;
        }
        .milano-widget-btn img {
          width: 70%;
          height: 70%;
          object-fit: cover;
          border-radius: inherit;
        }
        .milano-widget-window {
          position: fixed;
          bottom: ${(config.launcherOffsetY || 20) + (config.launcherSize || 60) + 10}px;
          ${position}
          width: ${config.windowWidth || 380}px;
          max-width: calc(100vw - 40px);
          height: ${config.windowHeight || 560}px;
          max-height: calc(100vh - 120px);
          background: white;
          border-radius: ${config.borderRadius || 16}px;
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
          border-radius: ${config.borderRadius || 16}px ${config.borderRadius || 16}px 0 0;
        }
        .milano-widget-avatar {
          width: 40px;
          height: 40px;
          border-radius: 50%;
          background: rgba(255,255,255,0.2);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 20px;
          overflow: hidden;
        }
        .milano-widget-avatar img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }
        .milano-widget-logo {
          width: 32px;
          height: 32px;
          border-radius: 8px;
          overflow: hidden;
          background: rgba(255,255,255,0.2);
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .milano-widget-logo img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }
        .milano-widget-title {
          flex: 1;
        }
        .milano-widget-title h3 {
          margin: 0;
          font-size: 16px;
          font-weight: 600;
        }
        .milano-widget-title p {
          margin: 2px 0 0;
          font-size: 12px;
          opacity: 0.9;
        }
        .milano-widget-status {
          display: flex;
          align-items: center;
          gap: 4px;
          font-size: 11px;
          opacity: 0.9;
        }
        .milano-widget-status-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #4ade80;
          animation: milano-pulse 2s infinite;
        }
        @keyframes milano-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        .milano-widget-messages {
          flex: 1;
          overflow-y: auto;
          padding: 16px;
          background: #f8f9fa;
        }
        .milano-widget-message {
          margin-bottom: 12px;
          display: flex;
          gap: 8px;
          ${config.rtl ? 'flex-direction: row-reverse;' : ''}
        }
        .milano-widget-message.in {
          ${config.rtl ? 'flex-direction: row;' : ''}
        }
        .milano-widget-message-avatar {
          width: 32px;
          height: 32px;
          border-radius: 50%;
          flex-shrink: 0;
          overflow: hidden;
          background: ${primaryColor};
          display: flex;
          align-items: center;
          justify-content: center;
          color: white;
          font-size: 14px;
          font-weight: bold;
        }
        .milano-widget-message-avatar img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }
        .milano-widget-message-content {
          flex: 1;
          max-width: calc(100% - 40px);
        }
        .milano-widget-message-bubble {
          padding: 10px 14px;
          border-radius: ${config.borderRadius || 16}px;
          font-size: 14px;
          line-height: 1.5;
          word-wrap: break-word;
          white-space: pre-wrap;
        }
        .milano-widget-message.out .milano-widget-message-bubble {
          background: ${primaryColor};
          color: white;
          border-bottom-${config.rtl ? 'left' : 'right'}-radius: 4px;
        }
        .milano-widget-message.in .milano-widget-message-bubble {
          background: white;
          color: #333;
          border-bottom-${config.rtl ? 'right' : 'left'}-radius: 4px;
          box-shadow: 0 1px 2px rgba(0,0,0,0.05);
        }
        .milano-widget-message-time {
          font-size: 10px;
          color: #999;
          margin-top: 4px;
          ${config.rtl ? 'text-align: left;' : 'text-align: right;'}
        }
        .milano-widget-input-area {
          padding: 12px;
          background: white;
          border-top: 1px solid #e0e0e0;
          display: flex;
          gap: 8px;
        }
        .milano-widget-input {
          flex: 1;
          padding: 10px 14px;
          border: 1px solid #e0e0e0;
          border-radius: 20px;
          font-size: 14px;
          outline: none;
        }
        .milano-widget-input:focus {
          border-color: ${primaryColor};
        }
        .milano-widget-send {
          width: 40px;
          height: 40px;
          border-radius: 50%;
          background: ${primaryColor};
          border: none;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .milano-widget-send:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .milano-widget-send svg {
          width: 18px;
          height: 18px;
          fill: white;
        }
        .milano-widget-loading {
          display: flex;
          gap: 4px;
          padding: 10px 14px;
        }
        .milano-widget-loading span {
          width: 8px;
          height: 8px;
          border-radius: 50%;
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
          padding: 8px 12px;
          display: flex;
          gap: 8px;
          overflow-x: auto;
          background: white;
          border-top: 1px solid #e0e0e0;
        }
        .milano-widget-suggestion {
          padding: 6px 12px;
          background: #f0f0f0;
          border-radius: 16px;
          font-size: 12px;
          white-space: nowrap;
          cursor: pointer;
          border: none;
        }
        .milano-widget-suggestion:hover {
          background: #e0e0e0;
        }
        @media (max-width: 480px) {
          .milano-widget-window {
            width: calc(100vw - 20px);
            height: calc(100vh - 100px);
            bottom: 80px;
            ${config.position === 'right' ? 'right: 10px;' : 'left: 10px;'}
          }
        }
      </style>

      <button class="milano-widget-btn" onclick="window.milanoWidget.toggle()" aria-label="فتح المحادثة">
        ${config.launcherIconUrl ? `<img src="${config.launcherIconUrl}" alt="">` : `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12c0 1.54.36 3 1 4.29L2 22l5.71-1C9 21.64 10.46 22 12 22c5.52 0 10-4.48 10-10S17.52 2 12 2zm0 18c-1.38 0-2.67-.33-3.82-.91l-.27-.15-3.18.56.56-3.18-.15-.27C4.33 14.67 4 13.38 4 12c0-4.41 3.59-8 8-8s8 3.59 8 8-3.59 8-8 8z"/></svg>`}
      </button>

      <div class="milano-widget-window">
        <div class="milano-widget-header">
          ${config.logoUrl ? `<div class="milano-widget-logo"><img src="${config.logoUrl}" alt=""></div>` : ''}
          <div class="milano-widget-avatar">
            ${config.avatarUrl ? `<img src="${config.avatarUrl}" alt="">` : '💬'}
          </div>
          <div class="milano-widget-title">
            <h3>${config.agentName || config.name}</h3>
            <p>${config.agentTagline || config.businessName}</p>
            ${config.showStatus !== false ? '<div class="milano-widget-status"><span class="milano-widget-status-dot"></span> متصل الآن</div>' : ''}
          </div>
        </div>

        <div class="milano-widget-messages" id="milano-messages">
          ${renderMessages()}
        </div>

        ${config.suggestedQuestions && config.suggestedQuestions.length > 0 && messages.length <= 1 ? `
          <div class="milano-widget-suggestions">
            ${config.suggestedQuestions.map(q => `<button class="milano-widget-suggestion" onclick="window.milanoWidget.sendSuggestion('${q.replace(/'/g, "\\'")}')">${q}</button>`).join('')}
          </div>
        ` : ''}

        <div class="milano-widget-input-area">
          <textarea class="milano-widget-input" placeholder="${config.placeholder || 'اكتب رسالتك...'}" id="milano-input" rows="1" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();window.milanoWidget.send();}"></textarea>
          <button class="milano-widget-send" onclick="window.milanoWidget.send()" ${isLoading ? 'disabled' : ''} aria-label="إرسال">
            <svg viewBox="0 0 24 24">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
            </svg>
          </button>
        </div>
      </div>
    `;

    // Scroll to bottom
    const messagesDiv = document.getElementById('milano-messages');
    if (messagesDiv) {
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }
  }

  function renderMessages() {
    const formatTime = (iso) => {
      if (!iso) return '';
      const d = new Date(iso);
      return d.toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' });
    };

    const avatarHtml = (isBot) => {
      if (isBot) {
        const avatarContent = config.avatarUrl 
          ? `<img src="${config.avatarUrl}" alt="">`
          : (config.agentName ? config.agentName.charAt(0) : '🤖');
        return `<div class="milano-widget-message-avatar" style="background: ${config.primaryColor || '#2ec27e'}">${avatarContent}</div>`;
      }
      return '';
    };

    if (messages.length === 0) {
      return `
        <div class="milano-widget-message out">
          ${avatarHtml(true)}
          <div class="milano-widget-message-content">
            <div class="milano-widget-message-bubble">${escapeHtml(config.welcomeMessage)}</div>
          </div>
        </div>
      `;
    }

    return messages.map(m => {
      const isBot = m.direction === 'out';
      return `
        <div class="milano-widget-message ${m.direction === 'out' ? 'out' : 'in'}">
          ${isBot ? avatarHtml(true) : ''}
          <div class="milano-widget-message-content">
            <div class="milano-widget-message-bubble">${escapeHtml(m.body)}</div>
            ${config.showTimestamp !== false ? `<div class="milano-widget-message-time">${formatTime(m.created_at)}</div>` : ''}
          </div>
        </div>
      `;
    }).join('') + (isLoading ? `
      <div class="milano-widget-message in">
        ${avatarHtml(true)}
        <div class="milano-widget-message-content">
          <div class="milano-widget-message-bubble">
            <div class="milano-widget-loading">
              <span></span><span></span><span></span>
            </div>
          </div>
        </div>
      </div>
    ` : '');
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ═══════════ Public API ═══════════

  window.milanoWidget = {
    toggle: function() {
      isOpen = !isOpen;
      render();
    },
    send: function() {
      const input = document.getElementById('milano-input');
      if (!input || !input.value.trim()) return;
      const text = input.value.trim();
      input.value = '';
      sendMessage(text);
    },
    sendSuggestion: function(text) {
      sendMessage(text);
    }
  };

  // ═══════════ Initialization ═══════════

  async function init() {
    // Create container
    const container = document.createElement('div');
    container.id = 'milano-widget-container';
    document.body.appendChild(container);

    // Fetch config
    config = await fetchConfig();
    if (!config) {
      container.innerHTML = '<div style="display:none"></div>';
      return;
    }

    // Create session
    await createSession();

    // Render
    render();
  }

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
