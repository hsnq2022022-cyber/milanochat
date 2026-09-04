/**
 * لوحة تحكم ميلانو — حقيقية عبر Supabase Auth + الخادم،
 * وبوضع عرض حيّ (بيانات محاكاة + سيناريو تلقائي) عندما لا تتوفر متغيرات البيئة.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import confetti from "canvas-confetti";
import { apiAuthFetch, apiBase, apiEnabled, api, type WaSnapshot } from "../lib/api";
import { getSupabase, getStoredClaim, clearStoredClaim } from "../lib/supabase";
import {
  Logo, IconWhatsapp, IconCheck, IconX, IconPlus, IconTrash, IconSend,
  IconLogout, IconRefresh, IconDatabase, IconCard, IconGlobe, IconMapPin,
  IconPen, IconQuestion, IconHandoff, IconLog, IconCoin, IconSparkle, IconChevronDown,
} from "../components/Icons";

/* ═══════════════ أنواع ═══════════════ */

type ThreadMsg = {
  id: string;
  direction: "in" | "out";
  body: string;
  kind: string;
  is_auto: boolean;
  created_at: string;
};
type ConvItem = {
  id: string;
  phone: string;
  transferred: boolean;
  paused: string | null;
  lastAt: string;
  msgs: ThreadMsg[];
};
type UnresolvedItem = {
  id: string;
  question: string;
  createdAt: string;
  conversationId: string | null;
  bestSimilarity?: number;
  addedToKb?: boolean;
};
type SourceItem = {
  id: string;
  kind: string;
  url: string | null;
  status: string;
  chunks: number;
  createdAt: string;
  error?: string;
};
type DashState = {
  tenantId: string;
  businessName: string;
  isActive: boolean;
  credits: number;
  phone: string | null;
  waStatus: string;
  openUnresolved: number;
  convs: ConvItem[];
  unresolved: UnresolvedItem[];
  sources: SourceItem[];
};

