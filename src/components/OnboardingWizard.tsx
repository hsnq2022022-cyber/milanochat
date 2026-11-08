import { useEffect, useRef, useState } from "react";
import { Check, Plug, Sparkles, Workflow, X } from "lucide-react";

/* معالج البدء: يُعرض من لوحة التحكم فقط لمستخدم جديد بلا قنوات مربوطة.
   لا يطلب أي بيانات بنفسه — كل شيء يصله من Dashboard (القنوات، رسالة التوجيه). */
export const onboardingKey = (tenantId: string) => `milano.onboarding.v1:${tenantId}`;

export function readOnboardingDone(tenantId: string): boolean {
  try { return localStorage.getItem(onboardingKey(tenantId)) !== null; } catch { return false; }
}
export function writeOnboardingDone(tenantId: string, value: "done" | "skipped") {
  try { localStorage.setItem(onboardingKey(tenantId), value); } catch { /* التخزين غير متاح */ }
}

type Props = {
  agentPrompt: string;
  onAgentPromptChange: (v: string) => void;
  onSavePrompt: () => void;
  savingPrompt: boolean;
  onConnectSocial: (platform: "facebook" | "instagram") => void;
  onOpenChannels: () => void;
  onCreateFlow: () => Promise<void> | void;
  onFinish: (how: "done" | "skipped") => void;
};

const STEPS = [
  { title: "ربط قناة", icon: Plug },
  { title: "تعليمات الذكاء الاصطناعي", icon: Sparkles },
  { title: "إنشاء تدفق", icon: Workflow },
];

const btnPrimary = "inline-flex items-center justify-center min-h-[44px] px-4 rounded-xl bg-[#3DD189] text-[#061A14] font-bold text-sm transition-colors duration-200 ease-out hover:bg-[#E5B54B] disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-[#3DD189] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B241C]";
const btnGhost = "inline-flex items-center justify-center min-h-[44px] px-4 rounded-xl border border-[#173D30] bg-[#0F2E24] text-white font-bold text-sm transition-colors duration-200 ease-out hover:border-[#3DD189] disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-[#3DD189]";

