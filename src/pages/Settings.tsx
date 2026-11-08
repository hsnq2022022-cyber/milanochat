import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowRight, ChevronDown, Wallet, Bell, ShieldCheck, MessageSquare, HelpCircle, Loader2 } from "lucide-react";
import { getSupabase } from "../lib/supabase";
import { apiAuthFetch } from "../lib/api";
import DeliveryReviewPanel from "./DeliveryReviewPanel";
import StaffInboxPanel from "./StaffInboxPanel";

/* الإعدادات: البريد من جلسة Supabase؛ اسم المتجر والرصيد من نفس ملخص لوحة التحكم (/api/dashboard/summary).
   الخطة غير متوفرة في حالة التطبيق حاليًا فتظهر «—». */
type Summary = { tenantId: string; businessName: string; credits: number; openUnresolved: number };

function Section({ id, testid, icon, title, desc, defaultOpen, children }: {
  id: string; testid: string; icon: ReactNode; title: string; desc: string; defaultOpen?: boolean; children: ReactNode;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <section data-testid={testid} className="bg-pine/70 border border-verde/15 rounded-2xl mb-3 overflow-hidden">
      <h2>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={`settings-panel-${id}`}
          data-testid={`${testid}-toggle`}
          className="w-full min-h-[44px] flex items-center gap-3 p-4 text-start focus-visible:outline focus-visible:outline-2 focus-visible:outline-oro"
        >
          <span className="w-10 h-10 shrink-0 rounded-xl bg-moss text-verde flex items-center justify-center" aria-hidden="true">{icon}</span>
          <span className="flex-1 min-w-0">
            <span className="block font-display font-bold text-lg text-bone">{title}</span>
            <span className="block text-sm font-normal text-sage">{desc}</span>
          </span>
          <ChevronDown className={`w-5 h-5 shrink-0 text-sage transition-transform duration-200 ${open ? "rotate-180" : ""}`} aria-hidden="true" />
        </button>
      </h2>
      {open && (
        <div id={`settings-panel-${id}`} className="px-3 pb-4 sm:px-4">
          {children}
        </div>
      )}
    </section>
  );
}

const linkCls = "inline-flex items-center justify-center min-h-[44px] px-4 rounded-xl border border-verde/30 text-verde font-bold text-sm hover:border-oro/60 hover:text-oro transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-oro";

