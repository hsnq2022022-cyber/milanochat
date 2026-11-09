import { useEffect, useState, type ReactNode } from "react";
import { getSupabase } from "../lib/supabase";
import Sidebar from "./Sidebar";
import BottomNav from "./BottomNav";
import { activeNavId } from "./navItems";

/** حدث داخلي تُطلقه الصفحات عند تغيير الهاش بـ replaceState (لا يطلق hashchange). */
export const ROUTE_SYNC_EVENT = "milano:route-sync";

/* غلاف الصفحات المصادَق عليها: Sidebar على سطح المكتب وBottomNav على الجوال.
   لا يظهر أي تنقل بدون جلسة (شاشة الدخول والصفحات العامة تبقى كما هي).
   hideBottomNav: للمحرر الكامل الشاشة (التدفقات) كي لا يغطي BottomNav لوحاته السفلية. */
/* مؤقت: BottomNav مخفي على الجوال حتى إعادة تصميم التنقل بعد مراجعة Meta
   (لوحة التحكم فيها تبويبات علوية، والإعدادات/التدفقات/الودجات تُفتح من روابط الترويسات).
   اجعلها true لإعادة تفعيله دون تغيير آخر. */
export const SHOW_BOTTOM_NAV = false;

export default function AppShell({ children, hideBottomNav = false, padBottom = false }: {
  children: ReactNode; hideBottomNav?: boolean; padBottom?: boolean;
}) {
  const [authed, setAuthed] = useState(false);
  const [hash, setHash] = useState(() => window.location.hash);

  useEffect(() => {
    const sync = () => setHash(window.location.hash);
    window.addEventListener("hashchange", sync);
    window.addEventListener(ROUTE_SYNC_EVENT, sync);
    sync();
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener(ROUTE_SYNC_EVENT, sync);
    };
  }, []);

  useEffect(() => {
    const sb = getSupabase();
    if (!sb) return;
    let alive = true;
    sb.auth.getSession().then(({ data }) => { if (alive) setAuthed(Boolean(data.session)); }).catch(() => {});
    const { data: sub } = sb.auth.onAuthStateChange((_e, session) => { if (alive) setAuthed(Boolean(session)); });
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, []);

  if (!authed) return <>{children}</>;
  const active = activeNavId(hash);
  return (
    <div className="flex min-h-screen bg-[#061A14]" dir="rtl" data-testid="app-shell">
      <Sidebar active={active} />
      <div className={`flex-1 min-w-0 ${padBottom ? "pb-[calc(5rem+env(safe-area-inset-bottom))] md:pb-0" : ""}`}>{children}</div>
      {SHOW_BOTTOM_NAV && !hideBottomNav && <BottomNav active={active} />}
    </div>
  );
}
