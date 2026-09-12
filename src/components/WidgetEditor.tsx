// ═══════════════════════════════════════════════════════════════════════════════
// WidgetEditor - محرر Widget المتقدم
// ═══════════════════════════════════════════════════════════════════════════════

import { useState, useEffect } from "react";
import type { Widget, WidgetSettings } from "../types/widget";
import {
  DEFAULT_SETTINGS,
  APPEARANCE_PRESETS,
} from "../types/widget";
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
  onSave: (
    name: string,
    settings: WidgetSettings
  ) => Promise<void>;
  onClose: () => void;
  saving: boolean;
  authToken?: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// دمج الإعدادات مع القيم الافتراضية
// ═══════════════════════════════════════════════════════════════════════════════

function mergeWithDefaults(
  settings: any
): WidgetSettings {
  return {
    appearance: {
      ...DEFAULT_SETTINGS.appearance,
      ...(settings?.appearance || {}),

      headerGradient: {
        ...DEFAULT_SETTINGS.appearance.headerGradient,
        ...(settings?.appearance?.headerGradient || {}),
      },

      launcher: {
        ...DEFAULT_SETTINGS.appearance.launcher,
        ...(settings?.appearance?.launcher || {}),
        badge: {
          ...DEFAULT_SETTINGS.appearance.launcher.badge,
          ...(settings?.appearance?.launcher?.badge || {}),
        },
      },

      avatar: {
        ...DEFAULT_SETTINGS.appearance.avatar,
        ...(settings?.appearance?.avatar || {}),
      },

      offset: {
        ...DEFAULT_SETTINGS.appearance.offset,
        ...(settings?.appearance?.offset || {}),
      },
    },

    chat: {
      ...DEFAULT_SETTINGS.chat,
      ...(settings?.chat || {}),
      quickReplies: Array.isArray(
        settings?.chat?.quickReplies
      )
        ? settings.chat.quickReplies
        : DEFAULT_SETTINGS.chat.quickReplies,
    },

    behavior: {
      ...DEFAULT_SETTINGS.behavior,
      ...(settings?.behavior || {}),

      autoOpen: {
        ...DEFAULT_SETTINGS.behavior.autoOpen,
        ...(settings?.behavior?.autoOpen || {}),
      },

      sound: {
        ...DEFAULT_SETTINGS.behavior.sound,
        ...(settings?.behavior?.sound || {}),
      },

      visibility: {
        ...DEFAULT_SETTINGS.behavior.visibility,
        ...(settings?.behavior?.visibility || {}),
      },
    },

    forms: {
      ...DEFAULT_SETTINGS.forms,
      ...(settings?.forms || {}),

      preChat: {
        ...DEFAULT_SETTINGS.forms.preChat,
        ...(settings?.forms?.preChat || {}),
      },

      offlineForm: {
        ...DEFAULT_SETTINGS.forms.offlineForm,
        ...(settings?.forms?.offlineForm || {}),
      },
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

      headerLogo: {
        ...DEFAULT_SETTINGS.avatar.headerLogo,
        ...(settings?.avatar?.headerLogo || {}),
      },

      botAvatar: {
        ...DEFAULT_SETTINGS.avatar.botAvatar,
        ...(settings?.avatar?.botAvatar || {}),
      },

      typingIndicator: {
        ...DEFAULT_SETTINGS.avatar.typingIndicator,
        ...(settings?.avatar?.typingIndicator || {}),
      },
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
  const [activeTab, setActiveTab] =
    useState<EditorTab>("general");

  const [name, setName] = useState(
    widget?.name ?? ""
  );

  const [settings, setSettings] =
    useState<WidgetSettings>(
      mergeWithDefaults(widget?.settings)
    );

  const [history, setHistory] =
    useState<WidgetSettings[]>([]);

  const [historyIndex, setHistoryIndex] =
    useState(-1);

  const [copiedCode, setCopiedCode] =
    useState(false);

  const [errors, setErrors] =
    useState<Record<string, string>>({});

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
      setSettings(
        history[historyIndex - 1]
      );
    }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // Redo
  // ═══════════════════════════════════════════════════════════════════════════

  const redo = () => {
    if (
      historyIndex <
      history.length - 1
    ) {
      setHistoryIndex(historyIndex + 1);
      setSettings(
        history[historyIndex + 1]
      );
    }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // Validation
  // ═══════════════════════════════════════════════════════════════════════════

  const validate = () => {
    const newErrors: Record<
      string,
      string
    > = {};

    if (!name.trim()) {
      newErrors.name =
        "اسم الـ Widget مطلوب";
    }

    if (
      !/^#[0-9A-F]{6}$/i.test(
        settings.appearance.primaryColor
      )
    ) {
      newErrors.primaryColor =
        "اللون غير صالح (HEX)";
    }

    setErrors(newErrors);

    return (
      Object.keys(newErrors).length === 0
    );
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // Save
  // ═══════════════════════════════════════════════════════════════════════════

  const handleSave = async () => {
    if (!validate()) return;

    await onSave(name.trim(), settings);
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // Apply preset
  // ═══════════════════════════════════════════════════════════════════════════

  const applyPreset = (
    presetName: keyof typeof APPEARANCE_PRESETS
  ) => {
    const preset =
      APPEARANCE_PRESETS[presetName];

    setSettings({
      ...settings,
      appearance: {
        ...settings.appearance,
        ...preset,
        launcher: {
          ...settings.appearance.launcher,
          ...(preset as any).launcher,
        },
      },
    });
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // Copy embed code
  // ═══════════════════════════════════════════════════════════════════════════

  const copyEmbedCode = async () => {
    if (!widget) return;

    const code =
      `<script src="https://milanochat-production.up.railway.app/widget.js" data-token="${widget.public_token}"></script>`;

    try {
      await navigator.clipboard.writeText(
        code
      );

      setCopiedCode(true);

      setTimeout(() => {
        setCopiedCode(false);
      }, 2000);
    } catch (error) {
      console.error(
        "Failed to copy embed code:",
        error
      );
    }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // Update settings
  // ═══════════════════════════════════════════════════════════════════════════

  const updateSettings = (
    path: string,
    value: any
  ) => {
    const keys = path.split(".");

    const newSettings: any = {
      ...settings,
    };

    let current: any =
      newSettings;

    for (
      let i = 0;
      i < keys.length - 1;
      i++
    ) {
      current[keys[i]] = {
        ...(current[keys[i]] || {}),
      };

      current =
        current[keys[i]];
    }

    current[
      keys[keys.length - 1]
    ] = value;

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
        <div className="p-4 border-b border-verde/15 flex items-center justify-between">
          <h2 className="font-display font-bold text-lg text-bone">
            {widget
              ? "تعديل Widget"
              : "إنشاء Widget"}
          </h2>

          <button
            type="button"
            onClick={onClose}
            className="text-sage hover:text-bone transition-colors"
          >
            <IconX className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {tabs.map((tab) => (
            <button
              type="button"
              key={tab.id}
              onClick={() =>
                setActiveTab(tab.id)
              }
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

        <div className="p-4 border-t border-verde/15 flex gap-2">
          <button
            type="button"
            onClick={undo}
            disabled={historyIndex <= 0}
            className="btn-secondary flex-1"
          >
            <IconUndo className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={redo}
            disabled={
              historyIndex >=
              history.length - 1
            }
            className="btn-secondary flex-1"
          >
            <IconRedo className="w-4 h-4" />
          </button>

          <button
            type="button"
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
        <div className="h-14 bg-pine/50 border-b border-verde/15 flex items-center justify-between px-6">
          <div className="flex items-center gap-4">
            <input
              type="text"
              value={name}
              onChange={(e) =>
                setName(e.target.value)
              }
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

        <div className="flex-1 flex overflow-hidden">
          <div className="w-96 border-l border-verde/15 overflow-y-auto p-6">
            {activeTab === "general" && (
              <GeneralTab
                name={name}
                setName={setName}
                settings={settings}
                updateSettings={
                  updateSettings
                }
                errors={errors}
              />
            )}

            {activeTab === "appearance" && (
              <AppearanceTab
                widget={widget}
                settings={settings}
                updateSettings={
                  updateSettings
                }
                applyPreset={applyPreset}
                errors={errors}
                authToken={authToken}
              />
            )}

            {activeTab === "chat" && (
              <ChatTab
                settings={settings}
                updateSettings={
                  updateSettings
                }
              />
            )}

            {activeTab === "behavior" && (
              <BehaviorTab
                settings={settings}
                updateSettings={
                  updateSettings
                }
              />
            )}

            {activeTab === "forms" && (
              <FormsTab
                settings={settings}
                updateSettings={
                  updateSettings
                }
              />
            )}

            {activeTab === "install" &&
              widget && (
                <InstallTab
                  widget={widget}
                  copiedCode={copiedCode}
                  copyEmbedCode={
                    copyEmbedCode
                  }
                />
              )}
          </div>

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
          onChange={(e) =>
            setName(e.target.value)
          }
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
          value={
            settings.localization.language
          }
          onChange={(e) =>
            updateSettings(
              "localization.language",
              e.target.value
            )
          }
          className="input-field"
        >
          <option value="ar">
            العربية
          </option>

          <option value="en">
            English
          </option>
        </select>
      </div>

      <div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={
              settings.localization.rtl
            }
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
    type:
      | "logo"
      | "avatar"
      | "launcher_icon",
    file: File
  ) => {
    if (!widget?.id) {
      alert(
        "احفظ الـ Widget أولاً حتى يمكن رفع الصورة."
      );
      return;
    }

    if (!authToken) {
      alert(
        "يجب تسجيل الدخول أولاً"
      );
      return;
    }

    if (!file.type.startsWith("image/")) {
      alert(
        "الملف المحدد ليس صورة صالحة"
      );
      return;
    }

    if (file.size > 1024 * 1024) {
      alert(
        "حجم الملف يتجاوز 1MB"
      );
      return;
    }

    try {
      const formData = new FormData();

      formData.append(
        "file",
        file
      );

      // Backend expects "widget_id".
      formData.append(
        "widget_id",
        String(widget.id)
      );

      formData.append(
        "type",
        type
      );

      const baseUrl = String(API).replace(
        /\/$/,
        ""
      );

      const response =
        await fetch(
          `${baseUrl}/api/widgets/dashboard/upload`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${authToken}`,
            },
            body: formData,
          }
        );

      let data: any = null;

      try {
        data = await response.json();
      } catch {
        data = null;
      }

      if (!response.ok) {
        throw new Error(
          data?.error ||
            data?.message ||
            "فشل رفع الصورة"
        );
      }

      if (!data?.url) {
        throw new Error(
          "تم رفع الصورة ولكن لم يُرجع الخادم رابط الصورة"
        );
      }

      // ═════════════════════════════════════════════════════════════════════
      // تحديث الإعداد المناسب
      // ═════════════════════════════════════════════════════════════════════

      if (type === "logo") {
        updateSettings(
          "avatar.headerLogo.url",
          data.url
        );

        alert(
          "تم رفع شعار المشروع بنجاح"
        );

        return;
      }

      if (type === "avatar") {
        updateSettings(
          "avatar.botAvatar.url",
          data.url
        );

        alert(
          "تم رفع صورة المساعد بنجاح"
        );

        return;
      }

      if (type === "launcher_icon") {
        updateSettings(
          "appearance.launcher.customIcon",
          data.url
        );

        updateSettings(
          "appearance.launcher.icon",
          "custom"
        );

        alert(
          "تم رفع أيقونة الزر العائم بنجاح"
        );
      }
    } catch (error: any) {
      console.error(
        "Widget image upload error:",
        error
      );

      alert(
        error?.message ||
          "تعذر رفع الصورة"
      );
    }
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
          {settings.avatar
            ?.headerLogo
            ?.url && (
            <img
              src={
                settings.avatar
                  .headerLogo.url
              }
              alt="Logo"
              className="w-16 h-16 rounded-lg object-cover border border-verde/20"
            />
          )}

          <input
            type="file"
            accept="image/*"
            disabled={
              !widget ||
              !authToken
            }
            onChange={(e) => {
              const file =
                e.target.files?.[0];

              if (file) {
                void handleImageUpload(
                  "logo",
                  file
                );
              }

              e.currentTarget.value =
                "";
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
          {settings.avatar
            ?.botAvatar
            ?.url && (
            <img
              src={
                settings.avatar
                  .botAvatar.url
              }
              alt="Avatar"
              className="w-16 h-16 rounded-full object-cover border border-verde/20"
            />
          )}

          <input
            type="file"
            accept="image/*"
            disabled={
              !widget ||
              !authToken
            }
            onChange={(e) => {
              const file =
                e.target.files?.[0];

              if (file) {
                void handleImageUpload(
                  "avatar",
                  file
                );
              }

              e.currentTarget.value =
                "";
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
          {Object.keys(
            APPEARANCE_PRESETS
          ).map((preset) => (
            <button
              type="button"
              key={preset}
              onClick={() =>
                applyPreset(
                  preset
                )
              }
              className="px-3 py-2 rounded-lg bg-night/50 text-sage hover:text-bone hover:bg-night text-xs font-bold transition-all"
            >
              {preset}
            </button>
          ))}
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
              settings.appearance
                .primaryColor
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
              settings.appearance
                .primaryColor
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
          Launcher Settings
      ══════════════════════════════════════════════════════════════════════ */}

      <div className="border-t border-verde/10 pt-6">
        <label className="text-sm font-bold text-bone mb-4 block">
          إعدادات زر المحادثة
        </label>

        {/* Launcher Size */}

        <div className="mb-4">
          <label className="text-xs text-sage mb-2 block">
            حجم الزر:{" "}
            {
              settings.appearance
                .launcher.size
            }
            px
          </label>

          <input
            type="range"
            min="48"
            max="80"
            value={
              settings.appearance
                .launcher.size
            }
            onChange={(e) =>
              updateSettings(
                "appearance.launcher.size",
                parseInt(
                  e.target.value,
                  10
                )
              )
            }
            className="w-full accent-verde"
          />
        </div>

        {/* Launcher Shape */}

        <div className="mb-4">
          <label className="text-xs text-sage mb-2 block">
            شكل الزر
          </label>

          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={() =>
                updateSettings(
                  "appearance.launcher.shape",
                  "circle"
                )
              }
              className={`py-2 rounded-lg text-xs font-bold transition-all ${
                settings.appearance
                  .launcher.shape ===
                "circle"
                  ? "bg-verde text-ink"
                  : "bg-night/50 text-sage hover:text-bone"
              }`}
            >
              دائري
            </button>

            <button
              type="button"
              onClick={() =>
                updateSettings(
                  "appearance.launcher.shape",
                  "square"
                )
              }
              className={`py-2 rounded-lg text-xs font-bold transition-all ${
                settings.appearance
                  .launcher.shape ===
                "square"
                  ? "bg-verde text-ink"
                  : "bg-night/50 text-sage hover:text-bone"
              }`}
            >
              مربع
            </button>

            <button
              type="button"
              onClick={() =>
                updateSettings(
                  "appearance.launcher.shape",
                  "rounded"
                )
              }
              className={`py-2 rounded-lg text-xs font-bold transition-all ${
                settings.appearance
                  .launcher.shape ===
                "rounded"
                  ? "bg-verde text-ink"
                  : "bg-night/50 text-sage hover:text-bone"
              }`}
            >
              مستدير
            </button>
          </div>
        </div>

        {/* Launcher Icon */}

        <div className="mb-4">
          <label className="text-xs text-sage mb-2 block">
            أيقونة الزر
          </label>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() =>
                updateSettings(
                  "appearance.launcher.icon",
                  "chat"
                )
              }
              className={`flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-bold transition-all ${
                settings.appearance
                  .launcher.icon ===
                "chat"
                  ? "bg-verde text-ink"
                  : "bg-night/50 text-sage hover:text-bone"
              }`}
            >
              <svg
                viewBox="0 0 24 24"
                className="w-4 h-4"
                fill="currentColor"
              >
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              محادثة
            </button>

            <button
              type="button"
              onClick={() =>
                updateSettings(
                  "appearance.launcher.icon",
                  "message"
                )
              }
              className={`flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-bold transition-all ${
                settings.appearance
                  .launcher.icon ===
                "message"
                  ? "bg-verde text-ink"
                  : "bg-night/50 text-sage hover:text-bone"
              }`}
            >
              <svg
                viewBox="0 0 24 24"
                className="w-4 h-4"
                fill="currentColor"
              >
                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
              </svg>
              رسالة
            </button>

            <button
              type="button"
              onClick={() =>
                updateSettings(
                  "appearance.launcher.icon",
                  "support"
                )
              }
              className={`flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-bold transition-all ${
                settings.appearance
                  .launcher.icon ===
                "support"
                  ? "bg-verde text-ink"
                  : "bg-night/50 text-sage hover:text-bone"
              }`}
            >
              <svg
                viewBox="0 0 24 24"
                className="w-4 h-4"
                fill="currentColor"
              >
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z" />
              </svg>
              دعم
            </button>

            <button
              type="button"
              onClick={() =>
                updateSettings(
                  "appearance.launcher.icon",
                  "help"
                )
              }
              className={`flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-bold transition-all ${
                settings.appearance
                  .launcher.icon ===
                "help"
                  ? "bg-verde text-ink"
                  : "bg-night/50 text-sage hover:text-bone"
              }`}
            >
              <svg
                viewBox="0 0 24 24"
                className="w-4 h-4"
                fill="currentColor"
              >
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z" />
              </svg>
              مساعدة
            </button>

            <button
              type="button"
              onClick={() =>
                updateSettings(
                  "appearance.launcher.icon",
                  "custom"
                )
              }
              className={`flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-bold transition-all ${
                settings.appearance
                  .launcher.icon ===
                "custom"
                  ? "bg-verde text-ink"
                  : "bg-night/50 text-sage hover:text-bone"
              }`}
            >
              <svg
                viewBox="0 0 24 24"
                className="w-4 h-4"
                fill="currentColor"
              >
                <path d="M19 7v2.99s-1.99.01-2 0V7h-3s.01-1.99 0-2h3V2h2v3h3v2h-3zm-3 4V8h-3V2H5c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2v-8h-3zM5 10h6v4H5v-4zm8 8H5v-4h6v4zm3-8h3v4h-3v-4zm0 6h3v2h-3v-2z" />
              </svg>
              شعار مخصص
            </button>
          </div>

          {/* رفع الشعار المخصص */}

          {settings.appearance
            .launcher.icon ===
            "custom" && (
            <div className="mt-3 p-3 bg-night/30 rounded-lg border border-verde/10">
              <label className="text-xs text-sage mb-2 block">
                رفع الشعار (PNG, SVG, JPG - حد أقصى 1MB)
              </label>

              <div className="flex items-center gap-3">
                {settings.appearance
                  .launcher
                  .customIcon ? (
                  <img
                    src={
                      settings
                        .appearance
                        .launcher
                        .customIcon
                    }
                    alt="شعار مخصص"
                    className="w-12 h-12 rounded-lg object-cover border border-verde/20"
                  />
                ) : (
                  <div className="w-12 h-12 rounded-lg bg-night/50 border border-verde/20 flex items-center justify-center text-sage text-xs">
                    لا يوجد
                  </div>
                )}

                <input
                  type="file"
                  accept="image/png,image/jpeg,image/svg+xml"
                  disabled={
                    !widget ||
                    !authToken
                  }
                  onChange={(e) => {
                    const file =
                      e.target.files?.[0];

                    if (file) {
                      void handleImageUpload(
                        "launcher_icon",
                        file
                      );
                    }

                    e.currentTarget.value =
                      "";
                  }}
                  className="text-xs text-sage flex-1 disabled:opacity-50 disabled:cursor-not-allowed"
                />
              </div>

              {!widget && (
                <p className="text-xs text-oro mt-2">
                  احفظ الـ Widget أولاً لرفع الأيقونة.
                </p>
              )}

              {settings.appearance
                .launcher
                .customIcon && (
                <button
                  type="button"
                  onClick={() => {
                    updateSettings(
                      "appearance.launcher.customIcon",
                      ""
                    );

                    updateSettings(
                      "appearance.launcher.icon",
                      "chat"
                    );
                  }}
                  className="mt-2 text-xs text-oro hover:text-oro-soft transition-colors"
                >
                  إزالة الشعار المخصص
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          Font Family
      ══════════════════════════════════════════════════════════════════════ */}

      <div>
        <label className="text-xs text-sage mb-2 block">
          الخط
        </label>

        <select
          value={
            settings.appearance.fontFamily
          }
          onChange={(e) =>
            updateSettings(
              "appearance.fontFamily",
              e.target.value
            )
          }
          className="input-field"
        >
          <option value="Cairo">
            Cairo
          </option>

          <option value="Tajawal">
            Tajawal
          </option>

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
          {settings.appearance.borderRadius}
          px
        </label>

        <input
          type="range"
          min="0"
          max="32"
          value={
            settings.appearance
              .borderRadius
          }
          onChange={(e) =>
            updateSettings(
              "appearance.borderRadius",
              parseInt(
                e.target.value,
                10
              )
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
          value={
            settings.appearance.shadow
          }
          onChange={(e) =>
            updateSettings(
              "appearance.shadow",
              e.target.value
            )
          }
          className="input-field"
        >
          <option value="none">
            بدون
          </option>

          <option value="light">
            خفيف
          </option>

          <option value="medium">
            متوسط
          </option>

          <option value="strong">
            قوي
          </option>
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
            type="button"
            onClick={() =>
              updateSettings(
                "appearance.position",
                "left"
              )
            }
            className={`flex-1 py-2 rounded-lg text-sm font-bold ${
              settings.appearance
                .position ===
              "left"
                ? "bg-verde text-ink"
                : "bg-night/50 text-sage"
            }`}
          >
            يسار
          </button>

          <button
            type="button"
            onClick={() =>
              updateSettings(
                "appearance.position",
                "right"
              )
            }
            className={`flex-1 py-2 rounded-lg text-sm font-bold ${
              settings.appearance
                .position ===
              "right"
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
              settings.branding
                .showBranding
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
            settings.chat
              .welcomeMessage
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
              settings.chat
                .showTypingIndicator
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
              settings.chat
                .showReadReceipts
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
            settings.behavior
              .autoOpen.trigger
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

      {settings.behavior
        .autoOpen.trigger ===
        "delay" && (
        <div>
          <label className="text-xs text-sage mb-2 block">
            التأخير (ثواني)
          </label>

          <input
            type="number"
            value={
              settings.behavior
                .autoOpen.delay ?? 5
            }
            onChange={(e) =>
              updateSettings(
                "behavior.autoOpen.delay",
                parseInt(
                  e.target.value,
                  10
                )
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
              settings.behavior
                .sound.enabled
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
              settings.behavior
                .visibility
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
              settings.forms
                .preChat.enabled
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
              settings.forms
                .offlineForm.enabled
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
  const embedCode =
    `<script src="https://milanochat-production.up.railway.app/widget.js" data-token="${widget.public_token}"></script>`;

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
          type="button"
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