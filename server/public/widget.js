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
          bottom: 20px;
          ${position}
          width: 60px;
          height: 60px;
          border-radius: 50%;
          background: ${primaryColor};
          border: none;
          cursor: pointer;
          box-shadow: 0 4px 12px rgba(0,0,0,0.15);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 999999;
          transition: transform 0.2s;
        }
        .milano-widget-btn:hover {
          transform: scale(1.05);
        }
        .milano-widget-btn svg {
          width: 28px;
          height: 28px;
          fill: white;
        }
        .milano-widget-window {
          position: fixed;
          bottom: 90px;
          ${position}
          width: 380px;
          max-width: calc(100vw - 40px);
          height: 560px;
          max-height: calc(100vh - 120px);
          background: white;
          border-radius: 16px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.2);
          display: ${isOpen ? 'flex' : 'none'};
          flex-direction: column;
          z-index: 999999;
          overflow: hidden;
        }
        .milano-widget-header {
          background: ${primaryColor};
          color: white;
          padding: 16px;
          display: flex;
          align-items: center;
          gap: 12px;
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
        .milano-widget-messages {
          flex: 1;
          overflow-y: auto;
          padding: 16px;
          background: #f8f9fa;
        }
        .milano-widget-message {
          margin-bottom: 12px;
          display: flex;
          ${config.rtl ? 'flex-direction: row-reverse;' : ''}
        }
        .milano-widget-message.in {
          ${config.rtl ? 'flex-direction: row;' : ''}
        }
        .milano-widget-message-bubble {
          max-width: 80%;
          padding: 10px 14px;
          border-radius: 16px;
          font-size: 14px;
          line-height: 1.5;
          word-wrap: break-word;
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

      <button class="milano-widget-btn" onclick="window.milanoWidget.toggle()">
        <svg viewBox="0 0 24 24">
          <path d="M12 2C6.48 2 2 6.48 2 12c0 1.54.36 3 1 4.29L2 22l5.71-1C9 21.64 10.46 22 12 22c5.52 0 10-4.48 10-10S17.52 2 12 2zm0 18c-1.38 0-2.67-.33-3.82-.91l-.27-.15-3.18.56.56-3.18-.15-.27C4.33 14.67 4 13.38 4 12c0-4.41 3.59-8 8-8s8 3.59 8 8-3.59 8-8 8z"/>
        </svg>
      </button>

      <div class="milano-widget-window">
        <div class="milano-widget-header">
          <div class="milano-widget-avatar">💬</div>
          <div class="milano-widget-title">
            <h3>${config.name}</h3>
            <p>${config.businessName}</p>
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
          <input type="text" class="milano-widget-input" placeholder="${config.placeholder}" id="milano-input" onkeypress="if(event.key==='Enter')window.milanoWidget.send()">
          <button class="milano-widget-send" onclick="window.milanoWidget.send()" ${isLoading ? 'disabled' : ''}>
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
    if (messages.length === 0) {
      return `<div class="milano-widget-message out"><div class="milano-widget-message-bubble">${config.welcomeMessage}</div></div>`;
    }

    return messages.map(m => `
      <div class="milano-widget-message ${m.direction === 'out' ? 'out' : 'in'}">
        <div class="milano-widget-message-bubble">${escapeHtml(m.body)}</div>
      </div>
    `).join('') + (isLoading ? `
      <div class="milano-widget-message in">
        <div class="milano-widget-message-bubble">
          <div class="milano-widget-loading">
            <span></span><span></span><span></span>
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
