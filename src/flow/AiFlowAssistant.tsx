import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { AlertTriangle, Loader2, Sparkles, X } from "lucide-react";
import { getSupabase } from "../lib/supabase";
import { uuid } from "../lib/uuid.ts";
import { resolveCloudTenant } from "./cloudDraft.ts";
import { useFlowStore } from "./store";
import { useLayoutDirection } from "./direction";
import { buildAppend, buildReplace, isDefaultFlow, prepareGenerated } from "./aiFlowApply.ts";
import type { FlowDocument } from "./model.ts";

/**
 * «مساعد الذكاء الاصطناعي»: asks the `generate-flow` Edge Function for a DRAFT flow and applies it
 * to the canvas only after the user chooses replace/append. Every apply goes through store.replace()
 * (one undo entry) and leaves the current flow untouched on any failure.
 */
export const AI_PROMPT_MAX = 1500;
export const AI_CREDITS = 5;
const NETWORK_MESSAGE = "تعذر الاتصال، حاول مرة أخرى";
const FALLBACK: Record<string, string> = {
  insufficient_credits: "رصيدك غير كافٍ لتوليد التدفق.",
  generation_failed: "تعذر توليد التدفق، حاول مرة أخرى.",
  ai_unavailable: "خدمة الذكاء الاصطناعي غير متاحة حاليًا، حاول لاحقًا.",
  invalid_request: "الطلب غير صالح، عدّل الوصف وحاول مرة أخرى.",
  rate_limited: "محاولات كثيرة، انتظر قليلًا ثم أعد المحاولة.",
  unauthorized: "سجّل الدخول ثم أعد المحاولة.",
};
const FOCUSABLE = 'button:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])';

type Failure = { code: string; message: string; network: boolean };
type Success = { document: unknown; cached: boolean };
type Reply = { ok?: boolean; error?: string; message?: string; cached?: boolean; document?: { nodes: unknown; edges: unknown } };
type Phase = "form" | "loading" | "choice" | "confirmReplace";

function failure(code: string, message: unknown, network = false): Failure {
  if (code === "disabled") return { code, message: "الميزة غير مفعّلة بعد", network };
  const text = typeof message === "string" && message.trim() ? message : FALLBACK[code] ?? NETWORK_MESSAGE;
  return { code, message: text, network };
}

async function callGenerate(prompt: string, requestId: string, signal: AbortSignal): Promise<Success> {
  const client = getSupabase();
  if (!client) throw failure("unknown", NETWORK_MESSAGE, true);
  // Tenant comes from the authenticated user (same lookup the cloud-drafts panel uses), never from user input.
  const tenantId = await resolveCloudTenant(client).catch(() => null);
  if (signal.aborted) throw new DOMException("aborted", "AbortError");
  if (!tenantId) throw failure("unauthorized", FALLBACK.unauthorized);
  const { data, error } = await client.functions.invoke("generate-flow", {
    body: { prompt, tenant_id: tenantId, request_id: requestId }, signal,
  });
  let reply: Reply | null = (data ?? null) as Reply | null;
  if (error) {
    const ctx = (error as { context?: unknown }).context;
    if (!(ctx instanceof Response)) {
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      throw failure("unknown", NETWORK_MESSAGE, true);
    }
    reply = await ctx.json().catch(() => null) as Reply | null;
    if (!reply || typeof reply !== "object") throw failure("unknown", NETWORK_MESSAGE, ctx.status >= 500);
  }
  if (reply?.ok === true) {
    // A malformed document is rejected by prepareGenerated(), not treated as a network error.
    return { document: reply.document ?? null, cached: reply.cached === true };
  }
  if (reply?.ok === false || error) throw failure(String(reply?.error ?? "unknown"), reply?.message);
  throw failure("unknown", NETWORK_MESSAGE, true);
}

type Props = { onClose: () => void; onApplied: (message: string) => void };

