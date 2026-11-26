import { useCallback, useEffect, useState } from "react";
import { getSupabase } from "../lib/supabase";
import { tenantAdminFetch } from "../lib/api";

/* إدارة تجارية يدوية: تفعيل/إيقاف عميل، شحن/خصم رصيد، وسجل التعديلات. الدفع يُؤكَّد خارج المنصة ويدويًا؛
   لا يوجد هنا أي دفع آلي. كل تعديل يتطلب سببًا ويُسجَّل باسم المشرف. */
type Tenant = { id: string; business_name: string | null; is_active: boolean; credits_remaining: number; created_at: string };
type Action = { id: string; action: string; amount: number | null; balance_after: number | null; reason: string; created_at: string };
const actionNames: Record<string, string> = { credit_grant: "شحن رصيد", credit_deduct: "خصم رصيد", activate: "تفعيل", suspend: "إيقاف" };
const errorNames: Record<string, string> = {
  insufficient_balance: "الرصيد لا يكفي للخصم", idempotency_conflict: "تعارض في طلب مكرر؛ حدّث الصفحة وأعد المحاولة",
  tenant_not_found: "العميل غير موجود", invalid_arguments: "بيانات غير صالحة",
};
const newKey = () => `adm-${crypto.randomUUID()}`;

export default function AdminPanel() {
  const [token, setToken] = useState<string | null>(null);
  const [admin, setAdmin] = useState<boolean | null>(null);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [search, setSearch] = useState("");
  const [sel, setSel] = useState<Tenant | null>(null);
  const [ledger, setLedger] = useState<Action[]>([]);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // One idempotency key per intended operation: a retry after a network error reuses it and can never apply twice.
  const [pending, setPending] = useState<{ sig: string; key: string } | null>(null);

  useEffect(() => {
    const sb = getSupabase();
    if (!sb) { setAdmin(false); return; }
    sb.auth.getSession().then(({ data }) => {
      const t = data.session?.access_token ?? null;
      setToken(t);
      if (!t) { setAdmin(false); return; }
      tenantAdminFetch<{ admin: boolean }>(t, { action: "whoami" }).then((r) => setAdmin(r.admin === true)).catch(() => setAdmin(false));
    });
  }, []);

  const load = useCallback(async () => {
    if (!token) return;
    const r = await tenantAdminFetch<{ tenants: Tenant[] }>(token, { action: "list_tenants", search, limit: 50 });
    setTenants(r.tenants);
  }, [token, search]);
  useEffect(() => { if (admin) load().catch(() => setMsg({ ok: false, text: "تعذر تحميل العملاء" })); }, [admin, load]);

  const open = async (t: Tenant) => {
    setSel(t); setMsg(null); setPending(null);
    if (!token) return;
    const r = await tenantAdminFetch<{ actions: Action[] }>(token, { action: "ledger", tenantId: t.id }).catch(() => null);
    setLedger(r?.actions ?? []);
  };

  const run = async (kind: "grant" | "deduct" | "activate" | "suspend") => {
    if (!token || !sel || busy) return;
    const n = Number(amount);
    const money = kind === "grant" || kind === "deduct";
    if (money && (!Number.isSafeInteger(n) || n <= 0 || n > 1_000_000)) { setMsg({ ok: false, text: "أدخل عددًا صحيحًا موجبًا للرصيد" }); return; }
    if (reason.trim().length < 3) { setMsg({ ok: false, text: "السبب مطلوب (3 أحرف على الأقل)" }); return; }
    const sig = `${sel.id}|${kind}|${money ? n : ""}|${reason.trim()}`;
    const key = pending?.sig === sig ? pending.key : newKey();
    setPending({ sig, key }); setBusy(true); setMsg(null);
    try {
      const body = money
        ? { action: "adjust_credits", tenantId: sel.id, delta: kind === "grant" ? n : -n, reason: reason.trim(), idempotencyKey: key }
        : { action: "set_active", tenantId: sel.id, active: kind === "activate", reason: reason.trim(), idempotencyKey: key };
      const r = await tenantAdminFetch<{ duplicate?: boolean; unchanged?: boolean }>(token, body);
      setMsg({ ok: true, text: r.unchanged ? "الحالة كما هي دون تغيير" : r.duplicate ? "الطلب نُفّذ سابقًا ولم يتكرر" : "تم التنفيذ وتسجيله" });
      setPending(null); setAmount(""); setReason("");
      await load(); await open({ ...sel });
    } catch (e) {
      const code = (e as { data?: { error?: string } }).data?.error ?? "";
      setMsg({ ok: false, text: errorNames[code] ?? "تعذر التنفيذ. يمكنك إعادة المحاولة بأمان؛ لن يتكرر التعديل." });
    } finally { setBusy(false); }
  };

  const box = "bg-pine/70 border border-verde/15 rounded-2xl p-4 mb-3";
  const input = "w-full min-h-[44px] rounded-xl bg-night/60 border border-verde/20 px-3 text-bone";
  const btn = "min-h-[44px] px-4 rounded-xl border border-verde/30 text-bone font-bold text-sm disabled:opacity-50";
  if (admin === null) return <div className="min-h-screen bg-night text-bone p-6" dir="rtl" role="status">جارٍ التحقق…</div>;
  if (!admin) return <div className="min-h-screen bg-night text-bone p-6" dir="rtl" data-testid="admin-denied"><p role="alert">غير مصرح لك بهذه الصفحة.</p></div>;

  return (
    <div className="min-h-screen bg-night text-bone font-body" dir="rtl">
      <main className="max-w-3xl mx-auto px-4 py-5" data-testid="admin-panel">
        <h1 className="font-display font-bold text-2xl mb-1">إدارة العملاء</h1>
        <p className="text-sm text-sage mb-4">تأكيد الدفع يتم خارج المنصة يدويًا. كل تعديل يُسجَّل بسببه وباسم المشرف ولا يمكن تكراره بالخطأ.</p>
        <div className={box}>
          <label className="block text-sm mb-1" htmlFor="admin-search">بحث باسم النشاط</label>
          <div className="flex gap-2">
            <input id="admin-search" className={input} value={search} onChange={(e) => setSearch(e.target.value)} />
            <button type="button" className={btn} onClick={() => load()}>بحث</button>
          </div>
        </div>
        <ul className="mb-4" data-testid="admin-tenants">
          {tenants.map((t) => (
            <li key={t.id} className={`${box} flex items-center justify-between gap-3`}>
              <span className="min-w-0"><b className="block truncate">{t.business_name || "—"}</b>
                <span className="text-xs text-sage">{t.is_active ? "مفعّل" : "موقوف"} · الرصيد {t.credits_remaining.toLocaleString("en")}</span></span>
              <button type="button" className={btn} onClick={() => open(t)}>إدارة</button>
            </li>
          ))}
          {tenants.length === 0 && <li className="text-sm text-sage">لا يوجد عملاء مطابقون.</li>}
        </ul>
        {sel && (
          <section className={box} data-testid="admin-detail" aria-label="إدارة العميل">
            <h2 className="font-bold mb-1">{sel.business_name || "—"}</h2>
            <p className="text-sm text-sage mb-3">{sel.is_active ? "الحساب مفعّل" : "الحساب موقوف"} · الرصيد {sel.credits_remaining.toLocaleString("en")}</p>
            <label className="block text-sm mb-1" htmlFor="admin-amount">عدد الردود (للشحن أو الخصم)</label>
            <input id="admin-amount" inputMode="numeric" className={`${input} mb-2`} value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))} />
            <label className="block text-sm mb-1" htmlFor="admin-reason">السبب (مطلوب)</label>
            <input id="admin-reason" className={`${input} mb-3`} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
            <div className="flex flex-wrap gap-2 mb-2">
              <button type="button" className={btn} disabled={busy} onClick={() => run("grant")}>شحن رصيد</button>
              <button type="button" className={btn} disabled={busy} onClick={() => run("deduct")}>خصم رصيد</button>
              <button type="button" className={btn} disabled={busy || sel.is_active} onClick={() => run("activate")}>تفعيل</button>
              <button type="button" className={btn} disabled={busy || !sel.is_active} onClick={() => run("suspend")}>إيقاف</button>
            </div>
            {msg && <p role={msg.ok ? "status" : "alert"} className={msg.ok ? "text-sm text-verde" : "text-sm text-oro"}>{msg.text}</p>}
            <h3 className="font-bold mt-4 mb-2 text-sm">سجل التعديلات</h3>
            <ul className="text-sm" data-testid="admin-ledger">
              {ledger.map((a) => (
                <li key={a.id} className="py-2 border-b border-verde/10">
                  <b>{actionNames[a.action] ?? a.action}</b>{a.amount != null && <> · {a.amount.toLocaleString("en")}</>}
                  {a.balance_after != null && <> · الرصيد بعدها {a.balance_after.toLocaleString("en")}</>}
                  <span className="block text-xs text-sage">{a.reason} · {new Date(a.created_at).toLocaleString("ar-IQ")}</span>
                </li>
              ))}
              {ledger.length === 0 && <li className="text-sage">لا توجد تعديلات بعد.</li>}
            </ul>
          </section>
        )}
      </main>
    </div>
  );
}
