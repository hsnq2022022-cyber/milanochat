// ═══════════════════════════════════════════════════════════════════════════════
// WidgetPreview - معاينة حية متقدمة
// ═══════════════════════════════════════════════════════════════════════════════

import { useState } from "react";
import type { WidgetSettings, WidgetTheme, WidgetDevice, WidgetState } from "../types/widget";
import { IconX, IconMinimize, IconMaximize } from "../components/Icons";

interface WidgetPreviewProps {
  settings: WidgetSettings;
  widgetName: string;
}

export default function WidgetPreview({ settings, widgetName }: WidgetPreviewProps) {
  const [theme, setTheme] = useState<WidgetTheme>("light");
  const [device, setDevice] = useState<WidgetDevice>("desktop");
  const [state, setState] = useState<WidgetState>("open");

  const { appearance, chat, branding } = settings;

  // حساب الألوان بناءً على الثيم
  const bgColor = theme === "dark" ? "#1a1a1a" : appearance.backgroundColor;
  const textColor = theme === "dark" ? "#ffffff" : appearance.textColor;
  const headerBg = appearance.headerGradient.enabled
    ? `linear-gradient(${appearance.headerGradient.angle}deg, ${appearance.headerGradient.from}, ${appearance.headerGradient.to})`
    : appearance.primaryColor;

  // حساب الظل
  const shadowMap = {
    none: "none",
    light: "0 2px 8px rgba(0,0,0,0.1)",
    medium: "0 4px 16px rgba(0,0,0,0.15)",
    strong: "0 8px 32px rgba(0,0,0,0.25)",
  };

  // حساب الأبعاد بناءً على الجهاز
  const width = device === "mobile" ? "100%" : `${appearance.width}px`;
  const height = device === "mobile" ? "100%" : `${appearance.height}px`;

  return (
    <div className="flex flex-col h-full">
      {/* شريط التحكم */}
      <div className="flex items-center justify-between px-4 py-3 bg-pine/50 border-b border-verde/10">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setDevice("desktop")}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              device === "desktop" ? "bg-verde text-ink" : "bg-night/50 text-sage hover:text-bone"
            }`}
          >
            سطح المكتب
          </button>
          <button
            onClick={() => setDevice("mobile")}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              device === "mobile" ? "bg-verde text-ink" : "bg-night/50 text-sage hover:text-bone"
            }`}
          >
            جوال
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            className="px-3 py-1.5 rounded-lg text-xs font-bold bg-night/50 text-sage hover:text-bone transition-all"
          >
            {theme === "light" ? "🌙 داكن" : "☀️ فاتح"}
          </button>
          <button
            onClick={() => setState(state === "open" ? "closed" : "open")}
            className="px-3 py-1.5 rounded-lg text-xs font-bold bg-night/50 text-sage hover:text-bone transition-all"
          >
            {state === "open" ? "إغلاق" : "فتح"}
          </button>
        </div>
      </div>

      {/* منطقة المعاينة */}
      <div
        className="flex-1 flex items-center justify-center p-8 overflow-auto relative"
        style={{
          background: theme === "dark" ? "#0a0a0a" : "#f5f5f5",
        }}
      >
        {/* Launcher Button - يظهر دائماً في الزاوية */}
        <button
          className="absolute bottom-6 right-6 flex items-center justify-center text-white transition-all hover:scale-110 z-40"
          style={{
            width: `${appearance.launcher.size}px`,
            height: `${appearance.launcher.size}px`,
            background: appearance.primaryColor,
            borderRadius: appearance.launcher.shape === "circle" ? "50%" : appearance.launcher.shape === "rounded" ? "12px" : "4px",
            boxShadow: shadowMap[appearance.shadow],
          }}
          onClick={() => setState(state === "open" ? "closed" : "open")}
          aria-label="زر المحادثة"
        >
          {/* أيقونة chat */}
          {appearance.launcher.icon === "chat" && (
            <svg viewBox="0 0 24 24" className="w-7 h-7" fill="currentColor">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          )}
          {/* أيقونة message */}
          {appearance.launcher.icon === "message" && (
            <svg viewBox="0 0 24 24" className="w-7 h-7" fill="currentColor">
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
            </svg>
          )}
          {/* أيقونة support */}
          {appearance.launcher.icon === "support" && (
            <svg viewBox="0 0 24 24" className="w-7 h-7" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z" />
            </svg>
          )}
          {/* أيقونة help */}
          {appearance.launcher.icon === "help" && (
            <svg viewBox="0 0 24 24" className="w-7 h-7" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z" />
            </svg>
          )}
          {/* Badge */}
          {appearance.launcher.badge.enabled && appearance.launcher.badge.count > 0 && (
            <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-red-500 text-white text-xs flex items-center justify-center font-bold">
              {appearance.launcher.badge.count}
            </span>
          )}
        </button>

        {/* Widget Window */}
        {state === "open" && (
          <div
            className="relative overflow-hidden flex flex-col"
            style={{
              width,
              height,
              maxWidth: device === "mobile" ? "400px" : "none",
              maxHeight: device === "mobile" ? "700px" : "none",
              background: bgColor,
              borderRadius: `${appearance.borderRadius}px`,
              boxShadow: shadowMap[appearance.shadow],
              backdropFilter: appearance.blur > 0 ? `blur(${appearance.blur}px)` : "none",
              fontFamily: appearance.fontFamily === "system" ? "system-ui" : appearance.fontFamily,
              fontSize: `${appearance.fontSize}px`,
              color: textColor,
              direction: settings.localization.rtl ? "rtl" : "ltr",
            }}
          >
            {/* Header */}
            <div
              className="flex items-center gap-3 px-4 py-3"
              style={{ background: headerBg }}
            >
              {/* Avatar */}
              <div className="relative">
                {appearance.avatar.url ? (
                  <img
                    src={appearance.avatar.url}
                    alt={appearance.avatar.agentName}
                    className="w-10 h-10 rounded-full object-cover"
                  />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center text-white text-xl">
                    💬
                  </div>
                )}
                {appearance.avatar.statusIndicator && (
                  <div className="absolute bottom-0 right-0 w-3 h-3 rounded-full bg-green-400 border-2 border-white" />
                )}
              </div>

              {/* Agent Info */}
              <div className="flex-1 text-white">
                <p className="font-bold" style={{ fontWeight: appearance.headingWeight }}>
                  {appearance.avatar.agentName}
                </p>
                {appearance.avatar.agentTitle && (
                  <p className="text-xs opacity-90">{appearance.avatar.agentTitle}</p>
                )}
              </div>

              {/* Close Button */}
              <button className="text-white/80 hover:text-white transition-colors">
                <IconMinimize className="w-5 h-5" />
              </button>
            </div>

            {/* Messages Area */}
            <div
              className="flex-1 overflow-y-auto p-4 space-y-3"
              style={{ background: theme === "dark" ? "#2a2a2a" : "#f8f9fa" }}
            >
              {/* Welcome Message */}
              <div
                className="max-w-[80%] rounded-2xl px-4 py-3 shadow-sm"
                style={{
                  background: theme === "dark" ? "#3a3a3a" : "#ffffff",
                  color: textColor,
                  borderBottomLeftRadius: settings.localization.rtl ? "4px" : "20px",
                  borderBottomRightRadius: settings.localization.rtl ? "20px" : "4px",
                }}
              >
                <p className="text-sm leading-relaxed">{chat.welcomeMessage}</p>
              </div>

              {/* Quick Replies */}
              {chat.quickReplies.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-4">
                  {chat.quickReplies.slice(0, 3).map((reply) => (
                    <button
                      key={reply.id}
                      className="px-3 py-1.5 rounded-full text-xs font-medium transition-all hover:scale-105"
                      style={{
                        background: `${appearance.primaryColor}20`,
                        color: appearance.primaryColor,
                        border: `1px solid ${appearance.primaryColor}40`,
                      }}
                    >
                      {reply.text}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Input Area */}
            <div
              className="border-t px-3 py-3 flex items-center gap-2"
              style={{ borderColor: theme === "dark" ? "#3a3a3a" : "#e0e0e0" }}
            >
              <input
                type="text"
                placeholder={chat.placeholder}
                className="flex-1 px-4 py-2 rounded-full text-sm outline-none"
                style={{
                  background: theme === "dark" ? "#3a3a3a" : "#ffffff",
                  color: textColor,
                  border: `1px solid ${theme === "dark" ? "#4a4a4a" : "#e0e0e0"}`,
                }}
                readOnly
              />
              <button
                className="w-9 h-9 rounded-full flex items-center justify-center text-white transition-all hover:scale-105"
                style={{ background: appearance.primaryColor }}
              >
                <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor">
                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                </svg>
              </button>
            </div>

            {/* Branding Footer */}
            {branding.showBranding && (
              <div
                className="text-center py-2 text-xs"
                style={{
                  background: theme === "dark" ? "#2a2a2a" : "#ffffff",
                  color: theme === "dark" ? "#888" : "#999",
                  borderTop: `1px solid ${theme === "dark" ? "#3a3a3a" : "#e0e0e0"}`,
                }}
              >
                مدعوم بواسطة <span className="font-bold" style={{ color: appearance.primaryColor }}>ميلانو</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
