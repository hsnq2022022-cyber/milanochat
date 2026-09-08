// ═══════════════════════════════════════════════════════════════════════════════
// صفحة Widgets - القائمة الرئيسية
// ═══════════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useState } from "react";
import { apiAuthFetch } from "../lib/api";
import { getSupabase } from "../lib/supabase";
import type { Widget, WidgetSettings } from "../types/widget";
import { DEFAULT_SETTINGS } from "../types/widget";
import WidgetEditor from "../components/WidgetEditor";
import {
  IconPlus,
  IconEdit,
  IconTrash,
  IconCopy,
  IconCheck,
  IconX,
  IconChat,
} from "../components/Icons";

export default function Widgets() {
  const sb = getSupabase();
  const [token, setToken] = useState<string | null>(null);
  const [widgets, setWidgets] = useState<Widget[]>([]);
  const [loading, setLoading] = useState(true);
  const [showEditor, setShowEditor] = useState(false);
  const [editingWidget, setEditingWidget] = useState<Widget | null>(null);
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
    setEditingWidget(widget ?? null);
    setShowEditor(true);
  };

  const closeEditor = () => {
    setShowEditor(false);
    setEditingWidget(null);
  };

  const saveWidget = async (name: string, settings: WidgetSettings) => {
    if (!token) return;
    setSaving(true);
    try {
      if (editingWidget) {
        await apiAuthFetch(token, `/api/widgets/dashboard/${editingWidget.id}`, {
          method: "PUT",
          body: JSON.stringify({ name, settings }),
        });
        showToast("تم تحديث الـ widget بنجاح");
      } else {
        await apiAuthFetch(token, "/api/widgets/dashboard", {
          method: "POST",
          body: JSON.stringify({ name, settings }),
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
    const code = `<script src="https://milanochat-production.up.railway.app/widget.js" data-token="${widget.public_token}"></script>`;
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
                      style={{ background: widget.settings?.appearance?.primaryColor ?? "#2ec27e" }}
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

      {/* Editor */}
      {showEditor && (
        <WidgetEditor
          widget={editingWidget}
          onSave={saveWidget}
          onClose={closeEditor}
          saving={saving}
        />
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
