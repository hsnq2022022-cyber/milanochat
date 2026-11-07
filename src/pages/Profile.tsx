import { useEffect, useMemo, useState } from "react";
import { getSupabase } from "../lib/supabase";

/* الملف الشخصي: البريد من جلسة Supabase، والخطة غير متوفرة في حالة التطبيق حاليًا فتظهر «—». */
export default function Profile() {
  const sb = useMemo(() => getSupabase(), []);
  const [email, setEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const plan: string | null = null;

  useEffect(() => {
    if (!sb) return;
    let alive = true;
    sb.auth.getSession().then(({ data }) => {
      if (alive) setEmail(data.session?.user?.email ?? null);
    });
    return () => {
      alive = false;
    };
  }, [sb]);

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

  return (
    <div className="min-h-screen bg-night text-bone font-body" dir="rtl">
      <main className="max-w-md mx-auto px-4 pt-5 pb-[calc(6rem+env(safe-area-inset-bottom))]" data-testid="profile-page">
        <h1 className="font-display font-bold text-2xl text-bone mb-1">الملف الشخصي</h1>
        <p className="text-sm font-normal text-sage mb-4">بيانات حسابك الحالي.</p>

        <section className="bg-pine/70 border border-verde/15 rounded-2xl px-4 py-1 mb-4">
          <div className={row}>
            <span className="text-sm font-normal text-sage">البريد الإلكتروني</span>
            <span className="text-sm font-bold text-bone" dir="ltr" data-testid="profile-email">{email || "—"}</span>
          </div>
          <div className={row}>
            <span className="text-sm font-normal text-sage">الخطة</span>
            <span className="text-sm font-bold text-bone" data-testid="profile-plan">{plan || "—"}</span>
          </div>
        </section>

        <button
          type="button"
          onClick={logout}
          disabled={busy}
          data-testid="profile-logout"
          className="w-full inline-flex items-center justify-center gap-2 border border-verde/25 text-mist font-bold text-sm px-4 py-2.5 rounded-xl hover:border-oro/60 hover:text-oro transition-all duration-300 disabled:opacity-50"
        >
          تسجيل خروج
        </button>
      </main>

      <nav
        data-testid="bottom-nav"
        aria-label="التنقل الرئيسي"
        className="fixed bottom-0 inset-x-0 z-40 bg-night/95 backdrop-blur-md border-t border-verde/15 pb-[env(safe-area-inset-bottom)]"
      >
        <div className="max-w-6xl mx-auto grid grid-cols-3 h-16">
          <a href="#/dashboard" data-testid="bottom-nav-home" className="flex flex-col items-center justify-center gap-1 text-xs font-bold text-sage hover:text-bone">الرئيسية</a>
          <a href="#/flows" data-testid="bottom-nav-flows" className="flex flex-col items-center justify-center gap-1 text-xs font-bold text-sage hover:text-bone">التدفقات</a>
          <a href="#/profile" data-testid="bottom-nav-profile" aria-current="page" className="flex flex-col items-center justify-center gap-1 text-xs font-bold text-oro">الملف الشخصي</a>
        </div>
      </nav>
    </div>
  );
}
