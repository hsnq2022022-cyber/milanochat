// ═══════════════════════════════════════════════════════════════════════════════
// WidgetEditor - محرر Widget المتقدم
// ═══════════════════════════════════════════════════════════════════════════════

import { useState, useEffect } from "react";
import type { Widget, WidgetSettings } from "../types/widget";
import { DEFAULT_SETTINGS, APPEARANCE_PRESETS } from "../types/widget";
import WidgetPreview from "./WidgetPreview";
import { API } from "../lib/api";
import {
  IconX,
  IconSave,
  IconUndo,
  IconRedo,
  IconCopy,
  IconCheck,
  IconSettings,
  IconPalette,
  IconMessage,
  IconToggle,
  IconCode,
  IconSparkle,
} from "./Icons";

type EditorTab =
  | "general"
  | "appearance"
  | "chat"
  | "behavior"
  | "forms"
  | "install";

interface WidgetEditorProps {
  widget: Widget | null;
  onSave: (name: string, settings: WidgetSettings) => Promise<void>;
  onClose: () => void;
  saving: boolean;
  authToken?: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// دمج الإعدادات مع القيم الافتراضية
// ═══════════════════════════════════════════════════════════════════════════════

function mergeWithDefaults(settings: any): WidgetSettings {
  return {
    appearance: {
      ...DEFAULT_SETTINGS.appearance,
      ...(settings?.appearance || {}),
    },
    chat: {
      ...DEFAULT_SETTINGS.chat,
      ...(settings?.chat || {}),
    },
    behavior: {
      ...DEFAULT_SETTINGS.behavior,
      ...(settings?.behavior || {}),
    },
    forms: {
      ...DEFAULT_SETTINGS.forms,
      ...(settings?.forms || {}),
    },
    localization: {
      ...DEFAULT_SETTINGS.localization,
      ...(settings?.localization || {}),
    },
    branding: {
      ...DEFAULT_SETTINGS.branding,
      ...(settings?.branding || {}),
    },
    chatWindow: {
      ...DEFAULT_SETTINGS.chatWindow,
      ...(settings?.chatWindow || {}),
    },
    avatar: {
      ...DEFAULT_SETTINGS.avatar,
      ...(settings?.avatar || {}),
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Widget Editor
// ═══════════════════════════════════════════════════════════════════════════════

export default function WidgetEditor({
  widget,
  onSave,
  onClose,
  saving,
  authToken,
}: WidgetEditorProps) {
  const [activeTab, setActiveTab] = useState<EditorTab>("general");
  const [name, setName] = useState(widget?.name ?? "");

  const [settings, setSettings] = useState<WidgetSettings>(
    mergeWithDefaults(widget?.settings)
  );

  const [history, setHistory] = useState<WidgetSettings[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [copiedCode, setCopiedCode] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // ═══════════════════════════════════════════════════════════════════════════
  // حفظ التغييرات في التاريخ
  // ═══════════════════════════════════════════════════════════════════════════

  useEffect(() => {
    const timeout = setTimeout(() => {
      setHistory((prev) => [
        ...prev.slice(0, historyIndex + 1),
        settings,
      ]);

      setHistoryIndex((prev) => prev + 1);
    }, 500);

    return () => clearTimeout(timeout);
  }, [settings]);

  // ═══════════════════════════════════════════════════════════════════════════
  // Undo
  // ═══════════════════════════════════════════════════════════════════════════

  const undo = () => {
    if (historyIndex > 0) {
      setHistoryIndex(historyIndex - 1);
      setSettings(history[historyIndex - 1]);
    }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // Redo
  // ═══════════════════════════════════════════════════════════════════════════

  const redo = () => {
    if (historyIndex < history.length - 1) {
      setHistoryIndex(historyIndex + 1);
      setSettings(history[historyIndex + 1]);
    }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // Validation
  // ═══════════════════════════════════════════════════════════════════════════

  const validate = () => {
    const newErrors: Record<string, string> = {};

    if (!name.trim()) {
      newErrors.name = "اسم الـ Widget مطلوب";
    }

    if (!/^#[0-9A-F]{6}$/i.test(settings.appearance.primaryColor)) {
      newErrors.primaryColor = "اللون غير صالح (HEX)";
    }

    setErrors(newErrors);

    return Object.keys(newErrors).length === 0;
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // Save
  // ═══════════════════════════════════════════════════════════════════════════

  const handleSave = async () => {
    if (!validate()) return;

    await onSave(name, settings);
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // Apply preset
  // ═══════════════════════════════════════════════════════════════════════════

  const applyPreset = (
    presetName: keyof typeof APPEARANCE_PRESETS
  ) => {
    const preset = APPEARANCE_PRESETS[presetName];

    setSettings({
      ...settings,
      appearance: {
        ...settings.appearance,
        ...preset,
      },
    });
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // Copy embed code
  // ═══════════════════════════════════════════════════════════════════════════

  const copyEmbedCode = () => {
    if (!widget) return;

    const code = `<script src="https://milanochat-production.up.railway.app/widget.js" data-token="${widget.public_token}"></script>`;

    navigator.clipboard.writeText(code);

    setCopiedCode(true);

    setTimeout(() => {
      setCopiedCode(false);
    }, 2000);
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // Update settings
  // ═══════════════════════════════════════════════════════════════════════════

  const updateSettings = (path: string, value: any) => {
    const keys = path.split(".");
    const newSettings = { ...settings };

    let current: any = newSettings;

    for (let i = 0; i < keys.length - 1; i++) {
      current[keys[i]] = {
        ...current[keys[i]],
      };

      current = current[keys[i]];
    }

    current[keys[keys.length - 1]] = value;

    setSettings(newSettings);
  };

  const tabs: {
    id: EditorTab;
    label: string;
    icon: any;
  }[] = [
    {
      id: "general",
      label: "عام",
      icon: IconSettings,
    },
    {
      id: "appearance",
      label: "المظهر",
      icon: IconPalette,
    },
    {
      id: "chat",
      label: "المحادثة",
      icon: IconMessage,
    },
    {
      id: "behavior",
      label: "السلوك",
      icon: IconToggle,
    },
    {
      id: "forms",
      label: "النماذج",
      icon: IconSparkle,
    },
    {
      id: "install",
      label: "التثبيت",
      icon: IconCode,
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex bg-night">
      {/* ══════════════════════════════════════════════════════════════════════
          Sidebar
      ══════════════════════════════════════════════════════════════════════ */}

      <div className="w-80 bg-pine border-l border-verde/15 flex flex-col">
        {/* Header */}

        <div className="p-4 border-b border-verde/15 flex items-center justify-between">
          <h2 className="font-display font-bold text-lg text-bone">
            {widget ? "تعديل Widget" : "إنشاء Widget"}
          </h2>

          <button
            onClick={onClose}
            className="text-sage hover:text-bone transition-colors"
          >
            <IconX className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}

        <div className="flex-1 overflow-y-auto">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`w-full flex items-center gap-3 px-4 py-3 text-right transition-all ${
                activeTab === tab.id
                  ? "bg-moss text-oro border-r-2 border-oro"
                  : "text-sage hover:bg-night/50 hover:text-bone"
              }`}
            >
              <tab.icon className="w-5 h-5" />

              <span className="font-semibold">
                {tab.label}
              </span>
            </button>
          ))}
        </div>

        {/* Footer */}

        <div className="p-4 border-t border-verde/15 flex gap-2">
          <button
            onClick={undo}
            disabled={historyIndex <= 0}
            className="btn-secondary flex-1"
          >
            <IconUndo className="w-4 h-4" />
          </button>

          <button
            onClick={redo}
            disabled={historyIndex >= history.length - 1}
            className="btn-secondary flex-1"
          >
            <IconRedo className="w-4 h-4" />
          </button>

          <button
            onClick={handleSave}
            disabled={saving}
            className="btn-primary flex-[2]"
          >
            <IconSave className="w-4 h-4" />

            {saving
              ? "جارٍ الحفظ..."
              : "حفظ"}
          </button>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          Main Content
      ══════════════════════════════════════════════════════════════════════ */}

      <div className="flex-1 flex flex-col">
        {/* Top Bar */}

        <div className="h-14 bg-pine/50 border-b border-verde/15 flex items-center justify-between px-6">
          <div className="flex items-center gap-4">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="اسم الـ Widget"
              className="bg-transparent border-none outline-none text-bone font-display font-bold text-lg placeholder:text-sage/50"
            />

            {errors.name && (
              <span className="text-oro text-xs">
                {errors.name}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 text-xs text-sage">
            <span className="w-2 h-2 rounded-full bg-verde animate-pulse" />
            حفظ تلقائي مفعّل
          </div>
        </div>

        {/* Content Area */}

        <div className="flex-1 flex overflow-hidden">
          {/* Settings */}

          <div className="w-96 border-l border-verde/15 overflow-y-auto p-6">
            {activeTab === "general" && (
              <GeneralTab
                name={name}
                setName={setName}
                settings={settings}
                updateSettings={updateSettings}
                errors={errors}
              />
            )}

            {activeTab === "appearance" && (
              <AppearanceTab
                widget={widget}
                settings={settings}
                updateSettings={updateSettings}
                applyPreset={applyPreset}
                errors={errors}
                authToken={authToken}
              />
            )}

            {activeTab === "chat" && (
              <ChatTab
                settings={settings}
                updateSettings={updateSettings}
              />
            )}

            {activeTab === "behavior" && (
              <BehaviorTab
                settings={settings}
                updateSettings={updateSettings}
              />
            )}

            {activeTab === "forms" && (
              <FormsTab
                settings={settings}
                updateSettings={updateSettings}
              />
            )}

            {activeTab === "install" && widget && (
              <InstallTab
                widget={widget}
                copiedCode={copiedCode}
                copyEmbedCode={copyEmbedCode}
              />
            )}
          </div>

          {/* Preview */}

          <div className="flex-1 bg-bone">
            <WidgetPreview
              settings={settings}
              widgetName={name}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// General Tab
// ═══════════════════════════════════════════════════════════════════════════════

function GeneralTab({
  name,
  setName,
  settings,
  updateSettings,
  errors,
}: any) {
  return (
    <div className="space-y-6">
      <div>
        <label className="text-xs text-sage mb-2 block">
          اسم الـ Widget *
        </label>

        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="input-field"
          placeholder="مثال: Widget الموقع الرئيسي"
        />

        {errors.name && (
          <p className="text-oro text-xs mt-1">
            {errors.name}
          </p>
        )}
      </div>

      <div>
        <label className="text-xs text-sage mb-2 block">
          اللغة
        </label>

        <select
          value={settings.localization.language}
          onChange={(e) =>
            updateSettings(
              "localization.language",
              e.target.value
            )
          }
          className="input-field"
        >
          <option value="ar">العربية</option>
          <option value="en">English</option>
        </select>
      </div>

      <div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.localization.rtl}
            onChange={(e) =>
              updateSettings(
                "localization.rtl",
                e.target.checked
              )
            }
            className="w-4 h-4 accent-verde"
          />

          <span className="text-sm text-bone">
            اتجاه من اليمين لليسار (RTL)
          </span>
        </label>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Appearance Tab
// ═══════════════════════════════════════════════════════════════════════════════

function AppearanceTab({
  widget,
  settings,
  updateSettings,
  applyPreset,
  errors,
  authToken,
}: any) {
  // ═══════════════════════════════════════════════════════════════════════════
  // رفع الصور
  // ═══════════════════════════════════════════════════════════════════════════

  const handleImageUpload = async (
    type: "logo" | "avatar",
    file: File
  ) => {
    // ------------------------------------------------------------
    // التحقق من Widget ID
    // ------------------------------------------------------------

    if (!widget?.id) {
      alert(
        "يجب حفظ الـ Widget أولاً قبل رفع الصورة.\n\nاحفظ الـ Widget ثم افتح التعديل مرة أخرى لرفع الشعار أو صورة المساعد."
      );

      return;
    }

    // ------------------------------------------------------------
    // التحقق من تسجيل الدخول
    // ------------------------------------------------------------

    if (!authToken) {
      alert("يجب تسجيل الدخول أولاً");
      return;
    }

    // ------------------------------------------------------------
    // التحقق من نوع الملف
    // ------------------------------------------------------------

    if (!file.type.startsWith("image/")) {
      alert("الملف المحدد ليس صورة صالحة");
      return;
    }

    // ------------------------------------------------------------
    // الحد الأقصى 1MB
    // ------------------------------------------------------------

    if (file.size > 1024 * 1024) {
      alert("حجم الملف يتجاوز 1MB");
      return;
    }

    // ------------------------------------------------------------
    // تحويل الصورة إلى Base64
    // ------------------------------------------------------------

    const reader = new FileReader();

    reader.onload = async () => {
      try {
        const result = reader.result as string;

        if (!result || !result.includes(",")) {
          throw new Error("تعذر قراءة الصورة");
        }

        const base64 = result.split(",")[1];

        if (!base64) {
          throw new Error("تعذر تحويل الصورة");
        }

        // ----------------------------------------------------------
        // رفع الصورة
        //
        // مهم:
        // widget_id يتم إرساله الآن بشكل صريح.
        // ----------------------------------------------------------

        const res = await fetch(
          `${API}/api/widgets/dashboard/upload`,
          {
            method: "POST",

            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${authToken}`,
            },

            body: JSON.stringify({
              widget_id: widget.id,

              type,

              data: base64,

              // اسم الملف الأصلي
              original_name: file.name,

              // الاحتفاظ أيضًا بالاسم القديم للتوافق
              name: file.name,

              // حجم الملف
              size_bytes: file.size,

              // الاحتفاظ أيضًا بالحقل القديم للتوافق
              size: file.size,

              // MIME type
              mime_type: file.type,

              // الاحتفاظ أيضًا بالحقل القديم للتوافق
              mimeType: file.type,
            }),
          }
        );

        // ----------------------------------------------------------
        // معالجة HTTP errors
        // ----------------------------------------------------------

        if (!res.ok) {
          let errorMessage = "فشل رفع الصورة";

          try {
            const errorData = await res.json();

            errorMessage =
              errorData?.error ||
              errorData?.message ||
              errorMessage;
          } catch {
            // تجاهل خطأ JSON إذا كانت الاستجابة غير JSON
          }

          throw new Error(errorMessage);
        }

        // ----------------------------------------------------------
        // قراءة النتيجة
        // ----------------------------------------------------------

        const data = await res.json();

        if (!data?.url) {
          throw new Error(
            "تم رفع الصورة ولكن لم يُرجع الخادم رابط الصورة"
          );
        }

        // ----------------------------------------------------------
        // تحديث إعدادات Widget
        // ----------------------------------------------------------

        if (type === "logo") {
          updateSettings(
            "avatar.headerLogo.url",
            data.url
          );
        } else {
          updateSettings(
            "avatar.botAvatar.url",
            data.url
          );
        }

        alert(
          type === "logo"
            ? "تم رفع شعار المشروع بنجاح"
            : "تم رفع صورة المساعد بنجاح"
        );
      } catch (err: any) {
        console.error(
          "Widget image upload error:",
          err
        );

        alert(
          err?.message ||
            "تعذر رفع الصورة"
        );
      }
    };

    reader.onerror = () => {
      alert("تعذر قراءة ملف الصورة");
    };

    reader.readAsDataURL(file);
  };

  return (
    <div className="space-y-6">
      {/* ══════════════════════════════════════════════════════════════════════
          Logo Upload
      ══════════════════════════════════════════════════════════════════════ */}

      <div>
        <label className="text-xs text-sage mb-2 block">
          Logo المشروع
        </label>

        {!widget && (
          <div className="mb-3 p-3 rounded-lg bg-oro/10 border border-oro/20">
            <p className="text-xs text-oro">
              احفظ الـ Widget أولاً حتى يصبح له معرف خاص ويمكن رفع الصورة.
            </p>
          </div>
        )}

        <div className="flex items-center gap-3">
          {settings.avatar?.headerLogo?.url && (
            <img
              src={settings.avatar.headerLogo.url}
              alt="Logo"
              className="w-16 h-16 rounded-lg object-cover border border-verde/20"
            />
          )}

          <input
            type="file"
            accept="image/*"
            disabled={!widget || !authToken}
            onChange={(e) => {
              const file = e.target.files?.[0];

              if (file) {
                handleImageUpload("logo", file);
              }

              // السماح باختيار نفس الملف مرة أخرى
              e.currentTarget.value = "";
            }}
            className="text-xs text-sage disabled:opacity-50 disabled:cursor-not-allowed"
          />
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          Avatar Upload
      ══════════════════════════════════════════════════════════════════════ */}

      <div>
        <label className="text-xs text-sage mb-2 block">
          صورة المساعد (Avatar)
        </label>

        <div className="flex items-center gap-3">
          {settings.avatar?.botAvatar?.url && (
            <img
              src={settings.avatar.botAvatar.url}
              alt="Avatar"
              className="w-16 h-16 rounded-full object-cover border border-verde/20"
            />
          )}

          <input
            type="file"
            accept="image/*"
            disabled={!widget || !authToken}
            onChange={(e) => {
              const file = e.target.files?.[0];

              if (file) {
                handleImageUpload("avatar", file);
              }

              // السماح باختيار نفس الملف مرة أخرى
              e.currentTarget.value = "";
            }}
            className="text-xs text-sage disabled:opacity-50 disabled:cursor-not-allowed"
          />
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          Presets
      ══════════════════════════════════════════════════════════════════════ */}

      <div>
        <label className="text-xs text-sage mb-2 block">
          قوالب جاهزة
        </label>

        <div className="grid grid-cols-2 gap-2">
          {Object.keys(APPEARANCE_PRESETS).map(
            (preset) => (
              <button
                key={preset}
                onClick={() =>
                  applyPreset(preset)
                }
                className="px-3 py-2 rounded-lg bg-night/50 text-sage hover:text-bone hover:bg-night text-xs font-bold transition-all"
              >
                {preset}
              </button>
            )
          )}
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          Primary Color
      ══════════════════════════════════════════════════════════════════════ */}

      <div>
        <label className="text-xs text-sage mb-2 block">
          اللون الأساسي
        </label>

        <div className="flex gap-2">
          <input
            type="color"
            value={
              settings.appearance.primaryColor
            }
            onChange={(e) =>
              updateSettings(
                "appearance.primaryColor",
                e.target.value
              )
            }
            className="w-12 h-10 rounded-lg border border-verde/20 cursor-pointer"
          />

          <input
            type="text"
            value={
              settings.appearance.primaryColor
            }
            onChange={(e) =>
              updateSettings(
                "appearance.primaryColor",
                e.target.value
              )
            }
            className="input-field flex-1"
          />
        </div>

        {errors.primaryColor && (
          <p className="text-oro text-xs mt-1">
            {errors.primaryColor}
          </p>
        )}
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          Font Family
      ══════════════════════════════════════════════════════════════════════ */}

      <div>
        <label className="text-xs text-sage mb-2 block">
          الخط
        </label>

        <select
          value={settings.appearance.fontFamily}
          onChange={(e) =>
            updateSettings(
              "appearance.fontFamily",
              e.target.value
            )
          }
          className="input-field"
        >
          <option value="Cairo">Cairo</option>
          <option value="Tajawal">Tajawal</option>
          <option value="IBM Plex Arabic">
            IBM Plex Arabic
          </option>
          <option value="system">
            System Default
          </option>
        </select>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          Border Radius
      ══════════════════════════════════════════════════════════════════════ */}

      <div>
        <label className="text-xs text-sage mb-2 block">
          نصف قطر الزوايا:{" "}
          {settings.appearance.borderRadius}px
        </label>

        <input
          type="range"
          min="0"
          max="32"
          value={
            settings.appearance.borderRadius
          }
          onChange={(e) =>
            updateSettings(
              "appearance.borderRadius",
              parseInt(e.target.value)
            )
          }
          className="w-full accent-verde"
        />
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          Shadow
      ══════════════════════════════════════════════════════════════════════ */}

      <div>
        <label className="text-xs text-sage mb-2 block">
          الظل
        </label>

        <select
          value={settings.appearance.shadow}
          onChange={(e) =>
            updateSettings(
              "appearance.shadow",
              e.target.value
            )
          }
          className="input-field"
        >
          <option value="none">بدون</option>
          <option value="light">خفيف</option>
          <option value="medium">متوسط</option>
          <option value="strong">قوي</option>
        </select>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          Position
      ══════════════════════════════════════════════════════════════════════ */}

      <div>
        <label className="text-xs text-sage mb-2 block">
          الموقع
        </label>

        <div className="flex gap-2">
          <button
            onClick={() =>
              updateSettings(
                "appearance.position",
                "left"
              )
            }
            className={`flex-1 py-2 rounded-lg text-sm font-bold ${
              settings.appearance.position === "left"
                ? "bg-verde text-ink"
                : "bg-night/50 text-sage"
            }`}
          >
            يسار
          </button>

          <button
            onClick={() =>
              updateSettings(
                "appearance.position",
                "right"
              )
            }
            className={`flex-1 py-2 rounded-lg text-sm font-bold ${
              settings.appearance.position === "right"
                ? "bg-verde text-ink"
                : "bg-night/50 text-sage"
            }`}
          >
            يمين
          </button>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          Branding
      ══════════════════════════════════════════════════════════════════════ */}

      <div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={
              settings.branding.showBranding
            }
            onChange={(e) =>
              updateSettings(
                "branding.showBranding",
                e.target.checked
              )
            }
            className="w-4 h-4 accent-verde"
          />

          <span className="text-sm text-bone">
            إظهار "مدعوم بواسطة ميلانو"
          </span>
        </label>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Chat Tab
// ═══════════════════════════════════════════════════════════════════════════════

function ChatTab({
  settings,
  updateSettings,
}: any) {
  return (
    <div className="space-y-6">
      <div>
        <label className="text-xs text-sage mb-2 block">
          رسالة الترحيب
        </label>

        <textarea
          value={
            settings.chat.welcomeMessage
          }
          onChange={(e) =>
            updateSettings(
              "chat.welcomeMessage",
              e.target.value
            )
          }
          className="input-field resize-none"
          rows={3}
        />
      </div>

      <div>
        <label className="text-xs text-sage mb-2 block">
          Placeholder
        </label>

        <input
          type="text"
          value={
            settings.chat.placeholder
          }
          onChange={(e) =>
            updateSettings(
              "chat.placeholder",
              e.target.value
            )
          }
          className="input-field"
        />
      </div>

      <div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={
              settings.chat.showTypingIndicator
            }
            onChange={(e) =>
              updateSettings(
                "chat.showTypingIndicator",
                e.target.checked
              )
            }
            className="w-4 h-4 accent-verde"
          />

          <span className="text-sm text-bone">
            إظهار مؤشر الكتابة
          </span>
        </label>
      </div>

      <div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={
              settings.chat.showReadReceipts
            }
            onChange={(e) =>
              updateSettings(
                "chat.showReadReceipts",
                e.target.checked
              )
            }
            className="w-4 h-4 accent-verde"
          />

          <span className="text-sm text-bone">
            إظهار إيصالات القراءة
          </span>
        </label>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Behavior Tab
// ═══════════════════════════════════════════════════════════════════════════════

function BehaviorTab({
  settings,
  updateSettings,
}: any) {
  return (
    <div className="space-y-6">
      <div>
        <label className="text-xs text-sage mb-2 block">
          الفتح التلقائي
        </label>

        <select
          value={
            settings.behavior.autoOpen.trigger
          }
          onChange={(e) =>
            updateSettings(
              "behavior.autoOpen.trigger",
              e.target.value
            )
          }
          className="input-field"
        >
          <option value="disabled">
            معطّل
          </option>

          <option value="delay">
            بعد تأخير
          </option>

          <option value="exit_intent">
            عند نية الخروج
          </option>

          <option value="scroll">
            عند التمرير
          </option>
        </select>
      </div>

      {settings.behavior.autoOpen.trigger ===
        "delay" && (
        <div>
          <label className="text-xs text-sage mb-2 block">
            التأخير (ثواني)
          </label>

          <input
            type="number"
            value={
              settings.behavior.autoOpen.delay ??
              5
            }
            onChange={(e) =>
              updateSettings(
                "behavior.autoOpen.delay",
                parseInt(e.target.value)
              )
            }
            className="input-field"
          />
        </div>
      )}

      <div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={
              settings.behavior.sound.enabled
            }
            onChange={(e) =>
              updateSettings(
                "behavior.sound.enabled",
                e.target.checked
              )
            }
            className="w-4 h-4 accent-verde"
          />

          <span className="text-sm text-bone">
            تفعيل صوت التنبيه
          </span>
        </label>
      </div>

      <div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={
              settings.behavior.visibility
                .hideOnMobile
            }
            onChange={(e) =>
              updateSettings(
                "behavior.visibility.hideOnMobile",
                e.target.checked
              )
            }
            className="w-4 h-4 accent-verde"
          />

          <span className="text-sm text-bone">
            إخفاء على الجوال
          </span>
        </label>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Forms Tab
// ═══════════════════════════════════════════════════════════════════════════════

function FormsTab({
  settings,
  updateSettings,
}: any) {
  return (
    <div className="space-y-6">
      <div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={
              settings.forms.preChat.enabled
            }
            onChange={(e) =>
              updateSettings(
                "forms.preChat.enabled",
                e.target.checked
              )
            }
            className="w-4 h-4 accent-verde"
          />

          <span className="text-sm text-bone">
            تفعيل نموذج ما قبل المحادثة
          </span>
        </label>

        <p className="text-xs text-sage mt-2">
          اطلب معلومات من الزائر قبل بدء
          المحادثة (الاسم، البريد، إلخ)
        </p>
      </div>

      <div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={
              settings.forms.offlineForm.enabled
            }
            onChange={(e) =>
              updateSettings(
                "forms.offlineForm.enabled",
                e.target.checked
              )
            }
            className="w-4 h-4 accent-verde"
          />

          <span className="text-sm text-bone">
            تفعيل نموذج ترك رسالة
          </span>
        </label>

        <p className="text-xs text-sage mt-2">
          اسمح للزوار بترك رسالة عند عدم
          توفر الوكلاء
        </p>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Install Tab
// ═══════════════════════════════════════════════════════════════════════════════

function InstallTab({
  widget,
  copiedCode,
  copyEmbedCode,
}: any) {
  const embedCode = `<script src="https://milanochat-production.up.railway.app/widget.js" data-token="${widget.public_token}"></script>`;

  return (
    <div className="space-y-6">
      <div>
        <label className="text-xs text-sage mb-2 block">
          كود التضمين
        </label>

        <div className="bg-night/50 border border-verde/15 rounded-lg p-3">
          <code
            className="text-xs text-verde break-all"
            dir="ltr"
          >
            {embedCode}
          </code>
        </div>

        <button
          onClick={copyEmbedCode}
          className="btn-secondary w-full mt-2 flex items-center justify-center gap-2"
        >
          {copiedCode ? (
            <>
              <IconCheck className="w-4 h-4" />
              تم النسخ
            </>
          ) : (
            <>
              <IconCopy className="w-4 h-4" />
              نسخ الكود
            </>
          )}
        </button>
      </div>

      <div>
        <label className="text-xs text-sage mb-2 block">
          تعليمات التثبيت
        </label>

        <div className="space-y-3 text-xs text-sage">
          <div>
            <p className="font-bold text-bone mb-1">
              WordPress:
            </p>

            <p>
              أضف الكود إلى ملف footer.php أو
              استخدم إضافة "Insert Headers and Footers"
            </p>
          </div>

          <div>
            <p className="font-bold text-bone mb-1">
              Shopify:
            </p>

            <p>
              أضف الكود إلى theme.liquid قبل
              إغلاق &lt;/body&gt;
            </p>
          </div>

          <div>
            <p className="font-bold text-bone mb-1">
              React:
            </p>

            <p>
              أضف الكود إلى public/index.html
              أو استخدم useEffect
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