export default function OnboardingWizard(p: Props) {
  const [step, setStep] = useState(0);
  const [confirmSkip, setConfirmSkip] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  /* تركيز أول عنصر عند الفتح وإعادته عند الإغلاق */
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("button, [href], textarea")?.focus();
    return () => prev?.focus?.();
  }, []);
  const mounted = useRef(false);
  useEffect(() => {
    if (confirmSkip) ref.current?.querySelector<HTMLElement>('[data-testid="onboarding-skip-confirm"]')?.focus();
    else if (mounted.current) ref.current?.querySelector<HTMLElement>('[data-testid="onboarding-close"]')?.focus();
    mounted.current = true;
  }, [confirmSkip]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); setConfirmSkip(true); return; }
    if (e.key !== "Tab") return;
    const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], textarea:not([disabled])') ?? []);
    if (!nodes.length) return;
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  const createFlow = async () => {
    setBusy(true);
    try { await p.onCreateFlow(); } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-[#061A14]/80 backdrop-blur-sm p-3 sm:p-6" dir="rtl">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        data-testid="onboarding-wizard"
        onKeyDown={onKeyDown}
        className="w-full max-w-lg max-h-[calc(100dvh-1.5rem)] overflow-y-auto bg-[#0B241C] border border-[#173D30] rounded-xl p-4 sm:p-6 text-white"
      >
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="min-w-0">
            <h2 id="onboarding-title" className="font-bold text-xl text-white">ابدأ إعداد حسابك</h2>
            <p className="text-sm font-normal text-[#8B9E96] mt-1" data-testid="onboarding-progress">الخطوة {step + 1} من {STEPS.length}</p>
          </div>
          <button
            type="button"
            onClick={() => setConfirmSkip(true)}
            aria-label="إغلاق معالج الإعداد"
            data-testid="onboarding-close"
            className="w-11 h-11 shrink-0 inline-flex items-center justify-center rounded-xl text-[#8B9E96] hover:text-white hover:bg-[#0F2E24] transition-colors duration-200 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-[#3DD189]"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <ol className="flex items-center gap-2 mb-4" aria-label="خطوات الإعداد">
          {STEPS.map((s, i) => {
            const Icon = s.icon;
            const state = i < step ? "done" : i === step ? "current" : "todo";
            return (
              <li key={s.title} aria-current={state === "current" ? "step" : undefined} data-testid={`onboarding-step-${i + 1}`} data-state={state} className="flex-1 min-w-0">
                <div className={`h-1 rounded-full mb-2 ${state === "todo" ? "bg-[#173D30]" : "bg-[#3DD189]"}`} />
                <span className={`flex items-start gap-1 text-xs leading-4 ${state === "current" ? "text-white font-bold" : "text-[#8B9E96] font-normal"}`}>
                  {state === "done" ? <Check className="w-4 h-4 shrink-0 text-[#3DD189]" aria-hidden="true" /> : <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />}
                  <span className="min-w-0 break-words">{s.title}</span>
                </span>
              </li>
            );
          })}
        </ol>

        {confirmSkip ? (
          <div role="alertdialog" aria-labelledby="onboarding-skip-title" className="bg-[#0F2E24] border border-[#173D30] rounded-xl p-4">
            <h3 id="onboarding-skip-title" className="font-bold text-lg text-[#E5B54B]">تخطي الإعداد؟</h3>
            <p className="text-sm font-normal text-[#8B9E96] mt-1 mb-4">لن يظهر هذا المعالج مرة أخرى، ويمكنك ربط القنوات من تبويب «القنوات» في أي وقت.</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" data-testid="onboarding-skip-confirm" onClick={() => p.onFinish("skipped")} className={btnPrimary}>نعم، تخطَّ</button>
              <button type="button" data-testid="onboarding-skip-cancel" onClick={() => setConfirmSkip(false)} className={btnGhost}>متابعة الإعداد</button>
            </div>
          </div>
        ) : (
          <>
            {step === 0 && (
              <section data-testid="onboarding-panel-channel">
                <h3 className="font-bold text-lg mb-1">ربط قناة</h3>
                <p className="text-sm font-normal text-[#8B9E96] mb-3">اربط قناة واحدة على الأقل ليبدأ الرد الآلي على رسائل عملائك.</p>
                <div className="grid gap-2">
                  <button type="button" onClick={p.onOpenChannels} className={btnPrimary} data-testid="onboarding-connect-whatsapp">واتساب — فتح إعداد الربط</button>
                  <button type="button" onClick={() => p.onConnectSocial("facebook")} className={btnGhost} data-testid="onboarding-connect-facebook">Facebook Messenger</button>
                  <button type="button" onClick={() => p.onConnectSocial("instagram")} className={btnGhost} data-testid="onboarding-connect-instagram">Instagram</button>
                </div>
              </section>
            )}
            {step === 1 && (
              <section data-testid="onboarding-panel-prompt">
                <h3 className="font-bold text-lg mb-1">تعليمات الذكاء الاصطناعي</h3>
                <label htmlFor="onboarding-prompt" className="block text-sm font-normal text-[#8B9E96] mb-2">اكتب كيف تريد أن يتحدث الموظف الآلي مع عملائك (اختياري).</label>
                <textarea
                  id="onboarding-prompt"
                  value={p.agentPrompt}
                  onChange={(e) => p.onAgentPromptChange(e.target.value)}
                  maxLength={8000}
                  rows={5}
                  className="w-full bg-[#0F2E24] border border-[#173D30] rounded-xl p-3 text-sm font-normal text-white focus:outline-none focus:ring-2 focus:ring-[#3DD189]"
                />
                <button type="button" onClick={p.onSavePrompt} disabled={p.savingPrompt} className={`${btnGhost} mt-2`} data-testid="onboarding-save-prompt">
                  {p.savingPrompt ? "جارٍ الحفظ…" : "حفظ التعليمات"}
                </button>
              </section>
            )}
            {step === 2 && (
              <section data-testid="onboarding-panel-flow">
                <h3 className="font-bold text-lg mb-1">إنشاء تدفق</h3>
                <p className="text-sm font-normal text-[#8B9E96] mb-3">التدفق يحدد خطوات الرد على العميل. سننشئ لك تدفقًا جديدًا ونفتح محرر التدفقات.</p>
                <button type="button" onClick={createFlow} disabled={busy} className={btnPrimary} data-testid="onboarding-create-flow">
                  {busy ? "جارٍ الإنشاء…" : "إنشاء تدفق جديد"}
                </button>
              </section>
            )}

            <div className="flex items-center justify-between gap-2 mt-5 pt-4 border-t border-[#173D30]">
              <button type="button" onClick={() => setConfirmSkip(true)} className="min-h-[44px] px-2 text-sm font-normal text-[#8B9E96] hover:text-white transition-colors duration-200 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-[#3DD189] rounded-xl" data-testid="onboarding-skip">تخطي</button>
              <div className="flex gap-2">
                {step > 0 && <button type="button" onClick={() => setStep(step - 1)} className={btnGhost} data-testid="onboarding-back">السابق</button>}
                {step < STEPS.length - 1
                  ? <button type="button" onClick={() => setStep(step + 1)} className={btnPrimary} data-testid="onboarding-next">التالي</button>
                  : <button type="button" onClick={() => p.onFinish("done")} className={btnGhost} data-testid="onboarding-finish">إنهاء</button>}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
