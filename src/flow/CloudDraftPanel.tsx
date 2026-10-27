import { useMemo, useState } from "react";
import { Cloud, Download, UploadCloud, X } from "lucide-react";
import { getSupabase } from "../lib/supabase";
import { useFlowStore } from "./store";
import { snapshotLibrary } from "./library";
import {
  compareCloudDrafts, fetchCloudDrafts, resolveCloudTenant, saveCloudDraft,
} from "./cloudDraft";
import type { DecodeResult, SaveResult } from "./cloudDraft";
import type { FlowLanguage } from "./uiLocale";

type Props = { onClose: () => void; language: FlowLanguage };
const control = "min-h-11 rounded-xl border border-[#173D30] bg-[#0F2E24] px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40 hover:border-[#3DD189]";

export default function CloudDraftPanel({ onClose, language }: Props) {
  const english = language === "en";
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState<DecodeResult | null>(null);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const doc = useFlowStore(s => s.doc);
  const activeFlowId = useFlowStore(s => s.activeFlowId);
  const flows = useFlowStore(s => s.flows);
  const library = useMemo(
    () => snapshotLibrary(activeFlowId, doc, flows),
    [activeFlowId, doc, flows]
  );
  const comparison = useMemo(
    () => loaded ? compareCloudDrafts(library.flows, loaded) : null,
    [library, loaded]
  );

  const load = async () => {
    const client = getSupabase();
    setLoaded(null);
    setTenantId(null);
    if (!client) {
      setNotice(english ? "Supabase is not configured for this preview." : "لم يتم إعداد Supabase لهذه المعاينة.");
      return;
    }
    setBusy(true);
    setNotice("");
    try {
      // تحديد المتجر من هوية المستخدم الموثقة، وليس من قيمة يدخلها الزائر.
      const tenant = await resolveCloudTenant(client);
      if (!tenant) throw new Error("missing tenant");
      const rows = await fetchCloudDrafts(client, tenant);
      setTenantId(tenant);
      setLoaded(rows);
      setNotice(english ? "Cloud list loaded. Nothing was replaced." : "تم عرض المسودات السحابية دون استبدال بياناتك المحلية.");
    } catch {
      setNotice(english ? "Cloud storage is unavailable for this account." : "التخزين السحابي غير متاح لهذا الحساب أو لم يُجهّز بعد.");
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const client = getSupabase();
    if (!client || !tenantId || !loaded || busy || loaded.skipped > 0) return;
    const current = library.flows.find(flow => flow.id === activeFlowId);
    if (!current) return;
    const remote = loaded.drafts.find(item => item.flow.id === current.id);
    const approved = window.confirm(english
      ? "Save " + current.doc.name + " as a cloud DRAFT only? Existing cloud revision: " + (remote?.revision ?? "none") + ". This never publishes a flow."
      : "حفظ «" + current.doc.name + "» كمسودة سحابية فقط؟ المراجعة الموجودة: " + (remote?.revision ?? "لا توجد") + ". لن يتم تشغيل أتمتة حقيقية.");
    if (!approved) return;
    setBusy(true);
    try {
      // رقم المراجعة يحمي من الكتابة فوق تعديل أحدث على جهاز آخر.
      const result: SaveResult = await saveCloudDraft(client, tenantId, current, remote?.revision ?? null);
      if (result.status === "saved") {
        setNotice(english ? "Cloud draft saved, revision " + result.revision + "." : "تم الحفظ السحابي للمراجعة " + result.revision + ".");
        try {
          setLoaded(await fetchCloudDrafts(client, tenantId));
        } catch {
          setLoaded(null);
          setNotice(english ? "Saved, but list refresh failed. Reload before another save." : "نجح الحفظ لكن فشل تحديث القائمة؛ أعد تحميلها قبل أي حفظ آخر.");
        }
      } else if (result.status === "conflict") {
        setLoaded(null);
        setNotice(english ? "A newer cloud revision exists. Reload and review." : "توجد مراجعة سحابية أحدث؛ أعد التحميل والمراجعة.");
      } else {
        setNotice(english ? "Cloud save unavailable: " + result.status : "تعذّر الحفظ السحابي: " + result.status);
      }
    } catch {
      setNotice(english ? "Could not prepare a safe draft upload." : "تعذّر تجهيز المسودة للرفع الآمن.");
    } finally {
      setBusy(false);
    }
  };

  const restoreCopy = (flowKey: string) => {
    const remote = loaded?.drafts.find(item => item.flow.id === flowKey);
    if (!remote || busy) return;
    if (!window.confirm(english
      ? "Create a NEW INACTIVE local copy of " + remote.flow.doc.name + "? Existing drafts will remain untouched."
      : "استرجاع «" + remote.flow.doc.name + "» كنسخة محلية جديدة وغير مفعّلة؟ لن تُستبدل المسودات الحالية.")) return;
    // لا يستبدل التدفق المفتوح ولا يفعّل النسخة المسترجعة.
    const restored = useFlowStore.getState().restoreCloudCopy(remote, crypto.randomUUID());
    setNotice(restored
      ? (english ? "Restored a separate inactive copy." : "استُرجعت نسخة مستقلة وغير مفعّلة.")
      : (english ? "Restore failed: invalid identifier or library capacity." : "تعذّر الاسترجاع؛ تحقق من سعة المكتبة المحلية."));
  };

  return <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 p-3" dir={english ? "ltr" : "rtl"}>
    <section role="dialog" aria-modal="true" aria-label={english ? "Cloud drafts" : "المسودات السحابية"}
      className="flex max-h-[85dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[#173D30] bg-[#0B241C] text-white shadow-2xl">
      <header className="flex items-center justify-between gap-3 border-b border-[#173D30] p-4">
        <div className="flex items-center gap-2 text-sm font-bold"><Cloud size={19} className="text-[#3DD189]" />
          {english ? "Cloud drafts — opt-in preview" : "المسودات السحابية — معاينة اختيارية"}</div>
        <button type="button" className={control} aria-label={english ? "Close cloud drafts" : "إغلاق المسودات السحابية"} onClick={onClose}><X size={16}/></button>
      </header>
      <div className="space-y-3 overflow-y-auto p-4 text-sm">
        <p className="text-xs leading-6 text-[#B8CAC2]">{english
          ? "No automatic transfers. Cloud saves never publish flows. Restores create separate inactive copies."
          : "لا يحدث رفع أو تنزيل تلقائي. الحفظ السحابي لا ينشر التدفقات. والاسترجاع ينشئ نسخة مستقلة وغير مفعّلة."}</p>
        <div className="flex flex-wrap gap-2">
          <button className={control} disabled={busy} onClick={() => void load()}>
            <Download className="inline" size={15}/> {english ? "Fetch cloud list" : "عرض المسودات السحابية"}
          </button>
          <button className={control} disabled={!loaded || !tenantId || busy || loaded.skipped > 0} onClick={() => void save()}>
            <UploadCloud className="inline" size={15}/> {english ? "Save current draft" : "حفظ التدفق الحالي سحابيًا"}
          </button>
        </div>
        {notice && <p role="status" className="rounded-lg border border-[#275443] bg-[#0F2E24] p-3 text-xs leading-6">{notice}</p>}
        {loaded && <div className="space-y-2">
          <p className="text-xs text-[#B8CAC2]">{english ? "Valid: " : "الصالح: "}{loaded.drafts.length} — {english ? "Skipped: " : "المرفوض: "}{loaded.skipped}</p>
          {loaded.skipped > 0 && <p role="alert" className="text-xs text-[#E5B54B]">{english
            ? "Malformed rows detected. Cloud saving is blocked for review."
            : "تم العثور على سجلات تالفة؛ الحفظ السحابي متوقف لحين المراجعة."}</p>}
          {loaded.drafts.map(remote => {
            const status = comparison?.items.find(item => item.flowKey === remote.flow.id)?.status ?? "cloud_only";
            const descriptions: Record<string, string> = english
              ? { identical: "Identical", different: "Different", cloud_only: "Cloud only", local_only: "Local only" }
              : { identical: "متطابق", different: "مختلف عن المحلي", cloud_only: "سحابي فقط", local_only: "محلي فقط" };
            return <div key={remote.flow.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#173D30] bg-[#0F2E24] p-3">
              <div className="min-w-0">
                <div className="break-words font-semibold">{remote.flow.doc.name}</div>
                <div className="text-xs text-[#8B9E96]">{descriptions[status]} · {english ? "Revision" : "مراجعة"} {remote.revision}</div>
              </div>
              <button className={control} disabled={busy || library.flows.length >= 30}
                onClick={() => restoreCopy(remote.flow.id)}>{english ? "Restore inactive copy" : "استرجاع كنسخة غير مفعّلة"}</button>
            </div>;
          })}
          {!loaded.drafts.length && <p className="text-xs text-[#8B9E96]">{english ? "No cloud drafts." : "لا توجد مسودات سحابية."}</p>}
        </div>}
      </div>
    </section>
  </div>;
}
