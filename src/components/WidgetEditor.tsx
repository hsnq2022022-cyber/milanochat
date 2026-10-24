import { useCallback, useEffect, useState } from "react";
import type { ChangeEvent } from "react";
import type { Widget, WidgetSettings } from "../types/widget";
import { DEFAULT_SETTINGS, APPEARANCE_PRESETS } from "../types/widget";
import WidgetPreview from "./WidgetPreview";
import { FUNCTIONS_BASE } from "../lib/api";
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

type AnyObject = Record<string, any>;

function cloneSettings(settings: WidgetSettings): WidgetSettings {
  return JSON.parse(JSON.stringify(settings)) as WidgetSettings;
}

function mergeWithDefaults(settings?: Partial<WidgetSettings> | null): WidgetSettings {
  const source = (settings ?? {}) as AnyObject;
  const defaults = DEFAULT_SETTINGS;

  return {
    ...defaults,
    ...source,
    appearance: {
      ...defaults.appearance,
      ...(source.appearance ?? {}),
      headerGradient: {
        ...defaults.appearance.headerGradient,
        ...(source.appearance?.headerGradient ?? {}),
      },
      launcher: {
        ...defaults.appearance.launcher,
        ...(source.appearance?.launcher ?? {}),
        badge: {
          ...defaults.appearance.launcher.badge,
          ...(source.appearance?.launcher?.badge ?? {}),
        },
      },
      offset: {
        ...defaults.appearance.offset,
        ...(source.appearance?.offset ?? {}),
      },
      avatar: {
        ...defaults.appearance.avatar,
        ...(source.appearance?.avatar ?? {}),
      },
    },
    chat: {
      ...defaults.chat,
      ...(source.chat ?? {}),
      quickReplies: source.chat?.quickReplies ?? defaults.chat.quickReplies,
      fileUpload: {
        ...defaults.chat.fileUpload,
        ...(source.chat?.fileUpload ?? {}),
      },
      workingHours: {
        ...defaults.chat.workingHours,
        ...(source.chat?.workingHours ?? {}),
        schedule: {
          ...defaults.chat.workingHours.schedule,
          ...(source.chat?.workingHours?.schedule ?? {}),
        },
      },
    },
    behavior: {
      ...defaults.behavior,
      ...(source.behavior ?? {}),
      autoOpen: {
        ...defaults.behavior.autoOpen,
        ...(source.behavior?.autoOpen ?? {}),
      },
      sound: {
        ...defaults.behavior.sound,
        ...(source.behavior?.sound ?? {}),
      },
      visibility: {
        ...defaults.behavior.visibility,
        ...(source.behavior?.visibility ?? {}),
        rules: source.behavior?.visibility?.rules ?? [],
      },
    },
    forms: {
      ...defaults.forms,
      ...(source.forms ?? {}),
      preChat: {
        ...defaults.forms.preChat,
        ...(source.forms?.preChat ?? {}),
        fields: source.forms?.preChat?.fields ?? [],
      },
      offlineForm: {
        ...defaults.forms.offlineForm,
        ...(source.forms?.offlineForm ?? {}),
        fields: source.forms?.offlineForm?.fields ?? [],
      },
    },
    localization: {
      ...defaults.localization,
      ...(source.localization ?? {}),
      translations: source.localization?.translations ?? {},
    },
    branding: {
      ...defaults.branding,
      ...(source.branding ?? {}),
    },
    security: {
      ...defaults.security,
      ...(source.security ?? {}),
    },
    chatWindow: {
      ...defaults.chatWindow!,
      ...(source.chatWindow ?? {}),
      glassmorphism: {
        ...defaults.chatWindow!.glassmorphism,
        ...(source.chatWindow?.glassmorphism ?? {}),
      },
      header: {
        ...defaults.chatWindow!.header,
        ...(source.chatWindow?.header ?? {}),
      },
      bubbles: {
        ...defaults.chatWindow!.bubbles,
        ...(source.chatWindow?.bubbles ?? {}),
        user: {
          ...defaults.chatWindow!.bubbles.user,
          ...(source.chatWindow?.bubbles?.user ?? {}),
        },
        bot: {
          ...defaults.chatWindow!.bubbles.bot,
          ...(source.chatWindow?.bubbles?.bot ?? {}),
        },
      },
      input: {
        ...defaults.chatWindow!.input,
        ...(source.chatWindow?.input ?? {}),
      },
      launcher: {
        ...defaults.chatWindow!.launcher,
        ...(source.chatWindow?.launcher ?? {}),
        teaser: {
          ...defaults.chatWindow!.launcher.teaser,
          ...(source.chatWindow?.launcher?.teaser ?? {}),
        },
      },
    },
    avatar: {
      ...defaults.avatar!,
      ...(source.avatar ?? {}),
      headerLogo: {
        ...defaults.avatar!.headerLogo,
        ...(source.avatar?.headerLogo ?? {}),
      },
      botAvatar: {
        ...defaults.avatar!.botAvatar,
        ...(source.avatar?.botAvatar ?? {}),
      },
      typingIndicator: {
        ...defaults.avatar!.typingIndicator,
        ...(source.avatar?.typingIndicator ?? {}),
      },
    },
  };
}

