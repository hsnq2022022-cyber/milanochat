import { useCallback, useEffect, useState } from "react";
import { apiAuthFetch, API } from "../lib/api";
import { getSupabase } from "../lib/supabase";
import {
  IconPlus,
  IconEdit,
  IconTrash,
  IconCopy,
  IconEye,
  IconCode,
  IconCheck,
  IconX,
  IconSparkle,
  IconChat,
  IconSettings,
  IconPalette,
  IconMessage,
  IconToggle,
} from "../components/Icons";

type Widget = {
  id: string;
  tenant_id: string;
  name: string;
  public_token: string;
  enabled: boolean;
  welcome_message: string;
  primary_color: string;
  position: "left" | "right";
  language: string;
  rtl: boolean;
  avatar_url: string | null;
  show_branding: boolean;
  placeholder: string;
  suggested_questions: string[];
  created_at: string;
  updated_at: string;
};

type WidgetFormData = {
  name: string;
  welcomeMessage: string;
  primaryColor: string;
  position: "left" | "right";
  placeholder: string;
  suggestedQuestions: string[];
  showBranding: boolean;
  rtl: boolean;
};

const defaultFormData: WidgetFormData = {
  name: "",
  welcomeMessage: "مرحباً! كيف يمكنني مساعدتك؟",
  primaryColor: "#2ec27e",
  position: "left",
  placeholder: "اكتب رسالتك...",
  suggestedQuestions: [],
  showBranding: true,
  rtl: true,
};