/* ═══════════════ أدوات ═══════════════ */

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" });
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("ar", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

const cls = {
  card: "bg-pine/70 border border-verde/15 rounded-2xl",
  input:
    "w-full bg-night/70 border border-verde/20 rounded-xl px-4 py-2.5 text-sm text-bone placeholder:text-sage/45 focus:outline-none focus:border-oro/70 focus:ring-2 focus:ring-oro/20 transition-all duration-300",
  btn: "inline-flex items-center justify-center gap-2 bg-verde text-ink font-display font-bold text-sm px-5 py-2.5 rounded-xl hover:bg-oro transition-all duration-300 active:scale-[0.97] disabled:opacity-50",
  btnGhost:
    "inline-flex items-center justify-center gap-2 border border-verde/25 text-mist font-semibold text-sm px-4 py-2.5 rounded-xl hover:border-oro/60 hover:text-oro transition-all duration-300 active:scale-[0.97]",
};

/* لا يوجد أي QR تجريبي في هذا الملف — الربط يتم حصراً عبر جلسة Baileys حقيقية في الخادم */

/* ═══════════════ بيانات العرض ═══════════════ */

const now = () => new Date().toISOString();
const ago = (min: number) => new Date(Date.now() - min * 60000).toISOString();

const DEMO_INITIAL: DashState = {
  tenantId: "demo-tenant",
  businessName: "كافيه ميلانو",
  isActive: true,
  credits: 642,
  phone: "5XXXXXXX",
  waStatus: "connected",
  openUnresolved: 2,
  convs: [
    {
      id: "c1", phone: "+966 50 ••• ••21", transferred: false, paused: null, lastAt: ago(4),
      msgs: [
        { id: "m1", direction: "in", body: "السلام عليكم، وش أنواع القهوة المختصة عندكم؟", kind: "customer", is_auto: false, created_at: ago(9) },
        { id: "m2", direction: "out", body: "وعليكم السلام! عندنا V60، كيمكس، وإسبريسو من محمصة محلية — تحب أوصي لك بشي حسب ذوقك؟", kind: "answer", is_auto: true, created_at: ago(9) },
        { id: "m3", direction: "in", body: "أحب الشيء القوي", kind: "customer", is_auto: false, created_at: ago(4) },
        { id: "m4", direction: "out", body: "القوي يناسبك الإسبريسو المحمص الغامق أو الفلات وايت — الإسبريسو بـ 12 ريال والفلات وايت بـ 16.", kind: "answer", is_auto: true, created_at: ago(4) },
      ],
    },
    {
      id: "c2", phone: "+966 55 ••• ••87", transferred: true, paused: null, lastAt: ago(31),
      msgs: [
        { id: "m5", direction: "in", body: "طلبي تأخر أكثر من نص ساعة!", kind: "customer", is_auto: false, created_at: ago(35) },
        { id: "m6", direction: "out", body: "وصلتني رسالتك، وحوّلت محادثتك لأحد الموظفين — بيرد عليك في أقرب وقت إن شاء الله.", kind: "handoff", is_auto: true, created_at: ago(35) },
        { id: "m7", direction: "out", body: "أعتذر عن التأخير، طلبك خرج مع المندوب قبل 10 دقائق ويوصلك خلال دقائق.", kind: "manual", is_auto: false, created_at: ago(31) },
      ],
    },
    {
      id: "c3", phone: "+964 77 ••• ••03", transferred: false, paused: null, lastAt: ago(58),
      msgs: [
        { id: "m8", direction: "in", body: "بكم السبانش لاتيه؟", kind: "customer", is_auto: false, created_at: ago(59) },
        { id: "m9", direction: "out", body: "السبانش لاتيه بـ 22 ريال، والحجم الكبير بـ 26.", kind: "answer", is_auto: true, created_at: ago(58) },
      ],
    },
  ],
  unresolved: [
    { id: "u1", question: "عندكم فرع في جدة؟", createdAt: ago(120), conversationId: "c3", bestSimilarity: 0.19 },
    { id: "u2", question: "تقبلون بطاقة مدى للشحن؟", createdAt: ago(200), conversationId: "c1", bestSimilarity: 0.14 },
  ],
  sources: [
    { id: "s1", kind: "website", url: "https://milano-cafe.example", status: "indexed", chunks: 24, createdAt: ago(60 * 26) },
    { id: "s2", kind: "gmaps", url: "https://maps.app.goo.gl/milano", status: "indexed", chunks: 9, createdAt: ago(60 * 26) },
  ],
};

/** سيناريو محاكاة: رسائل واردة → ردود آلية (خصم رصيد، تحويل، أسئلة عالقة) */
const DEMO_SCRIPT: { conv: number; text: string; reply: { body: string; kind: string } | "unresolved" }[] = [
  { conv: 0, text: "عندكم توصيل للمنازل؟", reply: { body: "أكيد، التوصيل متاح داخل الرياض خلال 45 دقيقة تقريبًا — الرسوم 10 ريال ومجاني للطلبات فوق 60.", kind: "answer" } },
  { conv: 2, text: "أبي أعرف سعر السبانش لاتيه", reply: { body: "السبانش لاتيه بـ 22 ريال، والحجم الكبير بـ 26.", kind: "answer" } },
  { conv: 1, text: "متى تفتحون يوم الجمعة؟", reply: { body: "نفتح يوميًا من 7 صباحًا حتى 1 بعد منتصف الليل، والجمعة من 2 ظهرًا.", kind: "answer" } },
  { conv: 2, text: "عندكم قهوة خالية من الكافيين؟", reply: "unresolved" },
  { conv: 0, text: "أبغى أتكلم مع بشري", reply: { body: "وصلتني رسالتك، وحوّلت محادثتك لأحد الموظفين — بيرد عليك في أقرب وقت إن شاء الله.", kind: "handoff" } },
  { conv: 1, text: "بكم الكوفي عندكم؟", reply: { body: "القهوة المقطرة بـ 18 ريال، واللاتيه بـ 16.", kind: "answer" } },
];

/* ═══════════════ المكوّن الرئيسي ═══════════════ */

export default function Dashboard() {
  const sb = useMemo(() => getSupabase(), []);
  const demo = sb === null;

  /* ── المصادقة ── */
  const [authed, setAuthed] = useState(demo ? false : true); // الحقيقي: نتحقق من الجلسة أدناه
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authMode, setAuthMode] = useState<"login" | "signup">("login");
  const [authBusy, setAuthBusy] = useState(false);
  const [authErr, setAuthErr] = useState("");
  const [authNote, setAuthNote] = useState("");
  const [token, setToken] = useState<string | null>(null);

  /* ── الحالة ── */
  const [st, setSt] = useState<DashState | null>(null);
  const [needClaim, setNeedClaim] = useState(false);
  const [claimVal, setClaimVal] = useState("");
  const [claimErr, setClaimErr] = useState("");
  const [claimBusy, setClaimBusy] = useState(false);

  const [tab, setTab] = useState<"convs" | "unresolved" | "knowledge">("convs");
  const [activeConv, setActiveConv] = useState<string | null>(null);
  const [mobileThread, setMobileThread] = useState(false);
  const [draft, setDraft] = useState("");
  const [resumeAuto, setResumeAuto] = useState(true);
  const [sending, setSending] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [answers, setAnswers] = useState<Record<string, { text: string; save: boolean }>>({});
  const [newSource, setNewSource] = useState<{ kind: "url" | "text"; url: string; text: string }>({ kind: "url", url: "", text: "" });
  const threadEndRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<number | null>(null);
  const scriptIdx = useRef(0);

  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 3200);
  };

  /* ── جلسة Supabase (الوضع الحقيقي) ── */
  useEffect(() => {
    if (demo) return;
    let alive = true;
    sb!.auth.getSession().then(({ data }) => {
      if (!alive) return;
      if (data.session) {
        setAuthed(true);
        setToken(data.session.access_token);
      } else {
        setAuthed(false);
      }
    });
    const { data: sub } = sb!.auth.onAuthStateChange((_e, session) => {
      if (!alive) return;
      setAuthed(Boolean(session));
      setToken(session?.access_token ?? null);
      if (!session) setSt(null);
    });
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, [demo, sb]);

  /* ── دخول/تسجيل (حقيقي) ── */
  const doAuth = async () => {
    setAuthErr(""); setAuthNote("");
    if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 6) {
      setAuthErr("أدخل بريدًا صحيحًا وكلمة مرور 6 أحرف على الأقل");
      return;
    }
    setAuthBusy(true);
    try {
      if (authMode === "signup") {
        const { data, error } = await sb!.auth.signUp({ email, password });
        if (error) throw new Error(error.message);
        if (!data.session) setAuthNote("تم إنشاء الحساب — فعّله من بريدك ثم سجّل الدخول.");
        else setAuthNote("تم إنشاء الحساب.");
      } else {
        const { error } = await sb!.auth.signInWithPassword({ email, password });
        if (error) throw new Error(error.message.includes("confirm") ? "فعّل حسابك من بريدك أولاً" : error.message);
      }
    } catch (e: any) {
      setAuthErr(e?.message ?? "تعذر الدخول");
    }
    setAuthBusy(false);
  };

  /* ── تحميل البيانات (حقيقي) ── */
  const loadAll = useCallback(async () => {
    if (!token) return;
    try {
      const [summary, convs, unresolved, sources] = await Promise.all([
        apiAuthFetch<any>(token, "/api/dashboard/summary"),
        apiAuthFetch<any[]>(token, "/api/dashboard/conversations"),
        apiAuthFetch<any[]>(token, "/api/dashboard/unresolved"),
        apiAuthFetch<any[]>(token, "/api/dashboard/knowledge"),
      ]);
      setNeedClaim(false);
      setSt({
        tenantId: summary.tenant.id,
        businessName: summary.tenant.businessName,
        isActive: summary.tenant.isActive,
        credits: summary.tenant.creditsRemaining,
        phone: summary.tenant.phone,
        waStatus: summary.wa.status,
        openUnresolved: summary.openUnresolved,
        convs: convs.map((c: any) => ({
          id: c.id, phone: c.customerPhone, transferred: c.transferred,
          paused: c.autoPausedReason, lastAt: c.lastMessageAt, msgs: [],
        })),
        unresolved: unresolved.filter((q: any) => q.status === "open").map((q: any) => ({
          id: q.id, question: q.question, createdAt: q.createdAt,
          conversationId: q.conversationId, bestSimilarity: q.bestSimilarity,
        })),
        sources: sources.map((s: any) => ({
          id: s.id, kind: s.kind, url: s.url, status: s.status,
          chunks: s.chunks_count ?? 0, createdAt: s.created_at, error: s.error ?? undefined,
        })),
      });
    } catch (e: any) {
      if (String(e?.message ?? "").includes("حساب")) setNeedClaim(true);
    }
  }, [token]);

  /* محاولة ضم تلقائية بالحفظ من معالج الإنشاء */
  useEffect(() => {
    if (demo || !token) return;
    const saved = getStoredClaim();
    if (!saved) {
      loadAll();
      return;
    }
    apiAuthFetch<{ tenantId: string }>(token, "/api/dashboard/claim", {
      method: "POST",
      body: JSON.stringify({ claimToken: saved }),
    })
      .then(() => clearStoredClaim())
      .catch(() => {})
      .finally(() => loadAll());
  }, [demo, token, loadAll]);

  /* استطلاع خفيف كل 6 ثوانٍ */
  useEffect(() => {
    if (demo || !token || needClaim) return;
    const iv = window.setInterval(loadAll, 6000);
    return () => window.clearInterval(iv);
  }, [demo, token, needClaim, loadAll]);

  /* رسائل المحادثة المفتوحة (حقيقي) — تحديث حي */
  const loadThread = useCallback(async (convId: string) => {
    if (!token) return;
    const msgs = await apiAuthFetch<any[]>(token, `/api/dashboard/conversations/${convId}/messages`);
    setSt((prev) =>
      prev
        ? {
            ...prev,
            convs: prev.convs.map((c) =>
              c.id === convId ? { ...c, msgs: msgs.map((m: any) => ({ id: m.id, direction: m.direction, body: m.body, kind: m.kind, is_auto: m.is_auto, created_at: m.created_at })) } : c
            ),
          }
        : prev
    );
  }, [token]);

  useEffect(() => {
    if (demo || !activeConv || !token) return;
    loadThread(activeConv).catch(() => {});
    const iv = window.setInterval(() => loadThread(activeConv).catch(() => {}), 5000);
    return () => window.clearInterval(iv);
  }, [demo, activeConv, token, loadThread]);

  /* ── محاكاة العرض الحيّ ── */
  useEffect(() => {
    if (!demo) {
      setSt(null);
      return;
    }
    if (!authed) return;
    setSt(structuredClone(DEMO_INITIAL));
    const iv = window.setInterval(() => {
      setSt((prev) => {
        if (!prev) return prev;
        const ev = DEMO_SCRIPT[scriptIdx.current % DEMO_SCRIPT.length];
        scriptIdx.current += 1;
        const conv = prev.convs[ev.conv];
        if (!conv || conv.transferred || conv.paused) return prev;
        const inMsg: ThreadMsg = { id: `sim-in-${Date.now()}`, direction: "in", body: ev.text, kind: "customer", is_auto: false, created_at: now() };
        let next: DashState = {
          ...prev,
          convs: prev.convs.map((c, i) => (i === ev.conv ? { ...c, lastAt: inMsg.created_at, msgs: [...c.msgs, inMsg] } : c)),
        };
        if (next.credits <= 0) {
          return { ...next, convs: next.convs.map((c, i) => (i === ev.conv ? { ...c, paused: "credits" } : c)) };
        }
        const replyText =
          ev.reply === "unresolved"
            ? "عذرًا، ما عندي معلومات مؤكدة عن هذا الموضوع. لو تحتاج شيء ثاني أنا موجود، وأقدر أحوّلك لأحد الموظفين لو حبيت."
            : ev.reply.body;
        const kind = ev.reply === "unresolved" ? "refusal" : ev.reply.kind;
        const outMsg: ThreadMsg = { id: `sim-out-${Date.now()}`, direction: "out", body: replyText, kind, is_auto: true, created_at: now() };
        next = {
          ...next,
          credits: next.credits - 1,
          convs: next.convs.map((c, i) =>
            i === ev.conv
              ? { ...c, transferred: kind === "handoff", lastAt: outMsg.created_at, msgs: [...c.msgs, outMsg] }
              : c
          ),
        };
        if (kind === "refusal") {
          next = {
            ...next,
            openUnresolved: next.openUnresolved + 1,
            unresolved: [{ id: `u-${Date.now()}`, question: ev.text, createdAt: now(), conversationId: conv.id, bestSimilarity: 0.17 }, ...next.unresolved],
          };
        }
        return next;
      });
    }, 9000);
    return () => window.clearInterval(iv);
  }, [demo, authed]);

  /* تمرير تلقائي لأسفل الخيط */
  const activeThread = st?.convs.find((c) => c.id === activeConv) ?? null;
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [activeThread?.msgs.length]);

  /* ── إجراءات ── */
  const replyManual = async () => {
    if (!activeConv || !draft.trim() || !st) return;
    setSending(true);
    try {
      if (demo) {
        const outMsg: ThreadMsg = { id: `man-${Date.now()}`, direction: "out", body: draft.trim(), kind: "manual", is_auto: false, created_at: now() };
        setSt((prev) =>
          prev
            ? {
                ...prev,
                convs: prev.convs.map((c) =>
                  c.id === activeConv
                    ? { ...c, transferred: resumeAuto ? false : c.transferred, paused: resumeAuto ? null : c.paused, lastAt: outMsg.created_at, msgs: [...c.msgs, outMsg] }
                    : c
                ),
              }
            : prev
        );
      } else {
        await apiAuthFetch(token!, `/api/dashboard/conversations/${activeConv}/reply`, {
          method: "POST",
          body: JSON.stringify({ text: draft.trim(), resumeAuto }),
        });
        await loadThread(activeConv);
        loadAll();
      }
      setDraft("");
      showToast("أُرسل الرد للعميل");
    } catch (e: any) {
      showToast(e?.message ?? "تعذر الإرسال — واتساب غير متصل؟");
    }
    setSending(false);
  };

  const resolveOne = async (item: UnresolvedItem) => {
    const a = answers[item.id]?.text.trim();
    const save = answers[item.id]?.save ?? true;
    if (!a) {
      showToast("اكتب الإجابة أولاً");
      return;
    }
    try {
      if (demo) {
        setSt((prev) =>
          prev
            ? {
                ...prev,
                openUnresolved: Math.max(0, prev.openUnresolved - 1),
                unresolved: prev.unresolved.filter((u) => u.id !== item.id),
                sources: save
                  ? prev.sources.map((s, i) => (i === 0 ? { ...s, chunks: s.chunks + 1 } : s))
                  : prev.sources,
              }
            : prev
        );
      } else {
        await apiAuthFetch(token!, `/api/dashboard/unresolved/${item.id}/resolve`, {
          method: "POST",
          body: JSON.stringify({ answer: a, saveToKb: save, sendToCustomer: Boolean(item.conversationId) }),
        });
        loadAll();
      }
      confetti({ particleCount: 60, spread: 70, origin: { y: 0.5 }, colors: ["#2ec27e", "#e8b24b"] });
      showToast(save ? "حُلّ السؤال وتعلّمه الموظف" : "حُلّ السؤال");
    } catch (e: any) {
      showToast(e?.message ?? "تعذر الحفظ");
    }
  };

  const addSource = async () => {
    const isUrl = newSource.kind === "url";
    if (isUrl && !/^https?:\/\/\S+\.\S+/.test(newSource.url.trim())) {
      showToast("أدخل رابطًا صحيحًا يبدأ بـ http");
      return;
    }
    if (!isUrl && newSource.text.trim().length < 20) {
      showToast("اكتب نصًا أطول قليلاً (20 حرفًا على الأقل)");
      return;
    }
    if (demo) {
      const id = `s-${Date.now()}`;
      setSt((prev) =>
        prev
          ? { ...prev, sources: [{ id, kind: "manual-text", url: null, status: "pending", chunks: 0, createdAt: now() }, ...prev.sources] }
          : prev
      );
      window.setTimeout(() => {
        setSt((prev) =>
          prev
            ? { ...prev, sources: prev.sources.map((s) => (s.id === id ? { ...s, status: "indexed", chunks: 8 + Math.floor(Math.random() * 16) } : s)) }
            : prev
        );
        showToast("فُهرس المصدر الجديد");
      }, 1600);
      setNewSource({ kind: "url", url: "", text: "" });
      return;
    }
    try {
      await apiAuthFetch(token!, "/api/dashboard/knowledge", {
        method: "POST",
        body: JSON.stringify(isUrl ? { url: newSource.url.trim() } : { text: newSource.text.trim() }),
      });
      setNewSource({ kind: "url", url: "", text: "" });
      loadAll();
      showToast("بدأت الفهرسة");
    } catch (e: any) {
      showToast(e?.message ?? "تعذرت الفهرسة");
    }
  };

  const deleteSource = async (id: string) => {
    if (demo) {
      setSt((prev) => (prev ? { ...prev, sources: prev.sources.filter((s) => s.id !== id) } : prev));
      return;
    }
    try {
      await apiAuthFetch(token!, `/api/dashboard/knowledge/${id}`, { method: "DELETE" });
      loadAll();
      showToast("حُذف المصدر");
    } catch {
      showToast("تعذر الحذف");
    }
  };

  const recharge = async (pkgId: string) => {
    if (demo) {
      const add = pkgId === "starter" ? 1000 : pkgId === "growth" ? 3000 : 10000;
      setSt((prev) => (prev ? { ...prev, credits: prev.credits + add } : prev));
      confetti({ particleCount: 120, spread: 90, origin: { y: 0.4 }, colors: ["#2ec27e", "#e8b24b"] });
      showToast(`أُضيف ${add.toLocaleString("en")} رد (محاكاة دفع)`);
      setPayOpen(false);
      return;
    }
    try {
      const res = await fetch(`${apiBase}/api/payments/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId: "", packageId: pkgId }),
      }).then((r) => r.json());
      if (res.paymentUrl) window.open(res.paymentUrl, "_blank", "noopener");
      showToast("فُتحت صفحة الدفع — التفعيل تلقائي بعد التأكيد");
      setPayOpen(false);
    } catch {
      showToast("تعذر إنشاء الفاتورة");
    }
  };

  const logout = async () => {
    if (!demo) await sb!.auth.signOut();
    setAuthed(false);
    setSt(null);
    setToken(null);
  };

  /* ═══════════ شاشات ما قبل اللوحة ═══════════ */

  if (!authed) {
    return (
      <Shell>
        <div className="max-w-5xl mx-auto px-5 pt-16 pb-20">
          <div className="grid lg:grid-cols-[1.1fr_1fr] gap-8 items-stretch">
            {/* تعريف */}
            <div className={`${cls.card} p-8 lg:p-10 flex flex-col justify-between overflow-hidden relative`}>
              <div className="absolute -top-20 -left-20 w-64 h-64 rounded-full bg-verde/10 blur-3xl" aria-hidden="true" />
              <div>
                <span className="inline-flex items-center gap-2 text-verde mb-6">
                  <Logo className="w-11 h-11" />
                  <span className="font-display font-bold text-3xl text-bone">
                    ميلانو<span className="text-oro">.</span>
                  </span>
                </span>
                <h1 className="font-display font-bold text-3xl lg:text-4xl leading-snug text-bone mb-5">
                  غرفة عمليات
                  <span className="text-oro"> موظفك الآلي</span>
                </h1>
                <ul className="space-y-3.5">
                  {[
                    { icon: <IconWhatsapp className="w-4.5 h-4.5" />, t: "حالة اتصال واتساب لحظية + رمز ربط مباشر" },
                    { icon: <IconCoin className="w-4.5 h-4.5" />, t: "رصيد الردود المتبقي وتنبيه قبل النفاد" },
                    { icon: <IconQuestion className="w-4.5 h-4.5" />, t: "الأسئلة العالقة تُحل وتُضاف للمعرفة بضغطة" },
                    { icon: <IconHandoff className="w-4.5 h-4.5" />, t: "المحادثات المحوّلة لبشري واستئناف الآلي" },
                  ].map((f, i) => (
                    <li key={i} className="flex items-center gap-3 text-sm text-mist">
                      <span className="w-9 h-9 rounded-xl bg-moss border border-verde/25 text-verde flex items-center justify-center shrink-0">
                        {f.icon}
                      </span>
                      {f.t}
                    </li>
                  ))}
                </ul>
              </div>
              {demo && (
                <p className="mt-8 text-[11.5px] leading-5 text-sage/80 bg-night/60 border border-oro/25 rounded-xl px-4 py-3">
                  <span className="text-oro-soft font-bold">وضع العرض:</span> البيانات محاكاة حيّة. اربط Supabase
                  (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY) والخادم لتعمل اللوحة على بيانات حقيقية.
                </p>
              )}
            </div>

            {/* الدخول */}
            <div className={`${cls.card} p-8`}>
              {demo ? (
                <div className="h-full flex flex-col justify-center gap-4">
                  <h2 className="font-display font-bold text-2xl text-bone">جرّب اللوحة الآن</h2>
                  <p className="text-sm text-sage leading-6">
                    ستدخل على نسخة محاكاة كاملة: محادثات تتحرك، رصيد يُخصم، وأسئلة عالقة تظهر — كل شيء تفاعلي.
                  </p>
                  <button
                    onClick={() => setAuthed(true)}
                    className={`${cls.btn} w-full py-3.5 text-base`}
                  >
                    <IconSparkle className="w-5 h-5" />
                    دخول تجريبي للوحة
                  </button>
                  <a href="#top" className="text-center text-xs text-sage hover:text-oro underline underline-offset-4 transition-colors">
                    العودة للموقع
                  </a>
                </div>
              ) : (
                <div>
                  <div className="flex bg-night/60 border border-verde/15 rounded-xl p-1 mb-6">
                    {(["login", "signup"] as const).map((m) => (
                      <button
                        key={m}
                        onClick={() => { setAuthMode(m); setAuthErr(""); setAuthNote(""); }}
                        className={`flex-1 py-2 rounded-lg text-sm font-bold transition-all duration-300 ${
                          authMode === m ? "bg-moss text-oro" : "text-sage hover:text-bone"
                        }`}
                      >
                        {m === "login" ? "تسجيل دخول" : "حساب جديد"}
                      </button>
                    ))}
                  </div>
                  <h2 className="font-display font-bold text-2xl text-bone mb-1">
                    {authMode === "login" ? "أهلاً بعودتك" : "أنشئ حسابك"}
                  </h2>
                  <p className="text-xs text-sage mb-6">عبر Supabase Auth — نفس بيانات حساب لوحة التحكم.</p>
                  <div className="space-y-4">
                    <div>
                      <label className="block text-xs font-semibold text-sage mb-1.5">البريد الإلكتروني</label>
                      <input dir="ltr" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={`${cls.input} text-left`} placeholder="you@example.com" />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-sage mb-1.5">كلمة المرور</label>
                      <input dir="ltr" type="password" value={password} onChange={(e) => setPassword(e.target.value)} className={`${cls.input} text-left`} placeholder="••••••••" onKeyDown={(e) => e.key === "Enter" && doAuth()} />
                    </div>
                    {authErr && <p className="text-[11.5px] text-oro-soft bg-night/60 border border-oro/25 rounded-xl px-3.5 py-2.5">{authErr}</p>}
                    {authNote && <p className="text-[11.5px] text-verde bg-night/60 border border-verde/25 rounded-xl px-3.5 py-2.5">{authNote}</p>}
                    <button onClick={doAuth} disabled={authBusy} className={`${cls.btn} w-full py-3`}>
                      {authBusy ? "لحظة…" : authMode === "login" ? "دخول" : "إنشاء الحساب"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </Shell>
    );
  }

  /* ضم حساب (حقيقي فقط) */
  if (!demo && needClaim && !st) {
    return (
      <Shell>
        <div className="max-w-xl mx-auto px-5 pt-24 pb-20">
          <div className={`${cls.card} p-8`}>
            <span className="text-verde inline-block mb-4"><Logo className="w-10 h-10" /></span>
            <h2 className="font-display font-bold text-2xl text-bone mb-2">اربط حسابك بمشروعك</h2>
            <p className="text-sm text-sage leading-6 mb-6">
              أنشأت موظفًا من الصفحة الرئيسية؟ الصق رمز الضم الذي ظهر لك، أو سجّل بنفس البريد ليُضم تلقائيًا.
            </p>
            <input dir="ltr" value={claimVal} onChange={(e) => setClaimVal(e.target.value)} className={`${cls.input} text-left mb-3`} placeholder="claim token" />
            {claimErr && <p className="text-[11.5px] text-oro-soft mb-3">{claimErr}</p>}
            <button
              disabled={claimBusy}
              onClick={async () => {
                setClaimBusy(true); setClaimErr("");
                try {
                  await apiAuthFetch(token!, "/api/dashboard/claim", { method: "POST", body: JSON.stringify({ claimToken: claimVal.trim() }) });
                  loadAll();
                } catch (e: any) {
                  setClaimErr(e?.message ?? "رمز غير صالح");
                }
                setClaimBusy(false);
              }}
              className={`${cls.btn} w-full py-3`}
            >
              ضم الحساب
            </button>
            <button onClick={logout} className="mt-4 w-full text-xs text-sage hover:text-oro underline underline-offset-4 transition-colors">
              تسجيل خروج
            </button>
          </div>
        </div>
      </Shell>
    );
  }

  if (!st) {
    return (
      <Shell>
        <div className="min-h-[70vh] flex items-center justify-center">
          <span className="inline-flex items-center gap-3 text-sage text-sm">
            <span className="w-8 h-8 rounded-full border-2 border-verde/30 border-t-verde animate-spin" />
            {apiEnabled ? "جارٍ تحميل لوحتك…" : "تجهيز بيانات العرض…"}
          </span>
        </div>
      </Shell>
    );
  }

  /* ═══════════ اللوحة ═══════════ */

  const creditPct = Math.max(0, Math.min(100, (st.credits / 1000) * 100));
  const active = st.convs.find((c) => c.id === activeConv) ?? null;
  const TABS = [
    { id: "convs" as const, label: "المحادثات", icon: <IconLog className="w-4 h-4" /> },
    { id: "unresolved" as const, label: "العالقة", icon: <IconQuestion className="w-4 h-4" />, badge: st.openUnresolved },
    { id: "knowledge" as const, label: "المعرفة", icon: <IconDatabase className="w-4 h-4" /> },
  ];

  return (
    <Shell>
      {/* شريط علوي */}
      <header className="sticky top-0 z-40 bg-night/85 backdrop-blur-md border-b border-verde/12">
        <div className="max-w-6xl mx-auto px-5 h-16 flex items-center justify-between gap-3">
          <a href="#top" className="flex items-center gap-2 group shrink-0">
            <span className="text-verde transition-transform duration-500 group-hover:rotate-[-8deg]"><Logo className="w-8 h-8" /></span>
            <span className="font-display font-bold text-xl text-bone hidden sm:block">
              ميلانو<span className="text-oro">.</span>
              <span className="text-sage text-xs font-body font-normal ms-2">لوحة التحكم</span>
            </span>
          </a>
          <div className="flex items-center gap-2.5">
            {demo && (
              <span className="text-[10.5px] font-bold text-oro-soft bg-oro/10 border border-oro/30 rounded-full px-2.5 py-1">
                وضع العرض
              </span>
            )}
            <span className="hidden md:block text-xs text-mist bg-moss/70 border border-verde/20 rounded-full px-3.5 py-1.5">
              {st.businessName}
            </span>
            <button onClick={() => setPayOpen(true)} className={`${cls.btnGhost} !py-2 !px-3.5 text-xs`}>
              <IconCard className="w-4 h-4" />
              <span className="hidden sm:inline">اشحن الرصيد</span>
            </button>
            <button onClick={logout} title="خروج" className="p-2.5 rounded-xl text-sage hover:text-oro hover:bg-moss transition-all duration-300">
              <IconLogout className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-5 pt-7 pb-24">
        {/* تنبيه الرصيد */}
        {st.credits <= 0 ? (
          <div className="mb-5 flex flex-wrap items-center gap-3 bg-oro/10 border border-oro/40 rounded-2xl px-5 py-3.5 msg-in">
            <span className="text-oro"><IconCoin className="w-5 h-5" /></span>
            <p className="text-sm text-oro-soft font-semibold flex-1">نفد رصيد الردود — الرد الآلي موقوف حتى الشحن.</p>
            <button onClick={() => setPayOpen(true)} className={`${cls.btn} !py-2 !px-4 text-xs`}>اشحن الآن</button>
          </div>
        ) : st.credits < 100 ? (
          <div className="mb-5 flex flex-wrap items-center gap-3 bg-night/70 border border-oro/30 rounded-2xl px-5 py-3.5 msg-in">
            <span className="text-oro"><IconCoin className="w-5 h-5" /></span>
            <p className="text-sm text-mist flex-1">الرصيد منخفض ({st.credits} رد متبقٍ) — اشحن قبل توقف الموظف.</p>
            <button onClick={() => setPayOpen(true)} className={`${cls.btnGhost} !py-2 !px-4 text-xs`}>شحن</button>
          </div>
        ) : null}

        {/* شريط الملخص — تقسيم غير متساوٍ */}
        <div className="grid md:grid-cols-12 gap-4 mb-7">
          {/* الاتصال */}
          <section className={`${cls.card} md:col-span-5 p-5 relative overflow-hidden group hover:border-verde/35 transition-colors duration-300`}>
            <div className="absolute -bottom-14 -start-14 w-44 h-44 rounded-full bg-verde/10 blur-2xl group-hover:bg-verde/15 transition-colors duration-500" aria-hidden="true" />
            <div className="flex items-start justify-between gap-3 relative">
              <div>
                <p className="text-[11px] text-sage mb-1.5">حالة واتساب</p>
                <p className="flex items-center gap-2 font-display font-bold text-lg text-bone">
                  <span className={`w-2.5 h-2.5 rounded-full ${st.waStatus === "connected" ? "bg-verde live-dot" : "bg-oro"}`} />
                  {st.waStatus === "connected" ? "متصل" : st.waStatus === "qr" ? "بانتظار المسح" : "غير متصل"}
                </p>
                <p className="text-[11.5px] text-sage mt-1" dir="ltr">{st.phone ?? "—"}</p>
              </div>
              <button onClick={() => setQrOpen(true)} className={`${cls.btnGhost} !py-2 !px-3.5 text-xs`}>
                <IconWhatsapp className="w-4 h-4" />
                {st.waStatus === "connected" ? "إعادة ربط" : "اربط الآن"}
              </button>
            </div>
            <div className="mt-4 flex items-center gap-2 text-[11px] text-sage relative">
              <IconRefresh className="w-3.5 h-3.5 text-verde" />
              تتحدث الحالة تلقائيًا كل بضع ثوانٍ
            </div>
          </section>

          {/* الرصيد */}
          <section className={`${cls.card} md:col-span-4 p-5 group hover:border-verde/35 transition-colors duration-300`}>
            <div className="flex items-center justify-between mb-2">
              <p className="text-[11px] text-sage">رصيد الردود</p>
              <span className="text-verde"><IconCoin className="w-4.5 h-4.5" /></span>
            </div>
            <p className="font-display font-bold text-3xl text-bone tabular-nums leading-none">
              {st.credits.toLocaleString("en")}
              <span className="text-xs text-sage font-body font-normal ms-1.5">من 1,000</span>
            </p>
            <div className="mt-3.5 flex gap-[3px]" aria-hidden="true">
              {Array.from({ length: 25 }).map((_, i) => (
                <span
                  key={i}
                  className={`h-2 flex-1 rounded-full transition-all duration-500 ${
                    i < (creditPct / 100) * 25
                      ? creditPct > 40 ? "bg-verde" : creditPct > 15 ? "bg-oro" : "bg-oro-soft"
                      : "bg-moss"
                  }`}
                  style={{ transitionDelay: `${i * 18}ms` }}
                />
              ))}
            </div>
          </section>

          {/* عدّادات */}
          <section className="md:col-span-3 grid grid-rows-2 gap-4">
            <button onClick={() => setTab("convs")} className={`${cls.card} p-4 text-start group hover:border-verde/40 hover:-translate-y-0.5 transition-all duration-300`}>
              <div className="flex items-center justify-between">
                <span className="text-sage group-hover:text-verde transition-colors"><IconLog className="w-4.5 h-4.5" /></span>
                <span className="font-display font-bold text-2xl text-bone tabular-nums">{st.convs.length}</span>
              </div>
              <p className="text-[11px] text-sage mt-1">محادثة نشطة</p>
            </button>
            <button onClick={() => setTab("unresolved")} className={`${cls.card} p-4 text-start group hover:border-oro/50 hover:-translate-y-0.5 transition-all duration-300`}>
              <div className="flex items-center justify-between">
                <span className={st.openUnresolved > 0 ? "text-oro" : "text-sage"}><IconQuestion className="w-4.5 h-4.5" /></span>
                <span className={`font-display font-bold text-2xl tabular-nums ${st.openUnresolved > 0 ? "text-oro" : "text-bone"}`}>
                  {st.openUnresolved}
                </span>
              </div>
              <p className="text-[11px] text-sage mt-1">سؤال ينتظر تدخلّك</p>
            </button>
          </section>
        </div>

        {/* التبويبات */}
        <div className="relative bg-pine/50 border border-verde/12 rounded-2xl p-1.5 grid grid-cols-3 mb-6 max-w-md">
          <span
            className="absolute top-1.5 bottom-1.5 w-[calc((100%-0.75rem)/3)] bg-moss rounded-xl border border-verde/25 transition-transform duration-300 ease-out"
            style={{ insetInlineStart: "0.375rem", transform: `translateX(${tab === "convs" ? 0 : tab === "unresolved" ? "-100%" : "-200%"})` }}
            aria-hidden="true"
          />
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`relative z-10 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-[13px] font-bold transition-colors duration-300 ${
                tab === t.id ? "text-oro" : "text-sage hover:text-bone"
              }`}
            >
              {t.icon}
              {t.label}
              {t.badge ? (
                <span className="min-w-5 h-5 px-1 rounded-full bg-oro text-ink text-[10.5px] font-bold flex items-center justify-center tabular-nums">
                  {t.badge}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        {/* ── المحادثات ── */}
        {tab === "convs" && (
          <div className="grid lg:grid-cols-[320px_1fr] gap-4 items-start">
            <aside className={`${cls.card} overflow-hidden ${mobileThread ? "hidden lg:block" : ""}`}>
              <div className="px-4 py-3.5 border-b border-verde/10 flex items-center justify-between">
                <p className="text-xs font-bold text-sage">الوارد على واتساب</p>
                <span className="w-2 h-2 rounded-full bg-verde live-dot" />
              </div>
              <ul className="max-h-[520px] overflow-y-auto qa-scroll">
                {st.convs.length === 0 && (
                  <li className="px-5 py-10 text-center text-xs text-sage/70 leading-6">
                    لا محادثات بعد — أرسل رسالة من أي رقم واتساب لموظفك.
                  </li>
                )}
                {st.convs.map((c) => {
                  const last = c.msgs[c.msgs.length - 1];
                  const sel = c.id === activeConv;
                  return (
                    <li key={c.id}>
                      <button
                        onClick={() => { setActiveConv(c.id); setMobileThread(true); }}
                        className={`w-full text-start px-4 py-3.5 border-b border-verde/8 transition-all duration-200 ${
                          sel ? "bg-moss/80" : "hover:bg-night/50"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <span className="text-[13px] font-bold text-bone" dir="ltr">{c.phone}</span>
                          <span className="text-[10px] text-sage tabular-nums">{fmtTime(c.lastAt)}</span>
                        </div>
                        <p className="text-[11.5px] text-sage truncate">{last?.body ?? "—"}</p>
                        <div className="flex gap-1.5 mt-1.5">
                          {c.transferred && (
                            <span className="text-[9.5px] font-bold text-oro-soft bg-oro/10 border border-oro/30 rounded-full px-2 py-0.5 inline-flex items-center gap-1">
                              <IconHandoff className="w-3 h-3" /> محوّلة لبشري
                            </span>
                          )}
                          {c.paused === "credits" && (
                            <span className="text-[9.5px] font-bold text-oro-soft bg-oro/10 border border-oro/30 rounded-full px-2 py-0.5">
                              موقوفة — نفد الرصيد
                            </span>
                          )}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </aside>

            {/* الخيط */}
            <section className={`${cls.card} overflow-hidden ${!mobileThread && !active ? "hidden lg:flex" : "flex"} flex-col`} style={{ minHeight: 460 }}>
              {!active ? (
                <div className="flex-1 flex flex-col items-center justify-center text-center p-10 gap-3">
                  <span className="text-verde/50"><IconLog className="w-10 h-10" /></span>
                  <p className="text-sm text-sage">اختر محادثة لعرض رسائلها والرد منها</p>
                </div>
              ) : (
                <>
                  <div className="px-4 py-3 border-b border-verde/10 flex items-center gap-3 bg-wa-dark/40">
                    <button onClick={() => setMobileThread(false)} className="lg:hidden text-sage hover:text-bone transition-colors" aria-label="عودة">
                      <IconChevronDown className="w-4 h-4 rotate-90" />
                    </button>
                    <span className="w-9 h-9 rounded-full bg-moss border border-verde/30 text-verde flex items-center justify-center">
                      <IconWhatsapp className="w-4.5 h-4.5" />
                    </span>
                    <div className="flex-1">
                      <p className="text-[13px] font-bold text-bone" dir="ltr">{active.phone}</p>
                      <p className="text-[10.5px] text-sage">
                        {active.transferred ? "محوّلة لك — الرد الآلي متوقف" : active.paused ? "الرد الآلي موقوف" : "الرد الآلي يعمل"}
                      </p>
                    </div>
                    {active.transferred && (
                      <span className="text-[10px] font-bold text-oro-soft bg-oro/10 border border-oro/30 rounded-full px-2.5 py-1 inline-flex items-center gap-1">
                        <IconHandoff className="w-3 h-3" /> تحتاج تدخلّك
                      </span>
                    )}
                  </div>

                  <div className="flex-1 overflow-y-auto qa-scroll p-4 space-y-2.5 bg-[radial-gradient(700px_300px_at_50%_0%,rgba(46,194,126,0.05),transparent_70%)]" style={{ maxHeight: 400 }}>
                    {active.msgs.map((m) => (
                      <div key={m.id} className={`flex ${m.direction === "out" ? "justify-start" : "justify-end"} msg-in`}>
                        <div
                          className={`max-w-[78%] rounded-2xl px-3.5 py-2.5 shadow-sm ${
                            m.direction === "out" ? "bg-wa-out rounded-bl-md" : "bg-wa-in rounded-br-md"
                          }`}
                        >
                          <p className="text-[13px] leading-6 text-bone">{m.body}</p>
                          <p className="flex items-center justify-end gap-1.5 mt-1 text-[9.5px] text-sage/80">
                            {m.kind === "refusal" && <span className="text-oro-soft">بدون معلومة مؤكدة</span>}
                            {m.kind === "handoff" && <span className="text-oro-soft">تحويل</span>}
                            {m.direction === "out" && (
                              <span className={`rounded-full px-1.5 py-px border text-[8.5px] font-bold ${m.is_auto ? "border-verde/50 text-verde" : "border-oro/50 text-oro-soft"}`}>
                                {m.is_auto ? "آلي" : "أنت"}
                              </span>
                            )}
                            <span className="tabular-nums">{fmtTime(m.created_at)}</span>
                          </p>
                        </div>
                      </div>
                    ))}
                    <div ref={threadEndRef} />
                  </div>

                  {/* الملحن */}
                  <div className="p-3.5 border-t border-verde/10 bg-night/40">
                    {(active.transferred || active.paused) && (
                      <label className="flex items-center gap-2.5 mb-2.5 text-[11.5px] text-mist cursor-pointer select-none">
                        <input type="checkbox" checked={resumeAuto} onChange={(e) => setResumeAuto(e.target.checked)} className="accent-[#2ec27e] w-4 h-4" />
                        استئناف الرد الآلي بعد إرسال هذا الرد
                      </label>
                    )}
                    <div className="flex gap-2.5 items-end">
                      <textarea
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); replyManual(); } }}
                        rows={1}
                        placeholder="اكتب ردّك اليدوي…"
                        className={`${cls.input} resize-none flex-1`}
                      />
                      <button onClick={replyManual} disabled={sending || !draft.trim()} className={`${cls.btn} !rounded-xl !px-4 !py-2.5`} aria-label="إرسال">
                        <IconSend className="w-5 h-5 -scale-x-100" />
                      </button>
                    </div>
                  </div>
                </>
              )}
            </section>
          </div>
        )}

        {/* ── الأسئلة العالقة ── */}
        {tab === "unresolved" && (
          <div className="space-y-4">
            <p className="text-[12.5px] text-sage leading-6">
              أسئلة لم يجد الموظف لها إجابة <span className="text-bone font-semibold">مؤكدة</span> من قاعدة معرفتك — رفض الاختلاق وسجّلها لك.
              أجبها مرة واحدة وأضفها للمعرفة ليتعلم فورًا.
            </p>
            {st.unresolved.length === 0 && (
              <div className={`${cls.card} p-12 text-center`}>
                <span className="text-verde inline-block mb-3"><IconCheck className="w-8 h-8" /></span>
                <p className="font-display font-bold text-lg text-bone">لا أسئلة عالقة — موظفك يغطي كل شيء</p>
                <p className="text-xs text-sage mt-1.5">عندما يعجز عن التأكد من سؤال، ستجده هنا بدل أن يخمّن.</p>
              </div>
            )}
            {st.unresolved.map((u) => {
              const a = answers[u.id] ?? { text: "", save: true };
              return (
                <article key={u.id} className={`${cls.card} p-5 hover:border-oro/35 transition-colors duration-300 msg-in`}>
                  <div className="flex flex-wrap items-center gap-2.5 mb-3">
                    <span className="w-8 h-8 rounded-xl bg-oro/10 border border-oro/30 text-oro flex items-center justify-center">
                      <IconQuestion className="w-4.5 h-4.5" />
                    </span>
                    <p className="font-display font-bold text-[15px] text-bone flex-1">{u.question}</p>
                    {typeof u.bestSimilarity === "number" && (
                      <span className="text-[10px] font-bold text-oro-soft bg-oro/10 border border-oro/25 rounded-full px-2.5 py-1 tabular-nums" title="أعلى تشابه دلالي وجده الموظف — تحت عتبة الثقة">
                        تشابه {(u.bestSimilarity * 100).toFixed(0)}%
                      </span>
                    )}
                    <span className="text-[10.5px] text-sage tabular-nums">{fmtDate(u.createdAt)}</span>
                  </div>
                  <textarea
                    value={a.text}
                    onChange={(e) => setAnswers((prev) => ({ ...prev, [u.id]: { ...a, text: e.target.value } }))}
                    rows={2}
                    placeholder="اكتب الإجابة الصحيحة هنا…"
                    className={`${cls.input} resize-none mb-3`}
                  />
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-2 text-[11.5px] text-mist cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={a.save}
                        onChange={(e) => setAnswers((prev) => ({ ...prev, [u.id]: { ...a, save: e.target.checked } }))}
                        className="accent-[#2ec27e] w-4 h-4"
                      />
                      أضفها لقاعدة المعرفة (يتعلمها الموظف)
                    </label>
                    <button onClick={() => resolveOne(u)} className={`${cls.btn} ms-auto !py-2 !px-4 text-xs`}>
                      {u.conversationId ? "إرسالها للعميل وحلّها" : "حفظها وحلّها"}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {/* ── المعرفة ── */}
        {tab === "knowledge" && (
          <div className="grid lg:grid-cols-[1fr_360px] gap-4 items-start">
            <section className={`${cls.card} overflow-hidden`}>
              <div className="px-5 py-4 border-b border-verde/10 flex items-center justify-between">
                <p className="text-sm font-bold text-bone inline-flex items-center gap-2">
                  <IconDatabase className="w-4.5 h-4.5 text-verde" />
                  مصادر معلومات الموظف
                </p>
                <span className="text-[11px] text-sage tabular-nums">
                  {st.sources.reduce((s, x) => s + x.chunks, 0)} قطعة معرفية
                </span>
              </div>
              <ul className="divide-y divide-verde/8">
                {st.sources.length === 0 && (
                  <li className="px-5 py-12 text-center text-xs text-sage/70">لا مصادر بعد — أضف رابطًا أو نصًا من الجهة الأخرى.</li>
                )}
                {st.sources.map((s) => (
                  <li key={s.id} className="px-5 py-4 flex items-center gap-3.5 group hover:bg-night/40 transition-colors duration-200">
                    <span className="w-9 h-9 rounded-xl bg-moss border border-verde/25 text-verde flex items-center justify-center shrink-0">
                      {s.kind === "gmaps" ? <IconMapPin className="w-4.5 h-4.5" /> : s.kind === "website" ? <IconGlobe className="w-4.5 h-4.5" /> : <IconPen className="w-4.5 h-4.5" />}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-semibold text-bone truncate" dir="auto">
                        {s.url ?? (s.kind === "manual-text" ? "نص يدوي / سؤال محلول" : s.kind)}
                      </p>
                      <p className="text-[10.5px] text-sage mt-0.5 tabular-nums">{fmtDate(s.createdAt)}</p>
                    </div>
                    {s.status === "indexed" && (
                      <span className="text-[10.5px] font-bold text-verde bg-verde/10 border border-verde/30 rounded-full px-2.5 py-1 tabular-nums shrink-0">
                        مفهرس — {s.chunks} قطعة
                      </span>
                    )}
                    {s.status === "pending" && (
                      <span className="text-[10.5px] font-bold text-oro-soft bg-oro/10 border border-oro/30 rounded-full px-2.5 py-1 shrink-0 shimmer">
                        جارٍ الفهرسة…
                      </span>
                    )}
                    {s.status === "failed" && (
                      <span className="text-[10.5px] font-bold text-oro-soft bg-oro/10 border border-oro/30 rounded-full px-2.5 py-1 shrink-0">
                        فشل {s.error ? `— ${s.error}` : ""}
                      </span>
                    )}
                    <button onClick={() => deleteSource(s.id)} className="text-sage/40 hover:text-oro transition-all duration-200 active:scale-90 shrink-0" aria-label="حذف المصدر">
                      <IconTrash className="w-4 h-4" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            <aside className={`${cls.card} p-5`}>
              <p className="text-sm font-bold text-bone mb-4">أضف مصدرًا جديدًا</p>
              <div className="flex bg-night/60 border border-verde/15 rounded-xl p-1 mb-4">
                {(["url", "text"] as const).map((k) => (
                  <button
                    key={k}
                    onClick={() => setNewSource((p) => ({ ...p, kind: k }))}
                    className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all duration-300 ${
                      newSource.kind === k ? "bg-moss text-oro" : "text-sage hover:text-bone"
                    }`}
                  >
                    {k === "url" ? "رابط" : "نص"}
                  </button>
                ))}
              </div>
              {newSource.kind === "url" ? (
                <input dir="ltr" value={newSource.url} onChange={(e) => setNewSource((p) => ({ ...p, url: e.target.value }))} className={`${cls.input} text-left mb-4`} placeholder="https://your-site.com" />
              ) : (
                <textarea value={newSource.text} onChange={(e) => setNewSource((p) => ({ ...p, text: e.target.value }))} rows={5} className={`${cls.input} resize-none mb-4`} placeholder="الصق معلومات مشروعك: الأسعار، المواعيد، السياسات…" />
              )}
              <button onClick={addSource} className={`${cls.btn} w-full py-3`}>
                <IconPlus className="w-4 h-4" />
                استخراج وفهرسة
              </button>
              <p className="text-[10.5px] text-sage/75 leading-5 mt-3.5">
                يُستخرج النص، يُقسّم لقطع، وتُوَلّد له تمثيلات دلالية — يبحث فيها الموظف بالتشابه لا بالكلمات.
              </p>
            </aside>
          </div>
        )}
      </main>

      {/* ── نافذة ربط واتساب ── */}
      {qrOpen && (
        <QrModal
          demo={demo}
          tenantId={st.tenantId}
          onClose={() => setQrOpen(false)}
          token={token}
          onState={(s) => setSt((p) => (p ? { ...p, waStatus: s } : p))}
        />
      )}

      {/* ── نافذة الشحن ── */}
      {payOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
          <button className="absolute inset-0 bg-night/80 backdrop-blur-sm" onClick={() => setPayOpen(false)} aria-label="إغلاق" />
          <div className="relative w-full max-w-lg bg-pine border border-verde/25 rounded-3xl p-6 msg-in shadow-[0_40px_120px_-30px_rgba(0,0,0,0.9)]">
            <button onClick={() => setPayOpen(false)} className="absolute top-4 left-4 text-sage hover:text-bone transition-colors" aria-label="إغلاق">
              <IconX className="w-5 h-5" />
            </button>
            <h3 className="font-display font-bold text-xl text-bone mb-1">اشحن رصيد الردود</h3>
            <p className="text-[11.5px] text-sage mb-5">
              التفعيل يتم تلقائيًا فور تأكيد بوابة الدفع (Moyasar){demo && " — هنا محاكاة فقط"}.
            </p>
            <div className="space-y-3">
              {[
                { id: "starter", name: "البداية", credits: 1000, price: 99 },
                { id: "growth", name: "النمو", credits: 3000, price: 249, hot: true },
                { id: "scale", name: "التوسع", credits: 10000, price: 649 },
              ].map((p) => (
                <button
                  key={p.id}
                  onClick={() => recharge(p.id)}
                  className={`w-full flex items-center gap-4 rounded-2xl border p-4 text-start transition-all duration-300 active:scale-[0.98] group ${
                    p.hot
                      ? "border-oro/60 bg-oro/5 hover:bg-oro/10 hover:shadow-[0_12px_40px_-12px_rgba(232,178,75,0.35)]"
                      : "border-verde/20 bg-night/40 hover:border-verde/45"
                  }`}
                >
                  <span className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${p.hot ? "bg-oro/15 text-oro" : "bg-moss text-verde"}`}>
                    <IconCoin className="w-5 h-5" />
                  </span>
                  <span className="flex-1">
                    <span className="block text-sm font-bold text-bone">
                      {p.name}
                      {p.hot && <span className="text-[9.5px] text-oro-soft border border-oro/40 rounded-full px-2 py-0.5 ms-2 align-middle">الأكثر طلبًا</span>}
                    </span>
                    <span className="block text-[11px] text-sage mt-0.5 tabular-nums">{p.credits.toLocaleString("en")} رد ذكي</span>
                  </span>
                  <span className="font-display font-bold text-xl text-bone tabular-nums group-hover:text-oro transition-colors">
                    {p.price} <span className="text-[11px] text-sage font-body">ريال</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* توست */}
      {toast && (
        <div className="fixed bottom-6 inset-x-0 z-50 flex justify-center px-4 pointer-events-none">
          <p className="bg-pine border border-verde/35 text-bone text-[12.5px] font-semibold rounded-full px-5 py-2.5 shadow-[0_16px_50px_-12px_rgba(0,0,0,0.8)] msg-in">
            {toast}
          </p>
        </div>
      )}
    </Shell>
  );
}

/* ═══════════ نافذة QR ═══════════ */

function QrModal({ demo, tenantId, token, onClose, onState }: { demo: boolean; tenantId: string; token: string | null; onClose: () => void; onState: (s: string) => void }) {
  const [snap, setSnap] = useState<WaSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const retries = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const pollRef = useRef<number | null>(null);
  const busyRef = useRef(false);

  const stopStreams = () => {
    esRef.current?.close();
    esRef.current = null;
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const apply = (s: WaSnapshot) => {
    setSnap(s);
    onState(s.state === "CONNECTED" ? "connected" : s.state === "QR_REQUIRED" ? "qr" : "disconnected");
    // فُصل من الجوال → جلسة جديدة ورمز جديد تلقائياً دون تحديث الصفحة
    if (s.state === "LOGGED_OUT" && retries.current < 2 && !busyRef.current) {
      retries.current += 1;
      window.setTimeout(() => connect(), 1000);
    }
  };

  const connect = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setFailed(false);
    try {
      const s = await api.wa.createSession(tenantId, token);
      stopStreams();
      let failures = 0;
      const es = new EventSource(api.wa.eventsUrl(s.sessionId, token));
      esRef.current = es;
      es.onmessage = (m) => {
        try {
          failures = 0;
          apply(JSON.parse(m.data) as WaSnapshot);
        } catch {
          /* تجاهل */
        }
      };
      es.onerror = () => {
        failures += 1;
        if (failures >= 3) {
          es.close();
          esRef.current = null;
          pollRef.current = window.setInterval(async () => {
            try {
              apply(await api.wa.getQr(s.sessionId, token));
            } catch {
              /* إعادة المحاولة لاحقاً */
            }
          }, 2500);
        }
      };
    } catch {
      setFailed(true);
    }
    busyRef.current = false;
  };

  useEffect(() => {
    if (demo) return; // وضع العرض: لا جلسة حقيقية ولا QR — رسالة خطأ فقط
    connect();
    return stopStreams;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo]);

  const logoutDevice = async () => {
    if (!snap) return;
    setLoggingOut(true);
    try {
      await api.wa.logout(snap.sessionId, token);
      onState("disconnected");
    } catch {
      /* تجاهل */
    }
    setLoggingOut(false);
  };

  /* بدون خادم: لا نعرض أي رمز — رسالة واضحة فقط */
  if (demo || failed) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
        <button className="absolute inset-0 bg-night/80 backdrop-blur-sm" onClick={onClose} aria-label="إغلاق" />
        <div className="relative w-full max-w-sm bg-pine border border-oro/30 rounded-3xl p-6 text-center msg-in shadow-[0_40px_120px_-30px_rgba(0,0,0,0.9)]">
          <button onClick={onClose} className="absolute top-4 left-4 text-sage hover:text-bone transition-colors" aria-label="إغلاق">
            <IconX className="w-5 h-5" />
          </button>
          <div className="py-4">
            <span className="inline-flex w-14 h-14 rounded-full bg-oro/10 border border-oro/35 items-center justify-center text-oro mb-4">
              <IconWhatsapp className="w-7 h-7" />
            </span>
            <h3 className="font-display font-bold text-lg text-bone mb-2">
              تعذر إنشاء جلسة واتساب، تحقق من اتصال الخادم.
            </h3>
            <p className="text-[11.5px] text-sage leading-5 mb-5">
              {demo
                ? "وضع العرض لا يربط واتساب حقيقياً — شغّل الخادم (server/) واضبط VITE_API_URL ثم أعد المحاولة."
                : "الخادم لا يستجيب أو الجلسة رُفضت — تأكد من تشغيل الخادم ثم أعد المحاولة."}
            </p>
            {!demo && (
              <button onClick={connect} className={`${cls.btn} w-full py-3 mb-3`}>
                <IconRefresh className="w-4.5 h-4.5" />
                إعادة المحاولة
              </button>
            )}
            <button onClick={onClose} className="text-xs text-sage hover:text-bone underline underline-offset-4 transition-colors">
              إغلاق
            </button>
          </div>
        </div>
      </div>
    );
  }

  const st = snap?.state ?? "CONNECTING";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <button className="absolute inset-0 bg-night/80 backdrop-blur-sm" onClick={onClose} aria-label="إغلاق" />
      <div className="relative w-full max-w-sm bg-pine border border-verde/25 rounded-3xl p-6 text-center msg-in shadow-[0_40px_120px_-30px_rgba(0,0,0,0.9)]">
        <button onClick={onClose} className="absolute top-4 left-4 text-sage hover:text-bone transition-colors" aria-label="إغلاق">
          <IconX className="w-5 h-5" />
        </button>

        {st === "CONNECTED" ? (
          <div className="py-4">
            <span className="inline-flex w-16 h-16 rounded-full bg-verde/15 border border-verde/40 items-center justify-center text-verde mb-4 msg-in">
              <IconCheck className="w-8 h-8" />
            </span>
            <h3 className="font-display font-bold text-xl text-bone mb-1.5">
              تم الربط بنجاح{snap?.phone ? ` — ${snap.phone}` : ""}
            </h3>
            <p className="text-xs text-sage leading-5 mb-5">الموظف يرد الآن من معلومات مشروعك فقط.</p>
            <button onClick={onClose} className={`${cls.btn} w-full py-3 mb-2.5`}>ممتاز</button>
            <button
              onClick={logoutDevice}
              disabled={loggingOut}
              className="w-full text-[11.5px] text-sage hover:text-oro underline underline-offset-4 transition-colors disabled:opacity-50"
            >
              {loggingOut ? "جارٍ الفصل…" : "فصل الجهاز (تسجيل خروج)"}
            </button>
          </div>
        ) : (
          <>
            <h3 className="font-display font-bold text-xl text-bone mb-1">اربط واتساب</h3>
            <p className="text-[11.5px] text-sage leading-5 mb-4">
              واتساب ← الإعدادات ← الأجهزة المرتبطة ← ربط جهاز، ثم امسح الرمز
            </p>
            <div className="bg-bone rounded-2xl p-3 inline-block mb-3">
              {st === "QR_REQUIRED" && snap?.qrDataUrl ? (
                <img key={snap.qrDataUrl.length} src={snap.qrDataUrl} alt="رمز ربط واتساب" className="w-52 h-52" />
              ) : (
                <div className="w-52 h-52 flex flex-col items-center justify-center gap-2.5">
                  <span className="w-6 h-6 rounded-full border-2 border-[#1c5c41]/25 border-t-[#1c5c41] animate-spin" />
                  <span className="text-[13px] font-semibold" style={{ color: "#1c5c41" }}>
                    {st === "CONNECTING"
                      ? "جاري الاتصال…"
                      : st === "DISCONNECTED"
                        ? "انقطع الاتصال — إعادة المحاولة تلقائياً"
                        : st === "LOGGED_OUT"
                          ? "انتهت صلاحية الجلسة — رمز جديد خلال لحظات"
                          : st === "ERROR"
                            ? "تعذر إنشاء الجلسة"
                            : "جارٍ توليد الرمز…"}
                  </span>
                </div>
              )}
            </div>
            {st === "QR_REQUIRED" && (
              <p className="text-[10.5px] text-verde/90 leading-5">يتجدد الرمز تلقائياً فور صدور رمز جديد — اترك النافذة مفتوحة.</p>
            )}
            {st === "ERROR" && (
              <p className="text-[10.5px] text-oro-soft leading-5">
                {snap?.error ?? "تعذر إنشاء جلسة واتساب، تحقق من اتصال الخادم."}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ═══════════ الإطار العام ═══════════ */

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen bg-night text-bone font-body overflow-x-clip" dir="rtl">
      <div className="fixed inset-0 -z-10 pointer-events-none" aria-hidden="true">
        <div className="absolute inset-0 bg-night" />
        <div className="absolute inset-0 bg-[radial-gradient(1100px_600px_at_80%_-10%,rgba(46,194,126,0.09),transparent_60%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(900px_600px_at_-5%_60%,rgba(232,178,75,0.05),transparent_60%)]" />
      </div>
      <div className="noise-layer" aria-hidden="true" />
      {children}
    </div>
  );
}