export default function Settings() {
  const sb = useMemo(() => getSupabase(), []);
  const [email, setEmail] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [sumState, setSumState] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const plan: string | null = null;

  useEffect(() => {
    if (!sb) { setSumState("error"); return; }
    let alive = true;
    sb.auth.getSession().then(({ data }) => {
      if (!alive) return;
      setEmail(data.session?.user?.email ?? null);
      setToken(data.session?.access_token ?? null);
      if (!data.session) setSumState("error");
    });
    return () => {
      alive = false;
    };
  }, [sb]);

  useEffect(() => {
    if (!token) return;
    let alive = true;
    setSumState("loading");
    apiAuthFetch<any>(token, "/api/dashboard/summary")
      .then((s) => {
        if (!alive) return;
        setSummary({
          tenantId: s.tenant.id,
          businessName: s.tenant.businessName,
          credits: s.tenant.creditsRemaining,
          openUnresolved: s.openUnresolved ?? 0,
        });
        setSumState("ready");
      })
      .catch(() => alive && setSumState("error"));
    return () => {
      alive = false;
    };
  }, [token]);

  const logout = async () => {
    setBusy(true);
    try {
      if (sb) await sb.auth.signOut();
    } finally {
      window.location.hash = "#/dashboard";
      setBusy(false);
    }
  };

  const row = "flex items-center justify-between gap-3 py-3 border-b border-verde/10 last:border-0";
  const loadingBox = (
    <p role="status" className="flex items-center gap-2 text-sm text-sage py-3"><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />جارٍ التحميل…</p>
  );
  const errorBox = <p role="alert" className="text-sm text-oro py-3">تعذر تحميل البيانات. حاول مرة أخرى لاحقًا.</p>;
  const showReview = import.meta.env.VITE_ENABLE_DELIVERY_REVIEW !== "false";
  const credits = summary?.credits ?? 0;
  const creditPct = Math.max(0, Math.min(100, (credits / 1000) * 100));

  return (
    <div className="min-h-screen bg-night text-bone font-body" dir="rtl">
      <main className="max-w-md mx-auto px-4 pt-5 pb-[calc(6rem+env(safe-area-inset-bottom))]" data-testid="profile-page">
        <a href="#/dashboard" data-testid="settings-back" className="md:hidden -mx-2 mb-2 inline-flex min-h-[44px] items-center gap-2 rounded-xl px-2 text-sm font-bold text-verde focus-visible:outline focus-visible:outline-2 focus-visible:outline-verde">
          <ArrowRight className="w-5 h-5" aria-hidden="true" />لوحة التحكم
        </a>
        <h1 className="font-display font-bold text-2xl text-bone mb-1">الإعدادات</h1>
        <p className="text-sm font-normal text-sage mb-4">بيانات حسابك وإدارة الرصيد والإشعارات.</p>

        <section data-testid="settings-user-card" aria-label="بيانات الحساب" className="bg-pine/70 border border-verde/15 rounded-2xl px-4 py-1 mb-4">
          <div className={row}>
            <span className="text-sm font-normal text-sage">البريد الإلكتروني</span>
            <span className="text-sm font-bold text-bone min-w-0 truncate" dir="ltr" data-testid="profile-email">{email || "—"}</span>
          </div>
          <div className={row}>
            <span className="text-sm font-normal text-sage">اسم المتجر</span>
            <span className="text-sm font-bold text-bone min-w-0 truncate" data-testid="settings-store-name">{summary?.businessName || "—"}</span>
          </div>
          <div className={row}>
            <span className="text-sm font-normal text-sage">الخطة</span>
            <span className="text-sm font-bold text-bone" data-testid="profile-plan">{plan || "—"}</span>
          </div>
        </section>

        <Section id="balance" testid="settings-section-balance" icon={<Wallet className="w-5 h-5" />} title="رصيد الردود" desc="الرصيد المتبقي وشحنه." defaultOpen>
          {sumState === "loading" ? loadingBox : sumState === "error" || !summary ? errorBox : (
            <div className="bg-night/50 border border-verde/12 rounded-xl p-4">
              <p className="font-display font-bold text-3xl text-bone tabular-nums leading-none" data-testid="settings-credits">
                {credits.toLocaleString("en")}
                <span className="text-sm text-sage font-body font-normal ms-1.5">من 1,000</span>
              </p>
              <div className="mt-3.5 flex gap-[3px]" aria-hidden="true">
                {Array.from({ length: 25 }).map((_, i) => (
                  <span
                    key={i}
                    className={`h-2 flex-1 rounded-full ${i < (creditPct / 100) * 25 ? (creditPct > 40 ? "bg-verde" : creditPct > 15 ? "bg-oro" : "bg-oro-soft") : "bg-moss"}`}
                  />
                ))}
              </div>
              <a href="#/dashboard?pay=1" data-testid="settings-topup" aria-label="اشحن الرصيد" className={`${linkCls} mt-4 w-full`}>اشحن الرصيد</a>
            </div>
          )}
        </Section>

        <Section id="staff-inbox" testid="settings-section-staff-inbox" icon={<Bell className="w-5 h-5" />} title="إشعارات الموظفين" desc="إشعارات التحويل والوسوم من التدفقات." defaultOpen>
          {!showReview ? <p className="text-sm text-sage py-3">هذه الميزة غير مفعّلة حاليًا.</p>
            : sumState === "loading" ? loadingBox : !summary ? errorBox : <StaffInboxPanel token={token} tenantId={summary.tenantId} />}
        </Section>

        <Section id="delivery-review" testid="settings-section-delivery-review" icon={<ShieldCheck className="w-5 h-5" />} title="مراجعة الرسائل غير المؤكدة" desc="رسائل لم يتأكد تسليمها وتحتاج مراجعتك." defaultOpen>
          {!showReview ? <p className="text-sm text-sage py-3">هذه الميزة غير مفعّلة حاليًا.</p>
            : sumState === "loading" ? loadingBox : !summary ? errorBox : <DeliveryReviewPanel token={token} tenantId={summary.tenantId} />}
        </Section>

        <Section id="widgets" testid="settings-section-widgets" icon={<MessageSquare className="w-5 h-5" />} title="الودجات" desc="أنشئ ودجات المحادثة وانسخ أكوادها.">
          <a href="#/widgets" data-testid="settings-widgets-link" aria-label="فتح صفحة الودجات" className={`${linkCls} w-full`}>فتح صفحة الودجات</a>
        </Section>

        <Section id="unresolved" testid="settings-section-unresolved" icon={<HelpCircle className="w-5 h-5" />} title="المحادثات العالقة" desc="أسئلة العملاء التي تنتظر إجابتك.">
          <p className="text-sm text-sage mb-3" data-testid="settings-unresolved-count">
            {sumState === "ready" && summary ? `${summary.openUnresolved} سؤال ينتظر تدخلك` : "—"}
          </p>
          <a href="#/dashboard?tab=unresolved" data-testid="settings-unresolved-link" aria-label="فتح المحادثات العالقة" className={`${linkCls} w-full`}>فتح المحادثات العالقة</a>
        </Section>

        <button
          type="button"
          onClick={logout}
          disabled={busy}
          data-testid="profile-logout"
          className="w-full min-h-[44px] mt-2 inline-flex items-center justify-center gap-2 border border-verde/25 text-mist font-bold text-sm px-4 py-2.5 rounded-xl hover:border-oro/60 hover:text-oro transition-colors duration-300 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-oro"
        >
          تسجيل خروج
        </button>
      </main>

    </div>
  );
}