export default function Widgets() {
  const sb = getSupabase();
  const [token, setToken] = useState<string | null>(null);
  const [widgets, setWidgets] = useState<Widget[]>([]);
  const [loading, setLoading] = useState(true);
  const [showEditor, setShowEditor] = useState(false);
  const [editingWidget, setEditingWidget] = useState<Widget | null>(null);
  const [formData, setFormData] = useState<WidgetFormData>(defaultFormData);
  const [saving, setSaving] = useState(false);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Auth
  useEffect(() => {
    if (!sb) return;
    sb.auth.getSession().then(({ data }) => {
      if (data.session) setToken(data.session.access_token);
    });
    const { data: sub } = sb.auth.onAuthStateChange((_e, session) => {
      setToken(session?.access_token ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, [sb]);

  // Load widgets
  const loadWidgets = useCallback(async () => {
    if (!token) return;
    try {
      const data = await apiAuthFetch<Widget[]>(token, "/api/widgets/dashboard");
      setWidgets(data);
    } catch (e: any) {
      console.error("Load widgets error:", e);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (token) loadWidgets();
  }, [token, loadWidgets]);

  // Toast
  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  // Create/Edit
  const openEditor = (widget?: Widget) => {
    if (widget) {
      setEditingWidget(widget);
      setFormData({
        name: widget.name,
        welcomeMessage: widget.welcome_message,
        primaryColor: widget.primary_color,
        position: widget.position,
        placeholder: widget.placeholder,
        suggestedQuestions: widget.suggested_questions || [],
        showBranding: widget.show_branding,
        rtl: widget.rtl,
      });
    } else {
      setEditingWidget(null);
      setFormData(defaultFormData);
    }
    setShowEditor(true);
  };

  const closeEditor = () => {
    setShowEditor(false);
    setEditingWidget(null);
    setFormData(defaultFormData);
  };

  const saveWidget = async () => {
    if (!token || !formData.name.trim()) {
      showToast("أدخل اسم الـ widget");
      return;
    }
    setSaving(true);
    try {
      if (editingWidget) {
        await apiAuthFetch(token, `/api/widgets/dashboard/${editingWidget.id}`, {
          method: "PUT",
          body: JSON.stringify({
            name: formData.name,
            settings: {
              welcomeMessage: formData.welcomeMessage,
              primaryColor: formData.primaryColor,
              position: formData.position,
              placeholder: formData.placeholder,
              suggestedQuestions: formData.suggestedQuestions,
              showBranding: formData.showBranding,
            },
          }),
        });
        showToast("تم تحديث الـ widget بنجاح");
      } else {
        await apiAuthFetch(token, "/api/widgets/dashboard", {
          method: "POST",
          body: JSON.stringify({
            name: formData.name,
            settings: {
              welcomeMessage: formData.welcomeMessage,
              primaryColor: formData.primaryColor,
              position: formData.position,
              placeholder: formData.placeholder,
              suggestedQuestions: formData.suggestedQuestions,
              showBranding: formData.showBranding,
            },
          }),
        });
        showToast("تم إنشاء الـ widget بنجاح");
      }
      closeEditor();
      loadWidgets();
    } catch (e: any) {
      showToast(e?.message || "حدث خطأ");
    } finally {
      setSaving(false);
    }
  };

  // Delete
  const deleteWidget = async (id: string) => {
    if (!token) return;
    try {
      await apiAuthFetch(token, `/api/widgets/dashboard/${id}`, { method: "DELETE" });
      showToast("تم حذف الـ widget");
      loadWidgets();
      setShowDeleteConfirm(null);
    } catch (e: any) {
      showToast(e?.message || "حدث خطأ");
    }
  };

  // Toggle
  const toggleWidget = async (id: string, enabled: boolean) => {
    if (!token) return;
    try {
      await apiAuthFetch(token, `/api/widgets/dashboard/${id}`, {
        method: "PUT",
        body: JSON.stringify({ enabled }),
      });
      loadWidgets();
    } catch (e: any) {
      showToast(e?.message || "حدث خطأ");
    }
  };

  // Copy
  const copyEmbedCode = (widget: Widget) => {
    const code = `<script src="${API}/widget.js" data-token="${widget.public_token}"></script>`;
    navigator.clipboard.writeText(code);
    setCopiedToken(widget.public_token);
    setTimeout(() => setCopiedToken(null), 2000);
    showToast("تم نسخ كود التضمين");
  };

  // Stats
  const stats = {
    total: widgets.length,
    active: widgets.filter((w) => w.enabled).length,
    inactive: widgets.filter((w) => !w.enabled).length,
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-night flex items-center justify-center">
        <div className="w-12 h-12 rounded-full border-4 border-verde/30 border-t-verde animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-night text-bone" dir="rtl">
      {/* Header */}
      <header className="bg-pine/50 border-b border-verde/10">
        <div className="max-w-7xl mx-auto px-6 py-8">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="font-display font-bold text-3xl text-bone mb-2">Widgets</h1>
              <p className="text-sage text-sm">أنشئ مساعدًا ذكيًا وادمجه في موقعك بسهولة</p>
            </div>
            <button onClick={() => openEditor()} className="btn-primary flex items-center gap-2">
              <IconPlus className="w-5 h-5" />
              إنشاء Widget
            </button>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-pine/70 border border-verde/15 rounded-2xl p-5">
              <p className="text-sage text-xs mb-1">إجمالي Widgets</p>
              <p className="font-display font-bold text-3xl text-bone">{stats.total}</p>
            </div>
            <div className="bg-pine/70 border border-verde/15 rounded-2xl p-5">
              <p className="text-sage text-xs mb-1">Active</p>
              <p className="font-display font-bold text-3xl text-verde">{stats.active}</p>
            </div>
            <div className="bg-pine/70 border border-verde/15 rounded-2xl p-5">
              <p className="text-sage text-xs mb-1">Inactive</p>
              <p className="font-display font-bold text-3xl text-oro">{stats.inactive}</p>
            </div>
          </div>
        </div>
      </header>

      {/* Widgets List */}
      <main className="max-w-7xl mx-auto px-6 py-8">
        {widgets.length === 0 ? (
          <div className="text-center py-20">
            <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-moss flex items-center justify-center">
              <IconChat className="w-10 h-10 text-verde" />
            </div>
            <h3 className="font-display font-bold text-xl text-bone mb-2">لا توجد Widgets بعد</h3>
            <p className="text-sage text-sm mb-6">أنشئ أول widget وادمجه في موقعك</p>
            <button onClick={() => openEditor()} className="btn-primary">
              إنشاء Widget
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {widgets.map((widget) => (
              <div
                key={widget.id}
                className="bg-pine/70 border border-verde/15 rounded-2xl p-6 hover:border-verde/30 transition-all"
              >
                {/* Header */}
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div
                      className="w-12 h-12 rounded-xl flex items-center justify-center text-white font-bold"
                      style={{ background: widget.primary_color }}
                    >
                      💬
                    </div>
                    <div>
                      <h3 className="font-display font-bold text-lg text-bone">{widget.name}</h3>
                      <p className="text-sage text-xs">
                        {new Date(widget.created_at).toLocaleDateString("ar")}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => toggleWidget(widget.id, !widget.enabled)}
                    className={`px-3 py-1 rounded-full text-xs font-bold ${
                      widget.enabled
                        ? "bg-verde/10 text-verde border border-verde/30"
                        : "bg-oro/10 text-oro border border-oro/30"
                    }`}
                  >
                    {widget.enabled ? "مفعّل" : "معطّل"}
                  </button>
                </div>

                {/* Info */}
                <div className="space-y-2 mb-4">
                  <div className="flex items-center gap-2 text-xs text-sage">
                    <span className="font-mono bg-night/50 px-2 py-1 rounded">
                      {widget.public_token.slice(0, 8)}...
                    </span>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => openEditor(widget)}
                    className="flex-1 btn-secondary flex items-center justify-center gap-1"
                  >
                    <IconEdit className="w-4 h-4" />
                    تعديل
                  </button>
                  <button
                    onClick={() => copyEmbedCode(widget)}
                    className="flex-1 btn-secondary flex items-center justify-center gap-1"
                  >
                    {copiedToken === widget.public_token ? (
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
                  <button
                    onClick={() => setShowDeleteConfirm(widget.id)}
                    className="btn-danger p-2"
                  >
                    <IconTrash className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Editor Modal */}
      {showEditor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-night/80 backdrop-blur-sm">
          <div className="bg-pine border border-verde/20 rounded-3xl w-full max-w-6xl max-h-[90vh] overflow-hidden flex">
            {/* Sidebar */}
            <div className="w-96 border-l border-verde/15 overflow-y-auto">
              <div className="p-6 border-b border-verde/15 flex items-center justify-between">
                <h2 className="font-display font-bold text-xl text-bone">
                  {editingWidget ? "تعديل Widget" : "إنشاء Widget"}
                </h2>
                <button onClick={closeEditor} className="text-sage hover:text-bone">
                  <IconX className="w-5 h-5" />
                </button>
              </div>

              <div className="p-6 space-y-6">
                {/* General */}
                <div>
                  <h3 className="font-bold text-bone mb-3 flex items-center gap-2">
                    <IconSettings className="w-4 h-4" />
                    عام
                  </h3>
                  <div className="space-y-3">
                    <div>
                      <label className="text-xs text-sage mb-1 block">اسم الـ Widget *</label>
                      <input
                        type="text"
                        value={formData.name}
                        onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                        className="input-field"
                        placeholder="مثال: Widget الموقع الرئيسي"
                      />
                    </div>
                  </div>
                </div>

                {/* Appearance */}
                <div>
                  <h3 className="font-bold text-bone mb-3 flex items-center gap-2">
                    <IconPalette className="w-4 h-4" />
                    المظهر
                  </h3>
                  <div className="space-y-3">
                    <div>
                      <label className="text-xs text-sage mb-1 block">اللون الأساسي</label>
                      <div className="flex gap-2">
                        <input
                          type="color"
                          value={formData.primaryColor}
                          onChange={(e) => setFormData({ ...formData, primaryColor: e.target.value })}
                          className="w-12 h-10 rounded-lg border border-verde/20 cursor-pointer"
                        />
                        <input
                          type="text"
                          value={formData.primaryColor}
                          onChange={(e) => setFormData({ ...formData, primaryColor: e.target.value })}
                          className="input-field flex-1"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="text-xs text-sage mb-1 block">الموقع</label>
                      <div className="flex gap-2">
                        <button
                          onClick={() => setFormData({ ...formData, position: "left" })}
                          className={`flex-1 py-2 rounded-lg text-sm font-bold ${
                            formData.position === "left" ? "bg-verde text-ink" : "bg-night/50 text-sage"
                          }`}
                        >
                          يسار
                        </button>
                        <button
                          onClick={() => setFormData({ ...formData, position: "right" })}
                          className={`flex-1 py-2 rounded-lg text-sm font-bold ${
                            formData.position === "right" ? "bg-verde text-ink" : "bg-night/50 text-sage"
                          }`}
                        >
                          يمين
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Chat */}
                <div>
                  <h3 className="font-bold text-bone mb-3 flex items-center gap-2">
                    <IconMessage className="w-4 h-4" />
                    المحادثة
                  </h3>
                  <div className="space-y-3">
                    <div>
                      <label className="text-xs text-sage mb-1 block">رسالة الترحيب</label>
                      <textarea
                        value={formData.welcomeMessage}
                        onChange={(e) => setFormData({ ...formData, welcomeMessage: e.target.value })}
                        className="input-field resize-none"
                        rows={3}
                      />
                    </div>
                    <div>
                      <label className="text-xs text-sage mb-1 block">Placeholder</label>
                      <input
                        type="text"
                        value={formData.placeholder}
                        onChange={(e) => setFormData({ ...formData, placeholder: e.target.value })}
                        className="input-field"
                      />
                    </div>
                  </div>
                </div>

                {/* Branding */}
                <div>
                  <h3 className="font-bold text-bone mb-3 flex items-center gap-2">
                    <IconSparkle className="w-4 h-4" />
                    العلامة التجارية
                  </h3>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formData.showBranding}
                      onChange={(e) => setFormData({ ...formData, showBranding: e.target.checked })}
                      className="w-4 h-4 accent-verde"
                    />
                    <span className="text-sm text-bone">إظهار "مدعوم بواسطة ميلانو"</span>
                  </label>
                </div>

                {/* Installation */}
                {editingWidget && (
                  <div>
                    <h3 className="font-bold text-bone mb-3 flex items-center gap-2">
                      <IconCode className="w-4 h-4" />
                      التضمين
                    </h3>
                    <div className="bg-night/50 border border-verde/15 rounded-lg p-3">
                      <code className="text-xs text-verde break-all" dir="ltr">
                        {`<script src="${API}/widget.js" data-token="${editingWidget.public_token}"></script>`}
                      </code>
                    </div>
                    <button
                      onClick={() => copyEmbedCode(editingWidget)}
                      className="btn-secondary w-full mt-2 flex items-center justify-center gap-2"
                    >
                      {copiedToken === editingWidget.public_token ? (
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
                )}
              </div>

              {/* Footer */}
              <div className="p-6 border-t border-verde/15 flex gap-2">
                <button onClick={closeEditor} className="btn-secondary flex-1">
                  إلغاء
                </button>
                <button onClick={saveWidget} disabled={saving} className="btn-primary flex-1">
                  {saving ? "جارٍ الحفظ..." : "حفظ"}
                </button>
              </div>
            </div>

            {/* Preview */}
            <div className="flex-1 bg-bone overflow-y-auto">
              <div className="p-6 border-b border-verde/15 bg-pine/50">
                <h3 className="font-bold text-bone flex items-center gap-2">
                  <IconEye className="w-4 h-4" />
                  معاينة مباشرة
                </h3>
              </div>
              <div className="p-8">
                <div className="max-w-sm mx-auto">
                  <div
                    className="rounded-2xl shadow-2xl overflow-hidden"
                    style={{ direction: formData.rtl ? "rtl" : "ltr" }}
                  >
                    {/* Header */}
                    <div
                      className="p-4 text-white flex items-center gap-3"
                      style={{ background: formData.primaryColor }}
                    >
                      <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center text-xl">
                        💬
                      </div>
                      <div>
                        <p className="font-bold">{formData.name || "Widget جديد"}</p>
                        <p className="text-xs opacity-90">متصل الآن</p>
                      </div>
                    </div>

                    {/* Messages */}
                    <div className="bg-gray-50 p-4 h-80 flex flex-col gap-3">
                      <div
                        className="self-start bg-white rounded-2xl rounded-bl-md p-3 max-w-[80%] shadow-sm"
                        style={{ direction: "rtl" }}
                      >
                        <p className="text-sm text-gray-800">{formData.welcomeMessage}</p>
                      </div>
                    </div>

                    {/* Input */}
                    <div className="bg-white border-t border-gray-200 p-3 flex items-center gap-2">
                      <input
                        type="text"
                        placeholder={formData.placeholder}
                        className="flex-1 px-3 py-2 border border-gray-300 rounded-full text-sm"
                        readOnly
                      />
                      <button
                        className="w-9 h-9 rounded-full flex items-center justify-center text-white"
                        style={{ background: formData.primaryColor }}
                      >
                        →
                      </button>
                    </div>

                    {/* Branding */}
                    {formData.showBranding && (
                      <div className="bg-white border-t border-gray-200 px-3 py-2 text-center">
                        <p className="text-xs text-gray-500">مدعوم بواسطة ميلانو</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirm */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-night/80 backdrop-blur-sm">
          <div className="bg-pine border border-verde/20 rounded-2xl p-6 max-w-md">
            <h3 className="font-display font-bold text-xl text-bone mb-3">حذف Widget</h3>
            <p className="text-sage text-sm mb-6">
              هل أنت متأكد من حذف هذا الـ widget؟ لا يمكن التراجع عن هذا الإجراء.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setShowDeleteConfirm(null)} className="btn-secondary flex-1">
                إلغاء
              </button>
              <button onClick={() => deleteWidget(showDeleteConfirm)} className="btn-danger flex-1">
                حذف
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-pine border border-verde/30 rounded-full px-6 py-3 shadow-2xl">
          <p className="text-bone text-sm">{toast}</p>
        </div>
      )}
    </div>
  );
}