const tabs: {
  id: EditorTab;
  label: string;
  icon: typeof IconSettings;
}[] = [
  { id: "general", label: "عام", icon: IconSettings },
  { id: "appearance", label: "المظهر", icon: IconPalette },
  { id: "chat", label: "المحادثة", icon: IconMessage },
  { id: "behavior", label: "السلوك", icon: IconToggle },
  { id: "forms", label: "النماذج", icon: IconSparkle },
  { id: "install", label: "التضمين", icon: IconCode },
];

export default function WidgetEditor({
  widget,
  onSave,
  onClose,
  saving,
  authToken,
}: WidgetEditorProps) {
  const [activeTab, setActiveTab] = useState<EditorTab>("general");
  const [name, setName] = useState(widget?.name ?? "");
  const [settings, setSettings] = useState<WidgetSettings>(() =>
    mergeWithDefaults(widget?.settings)
  );
  const [history, setHistory] = useState<WidgetSettings[]>([
    mergeWithDefaults(widget?.settings),
  ]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [copiedCode, setCopiedCode] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    const initial = mergeWithDefaults(widget?.settings);
    setName(widget?.name ?? "");
    setSettings(initial);
    setHistory([cloneSettings(initial)]);
    setHistoryIndex(0);
    setErrors({});
    setActiveTab("general");
  }, [widget?.id]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setHistory((previous) => {
        const current = previous[historyIndex];

        if (current && JSON.stringify(current) === JSON.stringify(settings)) {
          return previous;
        }

        const next = previous.slice(0, historyIndex + 1);
        next.push(cloneSettings(settings));

        if (next.length > 50) next.shift();

        setHistoryIndex(next.length - 1);
        return next;
      });
    }, 500);

    return () => window.clearTimeout(timeout);
  }, [settings]);

  const updateSettings = useCallback((path: string, value: unknown) => {
    setSettings((previous) => {
      const next = cloneSettings(previous);
      const keys = path.split(".");
      let target: AnyObject = next as unknown as AnyObject;

      for (let index = 0; index < keys.length - 1; index += 1) {
        const key = keys[index];
        if (
          !target[key] ||
          typeof target[key] !== "object" ||
          Array.isArray(target[key])
        ) {
          target[key] = {};
        }
        target = target[key];
      }

      target[keys[keys.length - 1]] = value;
      return next;
    });
  }, []);

  const undo = () => {
    if (historyIndex <= 0) return;

    const nextIndex = historyIndex - 1;
    setSettings(cloneSettings(history[nextIndex]));
    setHistoryIndex(nextIndex);
  };

  const redo = () => {
    if (historyIndex >= history.length - 1) return;

    const nextIndex = historyIndex + 1;
    setSettings(cloneSettings(history[nextIndex]));
    setHistoryIndex(nextIndex);
  };

  const applyPreset = (presetName: keyof typeof APPEARANCE_PRESETS) => {
    const preset = APPEARANCE_PRESETS[presetName];

    setSettings((previous) => ({
      ...previous,
      appearance: {
        ...previous.appearance,
        ...preset,
      },
    }));
  };

  const validate = () => {
    const nextErrors: Record<string, string> = {};

    if (!name.trim()) {
      nextErrors.name = "أدخل اسم الويدجت.";
    }

    if (!/^#[0-9a-fA-F]{6}$/.test(settings.appearance.primaryColor)) {
      nextErrors.primaryColor = "أدخل لون HEX صحيحًا، مثل #2ec27e.";
    }

    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const handleSave = async () => {
    if (!validate()) {
      setActiveTab(errors.name ? "general" : "appearance");
      return;
    }

    await onSave(name.trim(), settings);
  };

  const embedCode = widget?.public_token
    ? `<script src="https://nmhefwvhoholcjrbbila.supabase.co/functions/v1/milan-api?action=widget.js" data-token="${widget.public_token}"></script>`
    : "";

  const copyEmbedCode = async () => {
    if (!embedCode) {
      window.alert("احفظ الويدجت أولًا حتى يتوفر رمز التضمين.");
      return;
    }

    try {
      await navigator.clipboard.writeText(embedCode);
      setCopiedCode(true);
      window.setTimeout(() => setCopiedCode(false), 2000);
    } catch {
      window.alert("تعذر النسخ تلقائيًا. انسخ الكود يدويًا.");
    }
  };

  const handleImageUpload = async (
    event: ChangeEvent<HTMLInputElement>,
    type: "logo" | "avatar" | "launcher_icon"
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) return;

    if (!widget?.id || !authToken) {
      window.alert("احفظ الويدجت وسجّل الدخول قبل رفع الصور.");
      return;
    }

    if (!file.type.startsWith("image/")) {
      window.alert("اختر ملف صورة صالحًا.");
      return;
    }

    if (file.size > 1024 * 1024) {
      window.alert("حجم الصورة يجب ألا يتجاوز 1 ميغابايت.");
      return;
    }

    setUploading(true);

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("widget_id", widget.id);
      formData.append("type", type);

      const response = await fetch(
        `${String(FUNCTIONS_BASE).replace(/\/$/, "")}/milan-api?action=widget_dashboard_upload`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${authToken}`,
          },
          body: formData,
        }
      );

      const result = await response.json();

      if (!response.ok || !result?.url) {
        throw new Error(result?.error || "تعذر رفع الصورة.");
      }

      if (type === "logo") {
        updateSettings("avatar.headerLogo.url", result.url);
      } else if (type === "avatar") {
        updateSettings("avatar.botAvatar.url", result.url);
        updateSettings("avatar.botAvatar.type", "upload");
      } else {
        updateSettings("appearance.launcher.customIcon", result.url);
        updateSettings("appearance.launcher.icon", "custom");
      }

      window.alert("تم رفع الصورة بنجاح.");
    } catch (error) {
      window.alert(
        error instanceof Error ? error.message : "حدث خطأ أثناء رفع الصورة."
      );
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex bg-night text-bone" dir="rtl">
      {/* Sidebar */}
      <aside className="flex w-64 shrink-0 flex-col border-l border-verde/15 bg-pine">
        <div className="flex items-center justify-between border-b border-verde/15 p-4">
          <div>
            <h2 className="font-bold">
              {widget ? "تعديل Widget" : "إنشاء Widget"}
            </h2>
            <p className="mt-1 text-xs text-sage">محرر الويدجت</p>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق المحرر"
            className="rounded-lg p-2 text-sage hover:bg-night hover:text-bone"
          >
            <IconX className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto p-3">
          {tabs.map((tab) => {
            const TabIcon = tab.icon;
            const selected = activeTab === tab.id;

            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm transition-colors ${
                  selected
                    ? "bg-verde font-bold text-ink"
                    : "text-sage hover:bg-night/70 hover:text-bone"
                }`}
              >
                <TabIcon className="h-5 w-5 shrink-0" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="space-y-2 border-t border-verde/15 p-3">
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={undo}
              disabled={historyIndex <= 0}
              className="btn-secondary flex items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <IconUndo className="h-4 w-4" />
              تراجع
            </button>
            <button
              type="button"
              onClick={redo}
              disabled={historyIndex >= history.length - 1}
              className="btn-secondary flex items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <IconRedo className="h-4 w-4" />
              إعادة
            </button>
          </div>

          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="btn-primary flex w-full items-center justify-center gap-2 disabled:opacity-50"
          >
            <IconSave className="h-4 w-4" />
            {saving ? "جارٍ الحفظ..." : "حفظ التغييرات"}
          </button>
        </div>
      </aside>

      {/* Main editor */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-verde/15 bg-pine/40 px-5 py-4">
          <div>
            <h1 className="font-bold">
              {tabs.find((tab) => tab.id === activeTab)?.label}
            </h1>
            <p className="mt-1 text-xs text-sage">
              تعديلاتك تظهر في المعاينة الجانبية
            </p>
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-sm text-sage">
            <input
              type="checkbox"
              checked={settings.localization.rtl}
              onChange={(event) => {
                updateSettings("localization.rtl", event.target.checked);
                updateSettings(
                  "localization.language",
                  event.target.checked ? "ar" : "en"
                );
              }}
              className="h-4 w-4 accent-verde"
            />
            اتجاه من اليمين إلى اليسار
          </label>
        </header>

        <div className="flex-1 overflow-y-auto p-5 lg:p-7">
          <div className="mx-auto max-w-3xl space-y-6">
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
                settings={settings}
                updateSettings={updateSettings}
                applyPreset={applyPreset}
                errors={errors}
                handleImageUpload={handleImageUpload}
                uploading={uploading}
              />
            )}

            {activeTab === "chat" && (
              <ChatTab settings={settings} updateSettings={updateSettings} />
            )}

            {activeTab === "behavior" && (
              <BehaviorTab settings={settings} updateSettings={updateSettings} />
            )}

            {activeTab === "forms" && (
              <FormsTab settings={settings} updateSettings={updateSettings} />
            )}

            {activeTab === "install" && (
              <InstallTab
                embedCode={embedCode}
                copiedCode={copiedCode}
                copyEmbedCode={copyEmbedCode}
                widget={widget}
              />
            )}
          </div>
        </div>
      </main>

      {/* Live preview: large screens only */}
      <aside className="hidden w-[380px] shrink-0 flex-col border-r border-verde/15 bg-night xl:flex">
        <div className="border-b border-verde/15 px-4 py-4">
          <h2 className="font-bold">المعاينة الحية</h2>
          <p className="mt-1 text-xs text-sage">
            معاينة تقريبية لإعدادات الويدجت
          </p>
        </div>

        <div className="min-h-0 flex-1">
          <WidgetPreview settings={settings} widgetName={name} />
        </div>
      </aside>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4 rounded-2xl border border-verde/15 bg-pine/50 p-5">
      <div>
        <h3 className="font-bold">{title}</h3>
        {description && (
          <p className="mt-1 text-xs leading-6 text-sage">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

function Field({
  label,
  children,
  error,
}: {
  label: string;
  children: React.ReactNode;
  error?: string;
}) {
  return (
    <div>
      <label className="mb-2 block text-xs text-sage">{label}</label>
      {children}
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  description,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  description?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-verde/10 p-3 hover:bg-night/30">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 h-4 w-4 shrink-0 accent-verde"
      />
      <span>
        <span className="block text-sm text-bone">{label}</span>
        {description && (
          <span className="mt-1 block text-xs leading-5 text-sage">
            {description}
          </span>
        )}
      </span>
    </label>
  );
}

function GeneralTab({
  name,
  setName,
  settings,
  updateSettings,
  errors,
}: any) {
  return (
    <div className="space-y-6">
      <Section
        title="الإعدادات العامة"
        description="اسم الويدجت واللغة وهوية المساعد."
      >
        <Field label="اسم الويدجت" error={errors.name}>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="مثال: مساعد المتجر"
            className="input-field w-full"
          />
        </Field>

        <Field label="اسم المساعد">
          <input
            value={settings.avatar.botName}
            onChange={(event) =>
              updateSettings("avatar.botName", event.target.value)
            }
            className="input-field w-full"
          />
        </Field>

        <Field label="وصف المساعد">
          <input
            value={settings.avatar.botTagline}
            onChange={(event) =>
              updateSettings("avatar.botTagline", event.target.value)
            }
            className="input-field w-full"
          />
        </Field>

        <Field label="لغة الويدجت">
          <select
            value={settings.localization.language}
            onChange={(event) => {
              const language = event.target.value as "ar" | "en";
              updateSettings("localization.language", language);
              updateSettings("localization.rtl", language === "ar");
            }}
            className="input-field w-full"
          >
            <option value="ar">العربية</option>
            <option value="en">English</option>
          </select>
        </Field>

        <Toggle
          label="إظهار العلامة التجارية"
          description="إظهار عبارة مدعوم من إدارة سوشيال أسفل المحادثة."
          checked={settings.branding.showBranding}
          onChange={(value) => updateSettings("branding.showBranding", value)}
        />
      </Section>
    </div>
  );
}

function AppearanceTab({
  settings,
  updateSettings,
  applyPreset,
  errors,
  handleImageUpload,
  uploading,
}: any) {
  const [palette, setPalette] = useState<"light" | "dark" | "auto">("auto");

  const applyPalette = (value: "light" | "dark" | "auto") => {
    setPalette(value);

    if (value === "light") {
      updateSettings("appearance.backgroundColor", "#ffffff");
      updateSettings("appearance.textColor", "#1a1a1a");
      updateSettings("chatWindow.header.backgroundColor", settings.appearance.primaryColor);
      updateSettings("chatWindow.header.textColor", "#ffffff");
    } else if (value === "dark") {
      updateSettings("appearance.backgroundColor", "#1a1a1a");
      updateSettings("appearance.textColor", "#ffffff");
      updateSettings("chatWindow.header.backgroundColor", "#111827");
      updateSettings("chatWindow.header.textColor", "#ffffff");
    } else {
      updateSettings("appearance.backgroundColor", DEFAULT_SETTINGS.appearance.backgroundColor);
      updateSettings("appearance.textColor", DEFAULT_SETTINGS.appearance.textColor);
      updateSettings("chatWindow.header.backgroundColor", DEFAULT_SETTINGS.chatWindow!.header.backgroundColor);
      updateSettings("chatWindow.header.textColor", DEFAULT_SETTINGS.chatWindow!.header.textColor);
    }
  };

  return (
    <div className="space-y-6">
      <Section title="القالب والألوان">
        <Field label="قالب جاهز">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {(
              [
                ["minimal", "بسيط"],
                ["modern", "عصري"],
                ["glass", "زجاجي"],
                ["darkPro", "داكن احترافي"],
                ["rounded", "مستدير"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => applyPreset(key)}
                className="rounded-xl border border-verde/20 px-3 py-3 text-sm text-sage hover:border-verde hover:text-bone"
              >
                {label}
              </button>
            ))}
          </div>
        </Field>

        <Field label="نمط الألوان">
          <select
            value={palette}
            onChange={(event) =>
              applyPalette(event.target.value as "light" | "dark" | "auto")
            }
            className="input-field w-full"
          >
            <option value="light">فاتح</option>
            <option value="dark">داكن</option>
            <option value="auto">الافتراضي</option>
          </select>
          <p className="mt-2 text-xs text-sage">
            هذا الاختيار يطبّق مجموعة ألوان على الإعدادات، وليس اكتشافًا تلقائيًا
            لمظهر موقع الزائر.
          </p>
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="اللون الأساسي" error={errors.primaryColor}>
            <div className="flex gap-2">
              <input
                type="color"
                value={/^#[0-9a-fA-F]{6}$/.test(settings.appearance.primaryColor)
                  ? settings.appearance.primaryColor
                  : "#2ec27e"}
                onChange={(event) =>
                  updateSettings("appearance.primaryColor", event.target.value)
                }
                className="h-11 w-14 cursor-pointer rounded-lg border-0 bg-transparent"
              />
              <input
                value={settings.appearance.primaryColor}
                onChange={(event) =>
                  updateSettings("appearance.primaryColor", event.target.value)
                }
                className="input-field min-w-0 flex-1"
                dir="ltr"
              />
            </div>
          </Field>

          <Field label="لون الخلفية">
            <div className="flex gap-2">
              <input
                type="color"
                value={/^#[0-9a-fA-F]{6}$/.test(settings.appearance.backgroundColor)
                  ? settings.appearance.backgroundColor
                  : "#ffffff"}
                onChange={(event) =>
                  updateSettings("appearance.backgroundColor", event.target.value)
                }
                className="h-11 w-14 cursor-pointer rounded-lg border-0 bg-transparent"
              />
              <input
                value={settings.appearance.backgroundColor}
                onChange={(event) =>
                  updateSettings("appearance.backgroundColor", event.target.value)
                }
                className="input-field min-w-0 flex-1"
                dir="ltr"
              />
            </div>
          </Field>

          <Field label="لون النص">
            <input
              type="color"
              value={/^#[0-9a-fA-F]{6}$/.test(settings.appearance.textColor)
                ? settings.appearance.textColor
                : "#1a1a1a"}
              onChange={(event) =>
                updateSettings("appearance.textColor", event.target.value)
              }
              className="h-11 w-full cursor-pointer rounded-lg bg-transparent"
            />
          </Field>

          <Field label="لون الهيدر">
            <div className="flex gap-2">
              <input
                type="color"
                value={/^#[0-9a-fA-F]{6}$/.test(settings.chatWindow.header.backgroundColor)
                  ? settings.chatWindow.header.backgroundColor
                  : "#2ec27e"}
                onChange={(event) =>
                  updateSettings("chatWindow.header.backgroundColor", event.target.value)
                }
                className="h-11 w-14 cursor-pointer rounded-lg border-0 bg-transparent"
              />
              <input
                value={settings.chatWindow.header.backgroundColor}
                onChange={(event) =>
                  updateSettings("chatWindow.header.backgroundColor", event.target.value)
                }
                className="input-field min-w-0 flex-1"
                dir="ltr"
              />
            </div>
          </Field>
        </div>

        <Toggle
          label="تدرج لوني للهيدر"
          checked={settings.appearance.headerGradient.enabled}
          onChange={(value) =>
            updateSettings("appearance.headerGradient.enabled", value)
          }
        />

        {settings.appearance.headerGradient.enabled && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="بداية التدرج">
              <input
                type="color"
                value={settings.appearance.headerGradient.from}
                onChange={(event) =>
                  updateSettings("appearance.headerGradient.from", event.target.value)
                }
                className="h-11 w-full cursor-pointer bg-transparent"
              />
            </Field>
            <Field label="نهاية التدرج">
              <input
                type="color"
                value={settings.appearance.headerGradient.to}
                onChange={(event) =>
                  updateSettings("appearance.headerGradient.to", event.target.value)
                }
                className="h-11 w-full cursor-pointer bg-transparent"
              />
            </Field>
            <Field label="زاوية التدرج">
              <input
                type="number"
                min={0}
                max={360}
                value={settings.appearance.headerGradient.angle}
                onChange={(event) =>
                  updateSettings(
                    "appearance.headerGradient.angle",
                    Math.min(360, Math.max(0, Number(event.target.value) || 0))
                  )
                }
                className="input-field w-full"
              />
            </Field>
          </div>
        )}
      </Section>

      <Section title="أبعاد النافذة والشكل">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={`العرض: ${settings.appearance.width}px`}>
            <input
              type="range"
              min={300}
              max={520}
              step={10}
              value={settings.appearance.width}
              onChange={(event) =>
                updateSettings("appearance.width", Number(event.target.value))
              }
              className="w-full accent-verde"
            />
          </Field>
          <Field label={`الارتفاع: ${settings.appearance.height}px`}>
            <input
              type="range"
              min={400}
              max={800}
              step={10}
              value={settings.appearance.height}
              onChange={(event) =>
                updateSettings("appearance.height", Number(event.target.value))
              }
              className="w-full accent-verde"
            />
          </Field>
          <Field label={`استدارة الحواف: ${settings.appearance.borderRadius}px`}>
            <input
              type="range"
              min={0}
              max={32}
              value={settings.appearance.borderRadius}
              onChange={(event) =>
                updateSettings("appearance.borderRadius", Number(event.target.value))
              }
              className="w-full accent-verde"
            />
          </Field>
          <Field label="مستوى الظل">
            <select
              value={settings.appearance.shadow}
              onChange={(event) => updateSettings("appearance.shadow", event.target.value)}
              className="input-field w-full"
            >
              <option value="none">بدون ظل</option>
              <option value="light">خفيف</option>
              <option value="medium">متوسط</option>
              <option value="strong">قوي</option>
            </select>
          </Field>
          <Field label="نوع الخط">
            <select
              value={settings.appearance.fontFamily}
              onChange={(event) =>
                updateSettings("appearance.fontFamily", event.target.value)
              }
              className="input-field w-full"
            >
              <option value="Cairo">Cairo</option>
              <option value="Tajawal">Tajawal</option>
              <option value="IBM Plex Arabic">IBM Plex Arabic</option>
              <option value="system">System</option>
            </select>
          </Field>
          <Field label={`حجم الخط: ${settings.appearance.fontSize}px`}>
            <input
              type="range"
              min={12}
              max={18}
              value={settings.appearance.fontSize}
              onChange={(event) =>
                updateSettings("appearance.fontSize", Number(event.target.value))
              }
              className="w-full accent-verde"
            />
          </Field>
        </div>

        <Field label="موضع الويدجت">
          <select
            value={settings.appearance.position}
            onChange={(event) => updateSettings("appearance.position", event.target.value)}
            className="input-field w-full"
          >
            <option value="right">اليمين</option>
            <option value="left">اليسار</option>
          </select>
        </Field>
      </Section>

      <Section title="الشعار والصور">
        <Field label="شعار الهيدر">
          {settings.avatar.headerLogo.url && (
            <img
              src={settings.avatar.headerLogo.url}
              alt="شعار الهيدر"
              className="mb-3 h-12 w-12 rounded-lg border border-verde/20 object-contain"
            />
          )}
          <input
            type="file"
            accept="image/*"
            onChange={(event) => handleImageUpload(event, "logo")}
            disabled={uploading}
            className="block w-full text-xs text-sage"
          />
        </Field>

        <Field label="صورة المساعد">
          {settings.avatar.botAvatar.url && (
            <img
              src={settings.avatar.botAvatar.url}
              alt="صورة المساعد"
              className="mb-3 h-12 w-12 rounded-full object-cover"
            />
          )}
          <input
            type="file"
            accept="image/*"
            onChange={(event) => handleImageUpload(event, "avatar")}
            disabled={uploading}
            className="block w-full text-xs text-sage"
          />
        </Field>

        <Field label="أيقونة الزر العائم">
          {settings.appearance.launcher.customIcon && (
            <img
              src={settings.appearance.launcher.customIcon}
              alt="أيقونة الزر"
              className="mb-3 h-12 w-12 object-contain"
            />
          )}
          <input
            type="file"
            accept="image/*"
            onChange={(event) => handleImageUpload(event, "launcher_icon")}
            disabled={uploading}
            className="block w-full text-xs text-sage"
          />
          {uploading && <p className="mt-2 text-xs text-sage">جارٍ رفع الصورة...</p>}
        </Field>

        <Field label="أيقونة الزر العائم">
          <select
            value={settings.appearance.launcher.icon}
            onChange={(event) =>
              updateSettings("appearance.launcher.icon", event.target.value)
            }
            className="input-field w-full"
          >
            <option value="chat">محادثة</option>
            <option value="message">رسالة</option>
            <option value="support">دعم</option>
            <option value="help">مساعدة</option>
            <option value="custom">أيقونة مخصصة</option>
          </select>
        </Field>

        <Toggle
          label="إظهار مؤشر حالة المساعد"
          checked={settings.appearance.avatar.statusIndicator}
          onChange={(value) =>
            updateSettings("appearance.avatar.statusIndicator", value)
          }
        />
      </Section>
    </div>
  );
}

function ChatTab({ settings, updateSettings }: any) {
  return (
    <div className="space-y-6">
      <Section title="الرسائل" description="تخصيص النصوص التي تظهر للزائر داخل نافذة المحادثة.">
        <Field label="رسالة الترحيب">
          <textarea
            value={settings.chat.welcomeMessage}
            onChange={(event) =>
              updateSettings("chat.welcomeMessage", event.target.value)
            }
            className="input-field w-full resize-y"
            rows={3}
          />
        </Field>

        <Field label="نص حقل الرسالة">
          <input
            value={settings.chat.placeholder}
            onChange={(event) =>
              updateSettings("chat.placeholder", event.target.value)
            }
            className="input-field w-full"
          />
        </Field>

        <Field label="رسالة عدم التوفر">
          <textarea
            value={settings.chat.unavailableMessage}
            onChange={(event) =>
              updateSettings("chat.unavailableMessage", event.target.value)
            }
            className="input-field w-full resize-y"
            rows={2}
          />
        </Field>

        <Field label="رسالة خارج أوقات العمل">
          <textarea
            value={settings.chat.offlineMessage}
            onChange={(event) =>
              updateSettings("chat.offlineMessage", event.target.value)
            }
            className="input-field w-full resize-y"
            rows={2}
          />
        </Field>

        <Toggle
          label="إظهار مؤشر الكتابة"
          checked={settings.chat.showTypingIndicator}
          onChange={(value) => updateSettings("chat.showTypingIndicator", value)}
        />

        <Toggle
          label="إظهار إيصالات القراءة"
          checked={settings.chat.showReadReceipts}
          onChange={(value) => updateSettings("chat.showReadReceipts", value)}
        />
      </Section>

      <Section title="الملفات المرفقة">
        <Toggle
          label="السماح برفع الملفات"
          checked={settings.chat.fileUpload.enabled}
          onChange={(value) => {
            updateSettings("chat.fileUpload.enabled", value);
            updateSettings("chat.allowFileUpload", value);
          }}
        />

        <Field label={`الحد الأقصى للملف: ${settings.chat.fileUpload.maxFileSize} ميغابايت`}>
          <input
            type="range"
            min={1}
            max={20}
            value={settings.chat.fileUpload.maxFileSize}
            onChange={(event) =>
              updateSettings("chat.fileUpload.maxFileSize", Number(event.target.value))
            }
            className="w-full accent-verde"
          />
        </Field>
      </Section>

      <Section title="العلامة التجارية">
        <Toggle
          label="إظهار عبارة مدعوم من إدارة سوشيال"
          checked={settings.branding.showBranding}
          onChange={(value) => updateSettings("branding.showBranding", value)}
        />
        <Field label="نص إضافي في التذييل">
          <input
            value={settings.branding.customFooter ?? ""}
            onChange={(event) =>
              updateSettings("branding.customFooter", event.target.value)
            }
            className="input-field w-full"
            placeholder="اختياري"
          />
        </Field>
      </Section>
    </div>
  );
}

function BehaviorTab({ settings, updateSettings }: any) {
  return (
    <div className="space-y-6">
      <Section title="الفتح التلقائي">
        <Field label="متى تُفتح نافذة المحادثة؟">
          <select
            value={settings.behavior.autoOpen.trigger}
            onChange={(event) =>
              updateSettings("behavior.autoOpen.trigger", event.target.value)
            }
            className="input-field w-full"
          >
            <option value="disabled">معطّل</option>
            <option value="delay">بعد تأخير</option>
            <option value="exit_intent">عند نية الخروج</option>
            <option value="scroll">عند التمرير</option>
          </select>
        </Field>

        {settings.behavior.autoOpen.trigger === "delay" && (
          <Field label="التأخير بالثواني">
            <input
              type="number"
              min={1}
              max={120}
              value={settings.behavior.autoOpen.delay ?? 3}
              onChange={(event) =>
                updateSettings(
                  "behavior.autoOpen.delay",
                  Math.max(1, Number(event.target.value) || 1)
                )
              }
              className="input-field w-full"
            />
          </Field>
        )}

        {settings.behavior.autoOpen.trigger === "scroll" && (
          <Field label={`نسبة التمرير: ${settings.behavior.autoOpen.scrollPercentage ?? 50}%`}>
            <input
              type="range"
              min={10}
              max={100}
              value={settings.behavior.autoOpen.scrollPercentage ?? 50}
              onChange={(event) =>
                updateSettings(
                  "behavior.autoOpen.scrollPercentage",
                  Number(event.target.value)
                )
              }
              className="w-full accent-verde"
            />
          </Field>
        )}
      </Section>

      <Section title="التنبيهات والظهور">
        <Toggle
          label="تفعيل صوت التنبيه"
          checked={settings.behavior.sound.enabled}
          onChange={(value) => updateSettings("behavior.sound.enabled", value)}
        />

        <Toggle
          label="إخفاء الويدجت على الجوال"
          checked={settings.behavior.visibility.hideOnMobile}
          onChange={(value) =>
            updateSettings("behavior.visibility.hideOnMobile", value)
          }
        />
      </Section>

      <Section title="أوقات العمل">
        <Toggle
          label="تفعيل أوقات العمل"
          checked={settings.chat.workingHours.enabled}
          onChange={(value) =>
            updateSettings("chat.workingHours.enabled", value)
          }
        />

        {settings.chat.workingHours.enabled && (
          <Field label="المنطقة الزمنية">
            <select
              value={settings.chat.workingHours.timezone}
              onChange={(event) =>
                updateSettings("chat.workingHours.timezone", event.target.value)
              }
              className="input-field w-full"
            >
              <option value="Asia/Baghdad">العراق — بغداد</option>
              <option value="Asia/Riyadh">السعودية — الرياض</option>
              <option value="Asia/Dubai">الإمارات — دبي</option>
              <option value="Asia/Muscat">عُمان — مسقط</option>
              <option value="UTC">UTC</option>
            </select>
          </Field>
        )}
      </Section>
    </div>
  );
}

function FormsTab({ settings, updateSettings }: any) {
  return (
    <div className="space-y-6">
      <Section
        title="نموذج ما قبل المحادثة"
        description="يمكنك طلب بيانات الزائر قبل بدء المحادثة."
      >
        <Toggle
          label="تفعيل نموذج ما قبل المحادثة"
          checked={settings.forms.preChat.enabled}
          onChange={(value) => updateSettings("forms.preChat.enabled", value)}
        />

        {settings.forms.preChat.enabled && (
          <div className="space-y-3">
            {settings.forms.preChat.fields.map((field: AnyObject, index: number) => (
              <div
                key={field.id ?? index}
                className="rounded-xl border border-verde/15 p-3"
              >
                <Field label={`عنوان الحقل ${index + 1}`}>
                  <input
                    value={field.label}
                    onChange={(event) => {
                      const fields = [...settings.forms.preChat.fields];
                      fields[index] = { ...field, label: event.target.value };
                      updateSettings("forms.preChat.fields", fields);
                    }}
                    className="input-field w-full"
                  />
                </Field>
                <div className="mt-3">
                  <Toggle
                    label="حقل مطلوب"
                    checked={Boolean(field.required)}
                    onChange={(value) => {
                      const fields = [...settings.forms.preChat.fields];
                      fields[index] = { ...field, required: value };
                      updateSettings("forms.preChat.fields", fields);
                    }}
                  />
                </div>
              </div>
            ))}
            <p className="text-xs leading-5 text-sage">
              لا توجد حقول معرفة حاليًا. إضافة حقول جديدة تتطلب تحديد نوع الحقل
              ومعرّفه وترتيبه.
            </p>
          </div>
        )}
      </Section>

      <Section
        title="نموذج ترك رسالة"
        description="اسمح للزوار بترك رسالة عندما لا يكون الوكلاء متاحين."
      >
        <Toggle
          label="تفعيل نموذج ترك رسالة"
          checked={settings.forms.offlineForm.enabled}
          onChange={(value) => updateSettings("forms.offlineForm.enabled", value)}
        />

        {settings.forms.offlineForm.enabled && (
          <div className="space-y-3">
            {settings.forms.offlineForm.fields.map((field: AnyObject, index: number) => (
              <div
                key={field.id ?? index}
                className="rounded-xl border border-verde/15 p-3"
              >
                <Field label={`عنوان الحقل ${index + 1}`}>
                  <input
                    value={field.label}
                    onChange={(event) => {
                      const fields = [...settings.forms.offlineForm.fields];
                      fields[index] = { ...field, label: event.target.value };
                      updateSettings("forms.offlineForm.fields", fields);
                    }}
                    className="input-field w-full"
                  />
                </Field>
                <div className="mt-3">
                  <Toggle
                    label="حقل مطلوب"
                    checked={Boolean(field.required)}
                    onChange={(value) => {
                      const fields = [...settings.forms.offlineForm.fields];
                      fields[index] = { ...field, required: value };
                      updateSettings("forms.offlineForm.fields", fields);
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function InstallTab({
  embedCode,
  copiedCode,
  copyEmbedCode,
  widget,
}: any) {
  return (
    <div className="space-y-6">
      <Section
        title="كود التضمين"
        description="أضف الكود إلى الموقع الذي تريد إظهار الويدجت فيه."
      >
        {!widget ? (
          <p className="text-sm text-sage">
            احفظ الويدجت أولًا حتى يتوفر رمز التضمين الخاص به.
          </p>
        ) : (
          <>
            <pre
              className="overflow-x-auto whitespace-pre-wrap break-all rounded-xl border border-verde/15 bg-night p-4 text-left text-xs leading-6 text-verde"
              dir="ltr"
            >
              {embedCode}
            </pre>

            <button
              type="button"
              onClick={copyEmbedCode}
              className="btn-secondary flex w-full items-center justify-center gap-2"
            >
              {copiedCode ? (
                <>
                  <IconCheck className="h-4 w-4" />
                  تم النسخ
                </>
              ) : (
                <>
                  <IconCopy className="h-4 w-4" />
                  نسخ الكود
                </>
              )}
            </button>
          </>
        )}
      </Section>

      <Section title="تعليمات التثبيت">
        <div className="space-y-4 text-sm leading-6 text-sage">
          <div>
            <h4 className="mb-1 font-bold text-bone">WordPress</h4>
            <p>
              أضف الكود إلى تذييل القالب أو استخدم إضافة لإدراج الأكواد في
              الموقع.
            </p>
          </div>
          <div>
            <h4 className="mb-1 font-bold text-bone">Shopify</h4>
            <p>
              أضف الكود إلى ملف theme.liquid قبل وسم إغلاق body.
            </p>
          </div>
          <div>
            <h4 className="mb-1 font-bold text-bone">React</h4>
            <p>
              أضف سكربت التضمين إلى الصفحة أو حمّله من خلال useEffect عند الحاجة.
            </p>
          </div>
        </div>
      </Section>
    </div>
  );
}
