import { useState, useRef, useEffect } from "react";
import { DEMO_CONFIG, type DemoMessage, type DemoConversationState } from "../lib/demoConfig";

/**
 * HumanAgentChat - مكون المحادثة التجريبية
 * يعرض محادثة بين عميل و AI ثم يتحول إلى موظف بشري
 */
export default function HumanAgentChat() {
  const [state, setState] = useState<DemoConversationState>({
    messages: DEMO_CONFIG.defaultConversation as DemoMessage[],
    isTransferred: false,
    isAITyping: false,
    isHumanTyping: false,
  });

  const [humanInput, setHumanInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // التمرير التلقائي لأسفل المحادثة
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.messages]);

  // محاكاة التحويل إلى موظف بشري
  const handleTransfer = () => {
    setState((prev) => ({
      ...prev,
      isTransferred: true,
      messages: [
        ...prev.messages,
        {
          id: `transfer-${Date.now()}`,
          sender: "system",
          message: DEMO_CONFIG.transferMessage,
          timestamp: new Date().toISOString(),
        } as any,
      ],
    }));

    // محاكاة رسالة بعد التحويل
    setTimeout(() => {
      setState((prev) => ({
        ...prev,
        messages: [
          ...prev.messages,
          {
            id: `after-transfer-${Date.now()}`,
            sender: "system",
            message: DEMO_CONFIG.afterTransferMessage,
            timestamp: new Date().toISOString(),
          } as any,
        ],
      }));
    }, 1500);
  };

  // إرسال رسالة من الموظف البشري
  const handleHumanSend = () => {
    if (!humanInput.trim()) return;

    setState((prev) => ({
      ...prev,
      isHumanTyping: true,
    }));

    // محاكاة الكتابة
    setTimeout(() => {
      setState((prev) => ({
        ...prev,
        isHumanTyping: false,
        messages: [
          ...prev.messages,
          {
            id: `human-${Date.now()}`,
            sender: "human",
            message: humanInput,
            timestamp: new Date().toISOString(),
          },
        ],
      }));
      setHumanInput("");
    }, 1000);
  };

  // الحصول على معلومات المرسل
  const getSenderInfo = (sender: string) => {
    switch (sender) {
      case "customer":
        return {
          name: DEMO_CONFIG.customer.name,
          color: "bg-blue-500",
          icon: "👤",
        };
      case "ai":
        return {
          name: DEMO_CONFIG.aiAgent.name,
          color: "bg-green-500",
          icon: "🤖",
        };
      case "human":
        return {
          name: DEMO_CONFIG.humanAgent.name,
          color: "bg-purple-500",
          icon: "👨‍💼",
        };
      case "system":
        return {
          name: "النظام",
          color: "bg-gray-500",
          icon: "⚙️",
        };
      default:
        return { name: "غير معروف", color: "bg-gray-500", icon: "?" };
    }
  };

  // تنسيق الوقت
  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString("ar-SA", {
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div className="flex flex-col h-full bg-night rounded-2xl border border-verde/20 overflow-hidden">
      {/* ══════════════════════════════════════════════════════════════════════
          Header
      ══════════════════════════════════════════════════════════════════════ */}
      <div className="bg-pine/50 border-b border-verde/10 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-blue-500 flex items-center justify-center text-white font-bold">
              👤
            </div>
            <div>
              <h3 className="font-display font-bold text-bone">
                {DEMO_CONFIG.customer.name}
              </h3>
              <p className="text-xs text-sage">
                {state.isTransferred ? "محوّلة إلى موظف بشري" : "محادثة نشطة"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {state.isTransferred && (
              <span className="px-3 py-1 rounded-full bg-purple-500/20 text-purple-300 text-xs font-semibold">
                Human Agent
              </span>
            )}
            <span className="w-2 h-2 rounded-full bg-verde animate-pulse"></span>
          </div>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          Messages
      ══════════════════════════════════════════════════════════════════════ */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {state.messages.map((msg) => {
          const senderInfo = getSenderInfo(msg.sender);
          const isSystem = msg.sender === "system";

          if (isSystem) {
            return (
              <div key={msg.id} className="flex justify-center">
                <div className="bg-gray-500/20 text-gray-300 px-4 py-2 rounded-full text-xs">
                  {msg.message}
                </div>
              </div>
            );
          }

          return (
            <div
              key={msg.id}
              className={`flex gap-3 ${
                msg.sender === "customer" ? "flex-row" : "flex-row-reverse"
              }`}
            >
              {/* Avatar */}
              <div
                className={`w-10 h-10 rounded-full ${senderInfo.color} flex items-center justify-center text-white text-lg flex-shrink-0`}
              >
                {senderInfo.icon}
              </div>

              {/* Message */}
              <div
                className={`flex-1 max-w-[70%] ${
                  msg.sender === "customer" ? "text-left" : "text-right"
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-semibold text-sage">
                    {senderInfo.name}
                  </span>
                  <span className="text-xs text-sage/60">
                    {formatTime(msg.timestamp)}
                  </span>
                </div>
                <div
                  className={`inline-block px-4 py-3 rounded-2xl ${
                    msg.sender === "customer"
                      ? "bg-blue-500/20 text-bone"
                      : msg.sender === "ai"
                      ? "bg-green-500/20 text-bone"
                      : "bg-purple-500/20 text-bone"
                  }`}
                >
                  <p className="text-sm leading-relaxed">{msg.message}</p>
                </div>
              </div>
            </div>
          );
        })}

        {/* مؤشرات الكتابة */}
        {state.isAITyping && (
          <div className="flex gap-3 flex-row-reverse">
            <div className="w-10 h-10 rounded-full bg-green-500 flex items-center justify-center text-white text-lg">
              🤖
            </div>
            <div className="bg-green-500/20 px-4 py-3 rounded-2xl">
              <div className="flex gap-1">
                <span className="w-2 h-2 bg-green-400 rounded-full animate-bounce"></span>
                <span
                  className="w-2 h-2 bg-green-400 rounded-full animate-bounce"
                  style={{ animationDelay: "0.1s" }}
                ></span>
                <span
                  className="w-2 h-2 bg-green-400 rounded-full animate-bounce"
                  style={{ animationDelay: "0.2s" }}
                ></span>
              </div>
            </div>
          </div>
        )}

        {state.isHumanTyping && (
          <div className="flex gap-3 flex-row-reverse">
            <div className="w-10 h-10 rounded-full bg-purple-500 flex items-center justify-center text-white text-lg">
              👨‍💼
            </div>
            <div className="bg-purple-500/20 px-4 py-3 rounded-2xl">
              <div className="flex gap-1">
                <span className="w-2 h-2 bg-purple-400 rounded-full animate-bounce"></span>
                <span
                  className="w-2 h-2 bg-purple-400 rounded-full animate-bounce"
                  style={{ animationDelay: "0.1s" }}
                ></span>
                <span
                  className="w-2 h-2 bg-purple-400 rounded-full animate-bounce"
                  style={{ animationDelay: "0.2s" }}
                ></span>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          Input Area
      ══════════════════════════════════════════════════════════════════════ */}
      <div className="border-t border-verde/10 p-4 bg-pine/30">
        {!state.isTransferred ? (
          // زر التحويل قبل التحويل
          <button
            onClick={handleTransfer}
            className="w-full bg-purple-500 hover:bg-purple-600 text-white font-semibold py-3 rounded-xl transition-all duration-300 flex items-center justify-center gap-2"
          >
            <span>👨‍💼</span>
            <span>تحويل إلى موظف بشري</span>
          </button>
        ) : (
          // حقل الإدخال بعد التحويل
          <div className="flex gap-3">
            <input
              type="text"
              value={humanInput}
              onChange={(e) => setHumanInput(e.target.value)}
              onKeyPress={(e) => e.key === "Enter" && handleHumanSend()}
              placeholder="اكتب ردك كموظف بشري..."
              className="flex-1 bg-night/50 border border-verde/20 rounded-xl px-4 py-3 text-bone placeholder:text-sage/50 focus:outline-none focus:border-verde/50 transition-all"
            />
            <button
              onClick={handleHumanSend}
              disabled={!humanInput.trim()}
              className="bg-purple-500 hover:bg-purple-600 disabled:bg-purple-500/50 disabled:cursor-not-allowed text-white font-semibold px-6 py-3 rounded-xl transition-all duration-300"
            >
              إرسال
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