export default function AiFlowAssistant({ onClose, onApplied }: Props) {
  const [phase, setPhase] = useState<Phase>("form");
  const [prompt, setPrompt] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [error, setError] = useState<Failure | null>(null);
  const [draft, setDraft] = useState<{ doc: FlowDocument; cached: boolean } | null>(null);
  const [askCancel, setAskCancel] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null), areaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // One request_id per submission; reused only when retrying the same prompt after a network failure.
  const idRef = useRef<{ id: string; prompt: string; reusable: boolean } | null>(null);
  const closing = useRef(false);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    areaRef.current?.focus();
    return () => {
      abortRef.current?.abort();
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);
  // After a phase change the focused element may have unmounted: keep focus inside the dialog.
  useEffect(() => {
    const active = document.activeElement;
    if (dialogRef.current && (!active || !dialogRef.current.contains(active) || active === document.body)) {
      (dialogRef.current.querySelector<HTMLElement>("[data-autofocus]") ?? dialogRef.current).focus();
    }
  }, [phase, error, askCancel]);

  const requestClose = () => {
    if (phase === "loading") { setAskCancel(true); return; }
    onClose();
  };
  const abortAndClose = () => { closing.current = true; abortRef.current?.abort(); onClose(); };

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (askCancel) setAskCancel(false); else requestClose(); return; }
    if (e.ctrlKey || e.metaKey) e.stopPropagation(); // canvas undo/copy shortcuts must not fire behind the dialog
    if (e.key !== "Tab" || !dialogRef.current) return;
    const items = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => el.offsetParent !== null);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0], last = items[items.length - 1], active = document.activeElement;
    if (e.shiftKey && (active === first || active === dialogRef.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  };

  const generate = async () => {
    const text = prompt.trim();
    if (!text) { setFieldError("اكتب وصفًا للتدفق الذي تريده أولًا."); areaRef.current?.focus(); return; }
    setFieldError(""); setError(null);
    const prev = idRef.current;
    const reuse = !!prev && prev.reusable && prev.prompt === text;
    const requestId = reuse ? prev!.id : uuid();
    idRef.current = { id: requestId, prompt: text, reusable: false };
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("loading");
    try {
      const res = await callGenerate(text, requestId, controller.signal);
      if (controller.signal.aborted || closing.current) return;
      const prepared = prepareGenerated(res.document);
      if (!prepared.ok) { setError({ code: "invalid_document", message: prepared.message, network: false }); setPhase("form"); return; }
      setDraft({ doc: prepared.doc, cached: res.cached });
      setPhase("choice");
    } catch (e) {
      if (controller.signal.aborted || closing.current) return;
      const f = e && typeof e === "object" && "code" in e ? e as Failure : failure("unknown", NETWORK_MESSAGE, true);
      if (f.network && idRef.current) idRef.current.reusable = true;
      setError(f); setPhase("form");
    }
  };

  const apply = (mode: "replace" | "append") => {
    if (!draft) return;
    try {
      const state = useFlowStore.getState();
      const direction = useLayoutDirection.getState().direction;
      const outcome = mode === "replace" ? buildReplace(state.doc, draft.doc, direction) : buildAppend(state.doc, draft.doc, direction);
      state.replace(outcome.doc);
      state.setSelected(null);
      const parts = ["تم تطبيق التدفق — راجعه قبل التفعيل"];
      if (outcome.droppedTrigger) parts.push("لم تُضَف بداية جديدة لأن في تدفقك بداية؛ اربط أول خطوة مضافة بالمكان المناسب يدويًا");
      if (draft.cached) parts.push("تم استرجاع نتيجة سابقة بدون خصم");
      onApplied(parts.join(" · "));
      closing.current = true;
      onClose();
    } catch {
      // store.replace is the last step, so a throw above leaves the flow untouched.
      setDraft(null); setPhase("form");
      setError({ code: "apply_failed", message: "تعذر تطبيق التدفق على اللوحة. لم يتغيّر تدفقك الحالي.", network: false });
    }
  };
  const chooseReplace = () => {
    if (!isDefaultFlow(useFlowStore.getState().doc)) { setPhase("confirmReplace"); return; }
    apply("replace");
  };

  const ring = "focus:outline-none focus-visible:ring-2 focus-visible:ring-[#3DD189]";
  const btn = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-bold transition-colors duration-200 ease-out disabled:cursor-not-allowed disabled:opacity-50 " + ring;
  const secondary = btn + " border border-[#173D30] bg-[#0F2E24] text-white hover:border-[#3DD189]";
  const primary = btn + " bg-[#3DD189] text-[#04130d] hover:bg-[#5BE0A2]";
  const loading = phase === "loading";
  const topUp = error?.code === "insufficient_credits";

  return <div className="fixed inset-0 z-[95] flex items-end justify-center bg-black/70 p-3 sm:items-center" dir="rtl"
    onMouseDown={e => { if (e.target === e.currentTarget) requestClose(); }}>
    <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="ai-flow-title" data-testid="ai-flow-dialog" onKeyDown={onKey}
      className="flex max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-[#173D30] bg-[#0B241C] text-white shadow-2xl focus:outline-none">
      <header className="flex items-center justify-between gap-3 border-b border-[#173D30] p-4">
        <h2 id="ai-flow-title" className="fs-display flex items-center gap-2 text-xl"><Sparkles size={20} className="text-[#E5B54B]" aria-hidden="true" />مساعد الذكاء الاصطناعي</h2>
        <button type="button" aria-label="إغلاق" onClick={requestClose}
          className={"grid h-11 w-11 place-items-center rounded-xl text-[#8B9E96] transition-colors duration-200 ease-out hover:bg-[#0F2E24] hover:text-white " + ring}><X size={20} /></button>
      </header>
      <div className="space-y-4 overflow-y-auto p-4 sm:p-6">
        {(phase === "form" || loading) && <>
          <p className="text-sm leading-7 text-[#8B9E96]">اكتب وصفًا لما تريد، وسأولّد لك <b className="text-white">مسودة تدفق</b> جاهزة للتعديل. التوليد يكلّف <b className="text-[#E5B54B]">{AI_CREDITS} أرصدة</b>. لن يُطبَّق شيء على اللوحة قبل أن تراجع النتيجة وتختار الاستبدال أو الإضافة.</p>
          <div>
            <label htmlFor="ai-flow-prompt" className="mb-2 block text-sm font-bold">وصف التدفق</label>
            <textarea id="ai-flow-prompt" ref={areaRef} data-testid="ai-flow-prompt" value={prompt} rows={5} maxLength={AI_PROMPT_MAX} required
              disabled={loading} aria-invalid={!!fieldError} aria-describedby="ai-flow-count ai-flow-field-error"
              placeholder="تدفق ترحيبي لمتجر ملابس: يرحب بالعميل ويسأله عن القسم…"
              onChange={e => { setPrompt(e.target.value); if (fieldError) setFieldError(""); }}
              className={"w-full resize-y rounded-xl border bg-[#0F2E24] p-3 text-sm leading-7 text-white placeholder:text-[#8B9E96] disabled:cursor-not-allowed disabled:opacity-50 " + (fieldError ? "border-[#F45B69] " : "border-[#173D30] ") + ring} />
            <div className="mt-1 flex items-start justify-between gap-3 text-xs">
              <span id="ai-flow-field-error" className="text-[#FDA4AE]" role={fieldError ? "alert" : undefined}>{fieldError}</span>
              <span id="ai-flow-count" className="shrink-0 text-[#8B9E96]" dir="ltr">{prompt.length} / {AI_PROMPT_MAX}</span>
            </div>
          </div>
          {error && <div role="alert" data-testid="ai-flow-error" className="flex items-start gap-3 rounded-xl border border-[#F45B69]/50 bg-[#F45B69]/10 p-3 text-sm leading-7 text-[#FDA4AE]">
            <AlertTriangle size={18} className="mt-1 shrink-0" aria-hidden="true" />
            <div className="min-w-0 break-words">
              <p>{error.message}</p>
              {topUp && <a href="#/dashboard?pay=1" className={"mt-2 inline-flex min-h-11 items-center font-bold text-[#E5B54B] underline " + ring}>شحن الرصيد</a>}
            </div>
          </div>}
          {askCancel && loading && <div role="alertdialog" aria-labelledby="ai-flow-cancel" className="rounded-xl border border-[#E5B54B]/50 bg-[#E5B54B]/10 p-3 text-sm leading-7">
            <p id="ai-flow-cancel" className="text-[#E5B54B]">إيقاف الطلب الآن؟ قد يكون الخادم بدأ التوليد وقد يُخصم الرصيد حتى لو أُلغي الطلب.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" data-autofocus className={secondary} onClick={() => setAskCancel(false)}>متابعة الانتظار</button>
              <button type="button" data-testid="ai-flow-abort" className={btn + " border border-[#F45B69]/60 text-[#FDA4AE] hover:bg-[#F45B69]/10"} onClick={abortAndClose}>إيقاف وإغلاق</button>
            </div>
          </div>}
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className={secondary} onClick={requestClose}>إلغاء</button>
            <button type="button" data-testid="ai-flow-generate" className={primary} disabled={loading} aria-busy={loading} onClick={() => void generate()}>
              {loading ? <><Loader2 size={18} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />جارٍ توليد التدفق…</> : error ? "إعادة المحاولة" : "توليد التدفق"}
            </button>
          </div>
        </>}
        {phase === "choice" && draft && <>
          <h3 className="text-lg font-bold">استبدال التدفق الحالي أم إضافة إليه؟</h3>
          <p className="text-sm leading-7 text-[#8B9E96]">جاهز: {draft.doc.nodes.length} خطوة. {draft.cached && <span className="text-[#E5B54B]">تم استرجاع نتيجة سابقة بدون خصم. </span>}يمكنك التراجع بعد التطبيق (Ctrl+Z أو زر التراجع).</p>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className={secondary} onClick={onClose}>إلغاء</button>
            <button type="button" data-testid="ai-flow-append" data-autofocus className={secondary} onClick={() => apply("append")}>إضافة</button>
            <button type="button" data-testid="ai-flow-replace" className={primary} onClick={chooseReplace}>استبدال</button>
          </div>
        </>}
        {phase === "confirmReplace" && <>
          <div role="alert" className="flex items-start gap-3 rounded-xl border border-[#E5B54B]/50 bg-[#E5B54B]/10 p-3 text-sm leading-7 text-[#E5B54B]">
            <AlertTriangle size={18} className="mt-1 shrink-0" aria-hidden="true" />
            <p>سيتم استبدال التدفق الحالي. هل أنت متأكد؟ <span className="text-[#8B9E96]">يمكنك التراجع بـ Ctrl+Z أو زر التراجع.</span></p>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" data-autofocus className={secondary} onClick={() => setPhase("choice")}>رجوع</button>
            <button type="button" data-testid="ai-flow-replace-confirm" className={primary} onClick={() => apply("replace")}>نعم، استبدل</button>
          </div>
        </>}
      </div>
    </div>
  </div>;
}
