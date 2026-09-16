/**
 * لوحة تحكم إدارة ســوشـــيــــال — حقيقية عبر Supabase Auth + الخادم،
 * وبوضع عرض حيّ (بيانات محاكاة + سيناريو تلقائي) عندما لا تتوفر متغيرات البيئة.
 *
 * ملاحظات الإصلاح:
 * - لا يوجد polling على الإطلاق — كل التحديثات تأتي عبر Supabase Realtime.
 * - قناة Realtime واحدة موحّدة للمحادثات والرسائل.
 * - لا يتم عرض body_encrypted إطلاقًا في الواجهة (يُستخدم body المفكوك من الخادم).
 * - عند الإرسال اليدوي نعتمد على رسالة الـ Backend (أو fallback مؤقت عند غيابها).
 * - إدارة unreadCount: تزداد للرسائل الواردة على محادثة غير مفتوحة، وتُصفَّر عند فتح المحادثة.
 * - المحادثة النشطة لا تُقفل عند وصول رسالة لمحادثة أخرى.
 * - توحيد "out"/"outbound" إلى "out" و "in"/"inbound" إلى "in".
 * - تحميل رسائل المحادثة يتم فقط عند فتحها (لا دورية مستمرة).
 * - الشعار يُحمَّل عبر import.meta.env.BASE_URL ليعمل على GitHub Pages.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import confetti from "canvas-confetti";
import { apiAuthFetch, apiEnabled, api, backendMode, API, type WaSnapshot } from "../lib/api";
import { getSupabase, getStoredClaim, clearStoredClaim } from "../lib/supabase";
import {
  IconWhatsapp, IconCheck, IconX, IconPlus, IconTrash, IconSend,
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
  status?: "sending" | "sent" | "failed";
};
type ConvItem = {
  id: string;
  phone: string;
  customerName?: string | null;
  transferred: boolean;
  paused: string | null;
  humanAgentExpiresAt?: string | null;
  humanAgentActive?: boolean;
  remainingSeconds?: number;
  lastAt: string;
  lastMessagePreview?: string;
  unreadCount?: number;
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

/** رابط الشعار — يعمل على GitHub Pages والنطاق المخصص والمحلي. */
const LOGO_URL = `${import.meta.env.BASE_URL}logo.png`;

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" });
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("ar", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** توحيد اتجاه الرسالة القادم من الخادم إلى "in" | "out". */
const normalizeDirection = (d: string | null | undefined): "in" | "out" =>
  d === "out" || d === "outbound" ? "out" : "in";

/** استخراج نص الرسالة من صف قاعدة البيانات — لا نستخدم body_encrypted إطلاقًا. */
const extractBody = (row: any): string => {
  if (!row) return "";
  if (typeof row.body === "string" && row.body.length > 0) return row.body;
  return "";
};

const cls = {
  card: "bg-pine/70 border border-verde/15 rounded-2xl",
  input:
    "w-full bg-night/70 border border-verde/20 rounded-xl px-4 py-2.5 text-sm text-bone placeholder:text-sage/45 focus:outline-none focus:border-oro/70 focus:ring-2 focus:ring-oro/20 transition-all duration-300",
  btn: "inline-flex items-center justify-center gap-2 bg-verde text-ink font-display font-bold text-sm px-5 py-2.5 rounded-xl hover:bg-oro transition-all duration-300 active:scale-[0.97] disabled:opacity-50",
  btnGhost:
    "inline-flex items-center justify-center gap-2 border border-verde/25 text-mist font-semibold text-sm px-4 py-2.5 rounded-xl hover:border-oro/60 hover:text-oro transition-all duration-300 active:scale-[0.97]",
};

/* ═══════════════ أدوات مساعدة ═══════════════ */

const now = () => new Date().toISOString();
const ago = (min: number) => new Date(Date.now() - min * 60000).toISOString();

/* ═══════════════ المكوّن الرئيسي ═══════════════ */

export default function Dashboard() {
  const sb = useMemo(() => getSupabase(), []);
  const demo = sb === null;

  /* ── المصادقة ── */
  const [authed, setAuthed] = useState(demo ? false : true);
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

  const [tab, setTab] = useState<"convs" | "unresolved" | "knowledge" | "widgets">("convs");
  const [activeConv, setActiveConv] = useState<string | null>(null);
  const [mobileThread, setMobileThread] = useState(false);
  const [draft, setDraft] = useState("");
  const [resumeAuto, setResumeAuto] = useState(true);
  const [sending, setSending] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [answers, setAnswers] = useState<Record<string, { text: string; save: boolean }>>({});
  const [newSource, setNewSource] = useState<{ kind: "url" | "text"; url: string; text: string }>({ kind: "url", url: "", text: "" });

  // Widgets state
  const [widgets, setWidgets] = useState<any[]>([]);
  const [widgetPreview, setWidgetPreview] = useState<any>(null);
  const [widgetForm, setWidgetForm] = useState<{ name: string; welcomeMessage: string; primaryColor: string; position: "left" | "right"; placeholder: string }>({
    name: "",
    welcomeMessage: "مرحباً! كيف يمكنني مساعدتك؟",
    primaryColor: "#2ec27e",
    position: "left",
    placeholder: "اكتب رسالتك...",
  });
  const [editingWidget, setEditingWidget] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  /* ── Human Agent Countdown State ── */
  const [humanAgentCountdown, setHumanAgentCountdown] = useState<Record<string, number>>({});

  const threadEndRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<number | null>(null);
  const scriptIdx = useRef(0);

  const activeConvRef = useRef<string | null>(null);
  useEffect(() => {
    activeConvRef.current = activeConv;
  }, [activeConv]);

  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 3200);
  };

  /* ── Human Agent Countdown Timer ── */
  useEffect(() => {
    const interval = setInterval(() => {
      setHumanAgentCountdown((prev) => {
        const next: Record<string, number> = {};
        let hasChanged = false;
        let anyExpired = false;
        const expiredIds: string[] = [];

        Object.entries(prev).forEach(([convId, seconds]) => {
          if (seconds <= 0) {
            anyExpired = true;
            expiredIds.push(convId);
            return;
          }
          const newSeconds = seconds - 1;
          next[convId] = newSeconds;
          if (newSeconds !== seconds) hasChanged = true;
        });

        if (anyExpired) {
          // Handle expiration for each expired conversation
          expiredIds.forEach((convId) => {
            apiAuthFetch(token!, `/api/dashboard/conversations/${convId}/release`, { method: "POST" })
              .then(() => {
                setSt((prevSt) => prevSt ? {
                  ...prevSt,
                  convs: prevSt.convs.map((c) => c.id === convId ? {
                    ...c,
                    transferred: false,
                    humanAgentActive: false,
                    remainingSeconds: 0,
                    humanAgentExpiresAt: null
                  } : c)
                } : null);
                showToast("انتهت مدة Human Agent — عاد الرد الآلي");
              })
              .catch((e) => console.error("فشل الإلغاء التلقائي:", e));
          });
          return {}; // Clear all expired entries
        }

        return hasChanged ? next : prev;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [token]);

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
  const loadAll = useCallback(async (skipConvs = false) => {
    if (!token) return;
    try {
      // المرحلة 1: Summary فقط (سريع جدًا)
      const summary = await apiAuthFetch<any>(token, "/api/dashboard/summary");
      
      setSt((prev) => ({
        tenantId: summary.tenant.id,
        businessName: summary.tenant.businessName,
        isActive: summary.tenant.isActive,
        credits: summary.tenant.creditsRemaining,
        phone: summary.tenant.phone,
        waStatus: summary.wa.status,
        openUnresolved: summary.openUnresolved,
        convs: skipConvs ? (prev?.convs || []) : (prev?.convs || []),
        unresolved: prev?.unresolved || [],
        sources: prev?.sources || [],
        loadingList: true, // إظهار Skeleton
      }));
      
      // المرحلة 2: البيانات الثقيلة في الخلفية
      if (!skipConvs) {
        Promise.all([
          apiAuthFetch<any[]>(token, "/api/dashboard/conversations"),
          apiAuthFetch<any[]>(token, "/api/dashboard/unresolved"),
          apiAuthFetch<any[]>(token, "/api/dashboard/knowledge"),
        ]).then(([convs, unresolved, sources]) => {
          const nowD = new Date();
          setSt((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              convs: convs.map((c: any) => {
                const expiresAt = c.humanAgentExpiresAt ? new Date(c.humanAgentExpiresAt) : null;
                const humanAgentActive = Boolean(c.transferred && expiresAt && expiresAt > nowD);
                const remainingSeconds = humanAgentActive && expiresAt
                  ? Math.floor((expiresAt.getTime() - nowD.getTime()) / 1000)
                  : 0;
                return {
                  id: c.id,
                  phone: c.customerPhone,
                  transferred: c.transferred,
                  paused: c.autoPausedReason,
                  humanAgentExpiresAt: c.humanAgentExpiresAt,
                  humanAgentActive,
                  remainingSeconds,
                  lastAt: c.lastMessageAt,
                  lastMessagePreview: c.lastMessageBody || "—",
                  unreadCount: 0,
                  msgs: [],
                };
              }),
              unresolved: unresolved.filter((q: any) => q.status === "open").map((q: any) => ({
                id: q.id, question: q.question, createdAt: q.createdAt,
                conversationId: q.conversationId, bestSimilarity: q.bestSimilarity,
              })),
              sources: sources.map((s: any) => ({
                id: s.id, kind: s.kind, url: s.url, status: s.status,
                chunks: s.chunks_count ?? 0, createdAt: s.created_at, error: s.error ?? undefined,
              })),
              loadingList: false, // إخفاء Skeleton
            };
          });
        }).catch(err => {
          console.error("فشل تحميل البيانات الثانوية:", err);
          setSt(prev => prev ? { ...prev, loadingList: false } : null);
        });
      }
      
      setNeedClaim(false);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, token]);

  /* ── تحميل البيانات الحقيقية ── */
  useEffect(() => {
    if (demo || !authed || !token) {
      setSt(null);
      return;
    }
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, authed, token]);

  /* ═══════════════════════════════════════════════════════════
   *  قناة Realtime واحدة موحّدة (محادثات + رسائل).
   * ═══════════════════════════════════════════════════════════ */
  useEffect(() => {
    if (demo || !token || needClaim || !sb) return;

    /* ── INSERT: محادثة جديدة ── */
    const handleConvInsert = (payload: any) => {
      const row = payload.new ?? {};
      setSt((prev) => {
        if (!prev) return prev;
        if (prev.convs.some((c) => c.id === row.id)) return prev;

        const nowD = new Date();
        const expiresAt = row.human_agent_expires_at ? new Date(row.human_agent_expires_at) : null;
        const humanAgentActive = Boolean(row.transferred && expiresAt && expiresAt > nowD);
        const remainingSeconds = humanAgentActive && expiresAt
          ? Math.floor((expiresAt.getTime() - nowD.getTime()) / 1000)
          : 0;

        const newConv: ConvItem = {
          id: row.id,
          phone: row.customer_phone ?? row.customer_phone_e164 ?? "",
          transferred: Boolean(row.transferred),
          paused: row.auto_paused_reason ?? null,
          humanAgentExpiresAt: row.human_agent_expires_at ?? null,
          humanAgentActive,
          remainingSeconds,
          lastAt: row.last_message_at ?? now(),
          lastMessagePreview: extractBody(row) || "—",
          unreadCount: 1,
          msgs: [],
        };

        return { ...prev, convs: [newConv, ...prev.convs] };
      });
    };

    /* ── UPDATE: محادثة موجودة (حقولها الوصفية فقط) ── */
    const handleConvUpdate = (payload: any) => {
      const row = payload.new ?? {};
      
      // ── كشف التحويل التلقائي من AI (ai_handoff) ──
      setSt((prev) => {
        if (!prev) return prev;
        
        const prevConv = prev.convs.find((c) => c.id === row.id);
        const wasTransferred = prevConv?.transferred ?? false;
        const nowTransferred = Boolean(row.transferred);
        
        // قبول عدة قيم للسبب لضمان العمل حتى لو اختلفت التسمية
        const isAutoTransfer =
          row.auto_paused_reason === "ai_handoff" ||
          row.auto_paused_reason === "no_answer" ||
          row.auto_paused_reason === "low_confidence" ||
          row.human_agent_activated_by === null; // fallback: إذا كان المفعّل null فهو آلي
        
        // إذا تحوّلت المحادثة للتو من AI
        if (!wasTransferred && nowTransferred && isAutoTransfer) {
          queueMicrotask(() => {
            showToast(
              "🔔 محادثة تحتاج تدخلك — الموظف الذكي لم يجد إجابة مؤكدة"
            );
            // نغمة تنبيه (اختيارية)
            try {
              const audio = new Audio(
                "data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBSuBzvLZiTYIG2m98OScTgwOUarm7blmGgU7k9n1unEiBC13yO/eizEIHWq+8+OWT"
              );
              audio.volume = 0.3;
              audio.play().catch(() => {});
            } catch {}
          });
        }
        
        return prev;
      });
      
      setSt((prev) => {
        if (!prev) return prev;
        const exists = prev.convs.some((c) => c.id === row.id);
        if (!exists) return prev;

        return {
          ...prev,
          convs: prev.convs.map((c) => {
            if (c.id !== row.id) return c;
            const nowD = new Date();
            const expiresAt = row.human_agent_expires_at ? new Date(row.human_agent_expires_at) : null;
            const humanAgentActive = Boolean(row.transferred && expiresAt && expiresAt > nowD);
            const remainingSeconds = humanAgentActive && expiresAt
              ? Math.floor((expiresAt.getTime() - nowD.getTime()) / 1000)
              : 0;
            return {
              ...c,
              transferred: Boolean(row.transferred ?? c.transferred),
              paused: row.auto_paused_reason ?? c.paused,
              humanAgentExpiresAt: row.human_agent_expires_at ?? c.humanAgentExpiresAt,
              humanAgentActive,
              remainingSeconds,
            };
          }),
        };
      });
    };

    /* ── INSERT: رسالة جديدة ── */
    const handleMessageInsert = (payload: any) => {
      const row = payload.new ?? {};
      const convId: string = row.conversation_id;
      if (!convId) return;

      const direction = normalizeDirection(row.direction);
      // نستخدم ref للتأكد من حالة الفتح الحالية دون مشاكل closure
      const isActive = activeConvRef.current === convId;

      setSt((prev) => {
        if (!prev) return prev;
        
        const target = prev.convs.find((c) => c.id === convId);
        
        // حالة خاصة: محادثة جديدة تمامًا لم تظهر في القائمة بعد
        if (!target) {
          // نطلب إعادة تحميل القائمة في الخلفية لإضافتها
          queueMicrotask(() => loadAll(true).catch(() => {}));
          return prev; 
        }

        // تحديث بيانات المحادثة في القائمة الجانبية
        const updatedConv: ConvItem = {
          ...target,
          lastAt: row.created_at ?? now(),
          // نحتفظ بالنص القديم أو نضع "..." حتى يتم فك التشفير عند الفتح
          lastMessagePreview: target.lastMessagePreview || "…",
          unreadCount:
            isActive || direction === "out"
              ? (target.unreadCount ?? 0)
              : (target.unreadCount ?? 0) + 1,
          // لا نلمس msgs هنا لتجنب إضافة رسالة فارغة
          msgs: target.msgs, 
        };

        const others = prev.convs.filter((c) => c.id !== convId);
        return { ...prev, convs: [updatedConv, ...others] };
      });

      // إذا كانت المحادثة مفتوحة حاليًا، نجلب الرسائل المفكوكة فورًا
      if (isActive) {
        queueMicrotask(() => {
          loadThread(convId).catch((err) => {
            console.error("فشل جلب الرسائل المحدثة:", err);
          });
        });
      }
    };

    const channel = sb
      .channel("dashboard-realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "conversations" },
        handleConvInsert
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "conversations" },
        handleConvUpdate
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        handleMessageInsert
      )
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR") {
          console.warn("[Realtime] channel error — check RLS / publication");
        }
      });

    return () => {
      sb.removeChannel(channel);
    };
  }, [demo, token, needClaim, sb]);

  /* ── تحميل رسائل المحادثة النشطة (مرة واحدة عند فتحها) ── */
  const loadThread = useCallback(async (convId: string) => {
    if (!token) return;
    try {
      const msgs = await apiAuthFetch<any[]>(token, `/api/dashboard/conversations/${convId}/messages`);
      setSt((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          convs: prev.convs.map((c) =>
            c.id === convId
              ? {
                  ...c,
                  msgs: msgs.map((m: any) => ({
                    id: m.id,
                    direction: normalizeDirection(m.direction),
                    body: extractBody(m),
                    kind: m.kind ?? "text",
                    is_auto: Boolean(m.is_auto),
                    created_at: m.created_at,
                  })),
                }
              : c
          ),
        };
      });
    } catch (e) {
      console.error("[Dashboard] loadThread error:", e);
    }
  }, [token]);

  useEffect(() => {
    if (demo || !activeConv || !token) return;
    loadThread(activeConv).catch(() => {});
  }, [demo, activeConv, token, loadThread]);

  /* تمرير تلقائي لأسفل الخيط */
  const activeThread = st?.convs.find((c) => c.id === activeConv) ?? null;
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [activeThread?.msgs.length]);

  /* ── إجراءات ── */

  const openConversation = (convId: string) => {
    setActiveConv(convId);
    setMobileThread(true);
    setSt((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        convs: prev.convs.map((c) =>
          c.id === convId ? { ...c, unreadCount: 0 } : c
        ),
      };
    });
  };

  const replyManual = async () => {
    const active = st?.convs.find(c => c.id === activeConv);
    if (!active?.humanAgentActive && !active?.transferred) {
      showToast("يجب تفعيل Human Agent للرد اليدوي");
      return;
    }
    
    if (!activeConv || !draft.trim() || !st) return;
    const outgoing = draft.trim();
    
    // Optimistic UI: إضافة رسالة مؤقتة فورًا
    const tempId = `pending-${Date.now()}`;
    const optimisticMsg: ThreadMsg = {
      id: tempId,
      direction: "out",
      body: outgoing,
      kind: "manual",
      is_auto: false,
      created_at: now(),
      status: "sending",
    };
    
    setSt((prev) => {
      if (!prev) return prev;
      const target = prev.convs.find((c) => c.id === activeConv);
      if (!target) return prev;
      
      const updatedConv: ConvItem = {
        ...target,
        lastAt: optimisticMsg.created_at,
        lastMessagePreview: outgoing,
        msgs: [...(target.msgs || []), optimisticMsg],
      };
      
      const others = prev.convs.filter((c) => c.id !== activeConv);
      return { ...prev, convs: [updatedConv, ...others] };
    });
    
    setDraft("");
    
    try {
      if (demo) {
        // Demo mode: تحديث الحالة إلى sent فورًا
        setSt((prev) => {
          if (!prev) return prev;
          const target = prev.convs.find((c) => c.id === activeConv);
          if (!target) return prev;
          const newMsgs = target.msgs.map(m => 
            m.id === tempId ? { ...m, id: `man-${Date.now()}`, status: "sent" as const } : m
          );
          const updatedConv = { ...target, msgs: newMsgs };
          const others = prev.convs.filter((c) => c.id !== activeConv);
          return { ...prev, convs: [updatedConv, ...others] };
        });
      } else {
        const result: any = await apiAuthFetch<any>(
          token!,
          `/api/dashboard/conversations/${activeConv}/reply`,
          {
            method: "POST",
            body: JSON.stringify({ text: outgoing, resumeAuto }),
          }
        );
        
        const realId = result?.id ?? result?.message?.id ?? tempId;
        const realBody = result?.body ?? result?.message?.body ?? outgoing;
        const realKind = result?.kind ?? result?.message?.kind ?? "manual";
        const realCreatedAt = result?.created_at ?? result?.message?.created_at ?? now();
        
        // استبدال الرسالة المؤقتة بالحقيقية
        setSt((prev) => {
          if (!prev) return prev;
          const target = prev.convs.find((c) => c.id === activeConv);
          if (!target) return prev;
          
          const newMsgs = target.msgs.map(m => 
            m.id === tempId 
              ? { ...m, id: realId, body: realBody, kind: realKind, created_at: realCreatedAt, status: "sent" as const }
              : m
          );
          
          const updatedConv = { ...target, msgs: newMsgs };
          const others = prev.convs.filter((c) => c.id !== activeConv);
          return { ...prev, convs: [updatedConv, ...others] };
        });
        
        showToast("أُرسل الرد للعميل");
      }
    } catch (e: any) {
      // فشل الإرسال: تعليم الرسالة كـ failed
      setSt((prev) => {
        if (!prev) return prev;
        const target = prev.convs.find((c) => c.id === activeConv);
        if (!target) return prev;
        
        const newMsgs = target.msgs.map(m => 
          m.id === tempId ? { ...m, status: "failed" as const } : m
        );
        
        const updatedConv = { ...target, msgs: newMsgs };
        const others = prev.convs.filter((c) => c.id !== activeConv);
        return { ...prev, convs: [updatedConv, ...others] };
      });
      
      showToast(e?.message ?? "تعذر الإرسال — اضغط ❌ لإعادة المحاولة");
    }
  };
  
  const retrySend = async (msg: ThreadMsg) => {
    if (msg.status !== "failed" || !activeConv || !st) return;
    
    // إعادة تعيين الحالة إلى sending
    setSt((prev) => {
      if (!prev) return prev;
      const target = prev.convs.find((c) => c.id === activeConv);
      if (!target) return prev;
      
      const newMsgs = target.msgs.map(m => 
        m.id === msg.id ? { ...m, status: "sending" as const } : m
      );
      
      const updatedConv = { ...target, msgs: newMsgs };
      const others = prev.convs.filter((c) => c.id !== activeConv);
      return { ...prev, convs: [updatedConv, ...others] };
    });
    
    try {
      if (demo) {
        setSt((prev) => {
          if (!prev) return prev;
          const target = prev.convs.find((c) => c.id === activeConv);
          if (!target) return prev;
          const newMsgs = target.msgs.map(m => 
            m.id === msg.id ? { ...m, status: "sent" as const } : m
          );
          const updatedConv = { ...target, msgs: newMsgs };
          const others = prev.convs.filter((c) => c.id !== activeConv);
          return { ...prev, convs: [updatedConv, ...others] };
        });
      } else {
        const result: any = await apiAuthFetch<any>(
          token!,
          `/api/dashboard/conversations/${activeConv}/reply`,
          {
            method: "POST",
            body: JSON.stringify({ text: msg.body, resumeAuto: false }),
          }
        );
        
        const realId = result?.id ?? result?.message?.id ?? msg.id;
        const realBody = result?.body ?? result?.message?.body ?? msg.body;
        
        setSt((prev) => {
          if (!prev) return prev;
          const target = prev.convs.find((c) => c.id === activeConv);
          if (!target) return prev;
          
          const newMsgs = target.msgs.map(m => 
            m.id === msg.id 
              ? { ...m, id: realId, body: realBody, status: "sent" as const }
              : m
          );
          
          const updatedConv = { ...target, msgs: newMsgs };
          const others = prev.convs.filter((c) => c.id !== activeConv);
          return { ...prev, convs: [updatedConv, ...others] };
        });
      }
    } catch (e: any) {
      setSt((prev) => {
        if (!prev) return prev;
        const target = prev.convs.find((c) => c.id === activeConv);
        if (!target) return prev;
        
        const newMsgs = target.msgs.map(m => 
          m.id === msg.id ? { ...m, status: "failed" as const } : m
        );
        
        const updatedConv = { ...target, msgs: newMsgs };
        const others = prev.convs.filter((c) => c.id !== activeConv);
        return { ...prev, convs: [updatedConv, ...others] };
      });
      
      showToast("فشل الإرسال مجددًا");
    }
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
      const res = await api.createPayment(st?.tenantId ?? "", pkgId, token);
      if (res.paymentUrl) window.open(res.paymentUrl, "_blank", "noopener");
      showToast("فُتحت صفحة الدفع — التفعيل تلقائي بعد التأكيد");
      setPayOpen(false);
    } catch (e: any) {
      showToast(e?.message ?? "تعذر إنشاء الفاتورة");
    }
  };

  const logout = async () => {
    if (!demo) await sb!.auth.signOut();
    setAuthed(false);
    setSt(null);
    setToken(null);
  };

  /* ═══════════ Widgets Functions ═══════════ */

  const loadWidgets = useCallback(async () => {
    if (!token) return;
    try {
      const data = await apiAuthFetch<any[]>(token, "/api/widgets/dashboard");
      setWidgets(data);
    } catch (e: any) {
      console.error("Load widgets error:", e);
    }
  }, [token]);

  useEffect(() => {
    if (!demo && token) {
      loadWidgets();
    }
  }, [demo, token, loadWidgets]);

  const createWidget = async () => {
    if (!widgetForm.name.trim()) {
      showToast("أدخل اسم الـ widget");
      return;
    }
    try {
      if (demo) {
        const newWidget = {
          id: `w-${Date.now()}`,
          name: widgetForm.name,
          public_token: Math.random().toString(36).substr(2, 16),
          enabled: true,
          welcome_message: widgetForm.welcomeMessage,
          primary_color: widgetForm.primaryColor,
          position: widgetForm.position,
          placeholder: widgetForm.placeholder,
          created_at: new Date().toISOString(),
        };
        setWidgets([newWidget, ...widgets]);
        showToast("تم إنشاء الـ widget بنجاح");
        setWidgetForm({ name: "", welcomeMessage: "مرحباً! كيف يمكنني مساعدتك؟", primaryColor: "#2ec27e", position: "left", placeholder: "اكتب رسالتك..." });
      } else {
        const newWidget = await apiAuthFetch(token!, "/api/widgets/dashboard", {
          method: "POST",
          body: JSON.stringify({
            name: widgetForm.name,
            settings: {
              welcomeMessage: widgetForm.welcomeMessage,
              primaryColor: widgetForm.primaryColor,
              position: widgetForm.position,
              placeholder: widgetForm.placeholder,
            },
          }),
        });
        setWidgets([newWidget, ...widgets]);
        showToast("تم إنشاء الـ widget بنجاح");
        setWidgetForm({ name: "", welcomeMessage: "مرحباً! كيف يمكنني مساعدتك؟", primaryColor: "#2ec27e", position: "left", placeholder: "اكتب رسالتك..." });
      }
    } catch (e: any) {
      showToast(e?.message || "تعذر إنشاء الـ widget");
    }
  };

  const updateWidget = async (id: string, updates: any) => {
    try {
      if (demo) {
        setWidgets(widgets.map(w => w.id === id ? { ...w, ...updates } : w));
        showToast("تم تحديث الـ widget");
      } else {
        const updated = await apiAuthFetch(token!, `/api/widgets/dashboard/${id}`, {
          method: "PUT",
          body: JSON.stringify(updates),
        });
        setWidgets(widgets.map(w => w.id === id ? updated : w));
        showToast("تم تحديث الـ widget");
      }
      setEditingWidget(null);
    } catch (e: any) {
      showToast(e?.message || "تعذر تحديث الـ widget");
    }
  };

  const deleteWidget = async (id: string) => {
    if (!confirm("هل أنت متأكد من حذف هذا الـ widget؟")) return;
    try {
      if (demo) {
        setWidgets(widgets.filter(w => w.id !== id));
        showToast("تم حذف الـ widget");
      } else {
        await apiAuthFetch(token!, `/api/widgets/dashboard/${id}`, { method: "DELETE" });
        setWidgets(widgets.filter(w => w.id !== id));
        showToast("تم حذف الـ widget");
      }
    } catch (e: any) {
      showToast(e?.message || "تعذر حذف الـ widget");
    }
  };

  const toggleWidget = async (id: string, enabled: boolean) => {
    try {
      if (demo) {
        setWidgets(widgets.map(w => w.id === id ? { ...w, enabled } : w));
      } else {
        await apiAuthFetch(token!, `/api/widgets/dashboard/${id}`, {
          method: "PUT",
          body: JSON.stringify({ enabled }),
        });
        setWidgets(widgets.map(w => w.id === id ? { ...w, enabled } : w));
      }
    } catch (e: any) {
      showToast(e?.message || "تعذر تحديث الحالة");
    }
  };

  const copyEmbedCode = (token: string) => {
    const code = `<script src="${apiEnabled ? API : "https://your-server.com"}/widget.js" data-token="${token}"></script>`;
    navigator.clipboard.writeText(code);
    setCopiedCode(token);
    setTimeout(() => setCopiedCode(null), 2000);
    showToast("تم نسخ كود التضمين");
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
                  <img
                    src={LOGO_URL}
                    alt="إدارة ســوشـــيــــال"
                    className="w-11 h-11 rounded-full object-cover"
                  />
                  <span className="font-display font-bold text-3xl text-bone">
                    إدارة ســوشـــيــــال<span className="text-oro">.</span>
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
            <span className="text-verde inline-block mb-4">
              <img
                src={LOGO_URL}
                alt="إدارة ســوشـــيــــال"
                className="w-10 h-10 rounded-full object-cover"
              />
            </span>
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
    { id: "widgets" as const, label: "Widgets", icon: <span className="text-sm">💬</span> },
  ];

  return (
    <Shell>
      {/* شريط علوي */}
      <header className="sticky top-0 z-40 bg-night/85 backdrop-blur-md border-b border-verde/12">
        <div className="max-w-6xl mx-auto px-5 h-16 flex items-center justify-between gap-3">
          <a href="#top" className="flex items-center gap-2 group shrink-0">
            <span className="text-verde transition-transform duration-500 group-hover:rotate-[-8deg]">
              <img
                src={LOGO_URL}
                alt="إدارة ســوشـــيــــال"
                className="w-8 h-8 rounded-full object-cover"
              />
            </span>
            <span className="font-display font-bold text-xl text-bone hidden sm:block">
              إدارة ســوشـــيــــال<span className="text-oro">.</span>
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

        {/* شريط الملخص */}
        <div className="grid md:grid-cols-12 gap-4 mb-7">
          <section className={`${cls.card} md:col-span-5 p-5 relative overflow-hidden group hover:border-verde/35 transition-colors duration-300`}>
            <div className="absolute -bottom-14 -start-14 w-44 h-44 rounded-full bg-verde/10 blur-2xl group-hover:bg-verde/15 transition-colors duration-500" aria-hidden="true" />
            <div className="flex items-start justify-between gap-3 relative">
              <div>
                <p className="text-[11px] text-sage mb-1.5">حالة واتساب</p>
                <p className="flex items-center gap-2 font-display font-bold text-lg text-bone">
                  <span className={`w-2.5 h-2.5 rounded-full ${st.waStatus === "connected" ? "bg-verde live-dot" : "bg-oro"}`} />
                  {st.waStatus === "connected" ? "متصل" : st.waStatus === "qr" ? "بانتظار المسح" : "غير متصل"}
                </p>
                <p className="text-[11.5px] text-sage mt-1" dir="ltr">
                  {st.waStatus === "connected" ? "WhatsApp Cloud API" : "غير مُعدّ"}
                </p>
              </div>
              {st.waStatus === "connected" ? (
                <span className="text-xs text-verde font-semibold flex items-center gap-1">
                  <IconWhatsapp className="w-4 h-4" />
                  متصل عبر Cloud API
                </span>
              ) : (
                <span className="text-xs text-oro font-semibold flex items-center gap-1">
                  <IconWhatsapp className="w-4 h-4" />
                  تحقق من إعدادات Cloud API
                </span>
              )}
            </div>
            <div className="mt-4 flex items-center gap-2 text-[11px] text-sage relative">
              <IconRefresh className="w-3.5 h-3.5 text-verde" />
              تتحدث الحالة تلقائيًا كل بضع ثوانٍ
            </div>
          </section>

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
        <div className="relative bg-pine/50 border border-verde/12 rounded-2xl p-1.5 grid grid-cols-4 mb-6 max-w-lg">
          <span
            className="absolute top-1.5 bottom-1.5 w-[calc((100%-0.75rem)/4)] bg-moss rounded-xl border border-verde/25 transition-transform duration-300 ease-out"
            style={{ insetInlineStart: "0.375rem", transform: `translateX(${tab === "convs" ? 0 : tab === "unresolved" ? "-100%" : tab === "knowledge" ? "-200%" : "-300%"})` }}
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
                {st.loadingList ? (
                  // Skeleton Loader
                  Array.from({ length: 5 }).map((_, i) => (
                    <li key={i} className="px-4 py-3.5 border-b border-verde/8 animate-pulse">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-sage/10"></div>
                        <div className="flex-1 space-y-2">
                          <div className="h-3 bg-sage/10 rounded w-3/4"></div>
                          <div className="h-2 bg-sage/5 rounded w-1/2"></div>
                        </div>
                      </div>
                    </li>
                  ))
                ) : st.convs.length === 0 ? (
                  <li className="px-5 py-10 text-center text-xs text-sage/70 leading-6">
                    لا محادثات بعد — أرسل رسالة من أي رقم واتساب لموظفك.
                  </li>
                ) : st.convs.map((c) => {
                  const sel = c.id === activeConv;
                  return (
                    <li key={c.id}>
                      <button
                        onClick={() => openConversation(c.id)}
                        className={`w-full text-start px-4 py-3.5 border-b transition-all duration-200 ${
                          c.paused === "ai_handoff" && !c.humanAgentActive
                            ? `border-l-4 border-l-oro bg-oro/5 ${sel ? "bg-moss/80" : "hover:bg-night/50"}`
                            : `border-verde/8 ${sel ? "bg-moss/80" : "hover:bg-night/50"}`
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2 mb-1">
                          {c.customerName ? (
                            <>
                              <span className="text-[13px] font-bold text-bone">{c.customerName}</span>
                              <span className="text-[10px] text-sage tabular-nums" dir="ltr">{c.phone}</span>
                            </>
                          ) : (
                            <>
                              <span className="text-[13px] font-bold text-bone" dir="ltr">{c.phone}</span>
                              <span className="text-[10px] text-sage tabular-nums">{fmtTime(c.lastAt)}</span>
                            </>
                          )}
                          {!c.customerName && <span className="text-[10px] text-sage tabular-nums">{fmtTime(c.lastAt)}</span>}
                        </div>
                        <p className="text-[11.5px] text-sage truncate">
                          {c.lastMessagePreview ?? c.msgs[c.msgs.length - 1]?.body ?? "—"}
                        </p>
                        <div className="flex gap-1.5 mt-1.5 flex-wrap">
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
                          {c.paused === "ai_handoff" && !c.humanAgentActive && (
                            <span className="text-[9.5px] font-bold text-oro-soft bg-oro/10 border border-oro/30 rounded-full px-2 py-0.5 inline-flex items-center gap-1">
                              🔔 الموظف الذكي يحتاج مساعدتك
                            </span>
                          )}
                          {typeof c.unreadCount === "number" && c.unreadCount > 0 && !sel && (
                            <span className="text-[9.5px] font-bold text-white bg-verde rounded-full px-2 py-0.5 inline-flex items-center gap-1">
                              {c.unreadCount} جديدة
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
                      {active.customerName ? (
                        <>
                          <p className="text-[13px] font-bold text-bone">{active.customerName}</p>
                          <p className="text-[10.5px] text-sage" dir="ltr">{active.phone}</p>
                        </>
                      ) : (
                        <p className="text-[13px] font-bold text-bone" dir="ltr">{active.phone}</p>
                      )}
                      <p className="text-[10.5px] text-sage">
                        {active.humanAgentActive
                          ? `Human Agent Active — ${Math.floor((active.remainingSeconds ?? 0) / 60)}:${String((active.remainingSeconds ?? 0) % 60).padStart(2, '0')} متبقي`
                          : active.transferred
                            ? "محوّلة لك — الرد الآلي متوقف"
                            : active.paused
                              ? "الرد الآلي موقوف"
                              : "الرد الآلي يعمل"}
                      </p>
                    </div>
                    {active.humanAgentActive ? (
                      <button
                        onClick={async () => {
                          await apiAuthFetch(token!, `/api/dashboard/conversations/${active.id}/release`, { method: "POST" });
                          setHumanAgentCountdown((prev) => {
                            const next = { ...prev };
                            delete next[active.id];
                            return next;
                          });
                          setSt((prev) => prev ? {
                            ...prev,
                            convs: prev.convs.map((c) => c.id === active.id ? {
                              ...c,
                              transferred: false,
                              humanAgentActive: false,
                              remainingSeconds: 0,
                              humanAgentExpiresAt: null
                            } : c)
                          } : null);
                          showToast("تم إنهاء Human Agent — الرد الآلي يعمل");
                        }}
                        className="text-[10px] font-bold text-red-600 bg-red-100 hover:bg-red-200 border border-red-300 rounded-full px-2.5 py-1 inline-flex items-center gap-1 transition-colors"
                      >
                        <IconX className="w-3 h-3" /> إلغاء Human Agent
                      </button>
                    ) : active.transferred ? (
                      <>
                        <button
                          onClick={async () => {
                            try {
                              const res = await apiAuthFetch<{ expiresAt: string }>(token!, `/api/dashboard/conversations/${active.id}/takeover`, { method: "POST" });
                              setHumanAgentCountdown((prev) => ({
                                ...prev,
                                [active.id]: 900
                              }));
                              setSt((prev) => prev ? {
                                ...prev,
                                convs: prev.convs.map((c) => c.id === active.id ? {
                                  ...c,
                                  transferred: true,
                                  humanAgentActive: true,
                                  remainingSeconds: 900,
                                  humanAgentExpiresAt: res.expiresAt
                                } : c)
                              } : null);
                            } catch (e) {
                              console.error("فشل تفعيل Human Agent:", e);
                            }
                          }}
                          className="text-[10px] font-bold text-white bg-blue-600 hover:bg-blue-700 border border-blue-700 rounded-full px-2.5 py-1 inline-flex items-center gap-1 transition-colors"
                        >
                          <IconHandoff className="w-3 h-3" /> Human Agent
                        </button>
                        <button
                          onClick={async () => {
                            await apiAuthFetch(token!, `/api/dashboard/conversations/${active.id}/release`, { method: "POST" });
                            setSt((prev) => prev ? {
                              ...prev,
                              convs: prev.convs.map((c) => c.id === active.id ? {
                                ...c,
                                transferred: false,
                                humanAgentActive: false,
                                remainingSeconds: 0,
                                humanAgentExpiresAt: null
                              } : c)
                            } : null);
                            showToast("تم العودة للرد الآلي");
                          }}
                          className="text-[10px] font-bold text-emerald-600 bg-emerald-100 hover:bg-emerald-200 border border-emerald-300 rounded-full px-2.5 py-1 inline-flex items-center gap-1 transition-colors"
                        >
                          <IconCheck className="w-3 h-3" /> العودة للرد الآلي
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={async () => {
                          try {
                            const res = await apiAuthFetch<{ expiresAt: string }>(token!, `/api/dashboard/conversations/${active.id}/takeover`, { method: "POST" });
                            setHumanAgentCountdown((prev) => ({
                              ...prev,
                              [active.id]: 900
                            }));
                            setSt((prev) => prev ? {
                              ...prev,
                              convs: prev.convs.map((c) => c.id === active.id ? {
                                ...c,
                                transferred: true,
                                humanAgentActive: true,
                                remainingSeconds: 900,
                                humanAgentExpiresAt: res.expiresAt
                              } : c)
                            } : null);
                          } catch (e) {
                            console.error("فشل تفعيل Human Agent:", e);
                          }
                        }}
                        className="text-[10px] font-bold text-white bg-blue-600 hover:bg-blue-700 border border-blue-700 rounded-full px-2.5 py-1 inline-flex items-center gap-1 transition-colors"
                      >
                        <IconHandoff className="w-3 h-3" /> Human Agent
                      </button>
                    )}
                  </div>

                  <div className="flex-1 overflow-y-auto qa-scroll p-4 space-y-2.5 bg-[radial-gradient(700px_300px_at_50%_0%,rgba(46,194,126,0.05),transparent_70%)]" style={{ maxHeight: 400 }}>
                    {active.msgs.map((m) => (
                      <div key={m.id} className={`flex ${m.direction === "out" ? "justify-start" : "justify-end"} msg-in`}>
                        <div
                          className={`max-w-[78%] rounded-2xl px-3.5 py-2.5 shadow-sm transition-opacity duration-300 ${
                            m.direction === "out" ? "bg-wa-out rounded-bl-md" : "bg-wa-in rounded-br-md"
                          } ${m.status === "sending" ? "opacity-60" : ""}`}
                        >
                          <p className="text-[13px] leading-6 text-bone">{m.body}</p>
                          <p className="flex items-center justify-end gap-1.5 mt-1 text-[9.5px] text-sage/80">
                            {m.kind === "refusal" && <span className="text-oro-soft">بدون معلومة مؤكدة</span>}
                            {m.kind === "handoff" && <span className="text-oro-soft">تحويل</span>}
                            {m.direction === "out" && (
                              <>
                                <span className={`rounded-full px-1.5 py-px border text-[8.5px] font-bold ${m.is_auto ? "border-verde/50 text-verde" : "border-oro/50 text-oro-soft"}`}>
                                  {m.is_auto ? "آلي" : "أنت"}
                                </span>
                                {m.status === "sending" && <span className="text-xs">⏳</span>}
                                {m.status === "sent" && <span className="text-xs text-verde">✓</span>}
                                {m.status === "failed" && (
                                  <button onClick={() => retrySend(m)} className="text-red-400 hover:text-red-300 font-bold text-xs" title="إعادة المحاولة">
                                    ❌
                                  </button>
                                )}
                              </>
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
                    {active.humanAgentActive && (
                      <div className="mb-2.5 px-3 py-2 bg-amber-500/10 border border-amber-500/20 rounded-lg flex items-center justify-between gap-2">
                        <span className="text-[10px] font-bold text-amber-400 flex items-center gap-1.5">
                          <span>⚠️</span> Human Agent نشط — متبقٍ: {Math.floor((humanAgentCountdown[active.id] ?? 900) / 60)}:{String((humanAgentCountdown[active.id] ?? 900) % 60).padStart(2, '0')}
                        </span>
                      </div>
                    )}
                    {active.transferred && !active.humanAgentActive && (
                      <div className="mb-2.5 px-3 py-2 bg-amber-500/10 border border-amber-500/20 rounded-lg flex items-center justify-between gap-2">
                        <span className="text-[10px] font-bold text-amber-400 flex items-center gap-1.5">
                          <span>⚠️</span> الموظف الذكي يحتاج مساعدتك — يمكنك الرد مباشرة
                        </span>
                        <span className="text-[10px] text-amber-300 bg-amber-950/50 px-2 py-0.5 rounded">
                          بانتظار استلامك الرسمي
                        </span>
                      </div>
                    )}
                    {(active.transferred || active.paused) && !active.humanAgentActive && (
                      <label className="flex items-center gap-2.5 mb-2.5 text-[11.5px] text-sage cursor-pointer select-none">
                        <input type="checkbox" checked={resumeAuto} onChange={(e) => setResumeAuto(e.target.checked)} className="accent-[#2ec27e] w-4 h-4" />
                        استئناف الرد الآلي بعد إرسال هذا الرد
                      </label>
                    )}
                    <div className="relative group">
                      <textarea
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); replyManual(); } }}
                        rows={1}
                        disabled={!(active.humanAgentActive || active.transferred)}
                        placeholder={(active.humanAgentActive || active.transferred) ? "اكتب ردّك اليدوي…" : "اضغط Human Agent للرد يدويًا"}
                        className={`w-full min-h-[80px] max-h-[120px] p-3 rounded-xl text-sm resize-none outline-none transition-all duration-200 custom-scrollbar ${
                          (active.humanAgentActive || active.transferred)
                            ? 'bg-night/70 text-bone border border-verde/20 focus:border-oro/70 focus:ring-1 focus:ring-oro/20 placeholder:text-sage/40'
                            : 'bg-night/40 text-sage/60 border border-verde/10 cursor-not-allowed placeholder:text-sage/30'
                        }`}
                      />
                      
                      {!active.humanAgentActive && !active.transferred && !active.paused && (
                        <p className="text-[10.5px] text-sage text-center mt-2 flex items-center justify-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                          الرد الآلي يعمل حاليًا. اضغط Human Agent للتدخل.
                        </p>
                      )}
                      
                      {active.transferred && !active.humanAgentActive && (
                        <p className="text-[10.5px] text-amber-500/80 text-center mt-2">
                          المحادثة محوّلة — يمكنك الرد مباشرة أو استلام رسمي
                        </p>
                      )}

                      <button
                        onClick={replyManual}
                        disabled={sending || !draft.trim() || !(active.humanAgentActive || active.transferred)}
                        className={`absolute bottom-3 left-3 p-2 rounded-lg transition-all duration-200 ${
                          (active.humanAgentActive || active.transferred) && draft.trim()
                            ? 'bg-oro text-night hover:bg-oro/90 shadow-lg shadow-oro/20 translate-y-0 opacity-100'
                            : 'bg-night/50 text-sage/30 cursor-not-allowed translate-y-1 opacity-0'
                        }`}
                        aria-label="إرسال"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="22" y1="2" x2="11" y2="13"></line>
                          <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                        </svg>
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

        {/* ── Widgets ── */}
        {tab === "widgets" && (
          <div className="grid lg:grid-cols-[1fr_400px] gap-4 items-start">
            <section className={`${cls.card} overflow-hidden`}>
              <div className="px-5 py-4 border-b border-verde/10 flex items-center justify-between">
                <p className="text-sm font-bold text-bone inline-flex items-center gap-2">
                  <span className="text-lg">💬</span>
                  Widgets الخاصة بك
                </p>
                <span className="text-[11px] text-sage tabular-nums">{widgets.length} widget</span>
              </div>
              <ul className="divide-y divide-verde/8">
                {widgets.length === 0 && (
                  <li className="px-5 py-12 text-center text-xs text-sage/70">
                    لا widgets بعد — أنشئ أول widget من النموذج في الجهة الأخرى.
                  </li>
                )}
                {widgets.map((w) => (
                  <li key={w.id} className="px-5 py-4 group hover:bg-night/40 transition-colors duration-200">
                    <div className="flex items-start gap-3.5">
                      <div
                        className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold shrink-0"
                        style={{ background: w.primary_color }}
                      >
                        💬
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <p className="text-[14px] font-semibold text-bone truncate">{w.name}</p>
                          <span className={`text-[10px] font-bold rounded-full px-2 py-0.5 ${w.enabled ? "bg-verde/10 text-verde border border-verde/30" : "bg-oro/10 text-oro-soft border border-oro/30"}`}>
                            {w.enabled ? "مفعّل" : "معطّل"}
                          </span>
                        </div>
                        <p className="text-[11px] text-sage truncate mb-2" dir="ltr">
                          Token: {w.public_token}
                        </p>
                        <div className="flex gap-2 flex-wrap">
                          <button
                            onClick={() => setWidgetPreview(w)}
                            className="text-[11px] font-semibold text-verde hover:text-oro transition-colors"
                          >
                            معاينة
                          </button>
                          <button
                            onClick={() => copyEmbedCode(w.public_token)}
                            className="text-[11px] font-semibold text-verde hover:text-oro transition-colors"
                          >
                            {copiedCode === w.public_token ? "✓ تم النسخ" : "نسخ الكود"}
                          </button>
                          <button
                            onClick={() => toggleWidget(w.id, !w.enabled)}
                            className="text-[11px] font-semibold text-oro hover:text-bone transition-colors"
                          >
                            {w.enabled ? "تعطيل" : "تفعيل"}
                          </button>
                          <button
                            onClick={() => setEditingWidget(w.id)}
                            className="text-[11px] font-semibold text-sage hover:text-bone transition-colors"
                          >
                            تعديل
                          </button>
                          <button
                            onClick={() => deleteWidget(w.id)}
                            className="text-[11px] font-semibold text-red-400 hover:text-red-300 transition-colors"
                          >
                            حذف
                          </button>
                        </div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            <aside className={`${cls.card} p-5`}>
              <p className="text-sm font-bold text-bone mb-4">
                {editingWidget ? "تعديل Widget" : "إنشاء Widget جديد"}
              </p>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-sage mb-1.5">الاسم *</label>
                  <input
                    value={widgetForm.name}
                    onChange={(e) => setWidgetForm({ ...widgetForm, name: e.target.value })}
                    className={cls.input}
                    placeholder="مثال: Widget الموقع الرئيسي"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-sage mb-1.5">رسالة الترحيب</label>
                  <textarea
                    value={widgetForm.welcomeMessage}
                    onChange={(e) => setWidgetForm({ ...widgetForm, welcomeMessage: e.target.value })}
                    rows={2}
                    className={`${cls.input} resize-none`}
                    placeholder="مرحباً! كيف يمكنني مساعدتك؟"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-sage mb-1.5">اللون الأساسي</label>
                  <div className="flex gap-2">
                    <input
                      type="color"
                      value={widgetForm.primaryColor}
                      onChange={(e) => setWidgetForm({ ...widgetForm, primaryColor: e.target.value })}
                      className="w-12 h-10 rounded-lg border border-verde/20 cursor-pointer"
                    />
                    <input
                      type="text"
                      value={widgetForm.primaryColor}
                      onChange={(e) => setWidgetForm({ ...widgetForm, primaryColor: e.target.value })}
                      className={`${cls.input} flex-1`}
                      placeholder="#2ec27e"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-sage mb-1.5">الموقع</label>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setWidgetForm({ ...widgetForm, position: "left" })}
                      className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all ${widgetForm.position === "left" ? "bg-moss text-oro" : "bg-night/60 text-sage hover:text-bone"}`}
                    >
                      يسار
                    </button>
                    <button
                      onClick={() => setWidgetForm({ ...widgetForm, position: "right" })}
                      className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all ${widgetForm.position === "right" ? "bg-moss text-oro" : "bg-night/60 text-sage hover:text-bone"}`}
                    >
                      يمين
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-sage mb-1.5">Placeholder</label>
                  <input
                    value={widgetForm.placeholder}
                    onChange={(e) => setWidgetForm({ ...widgetForm, placeholder: e.target.value })}
                    className={cls.input}
                    placeholder="اكتب رسالتك..."
                  />
                </div>
                <button onClick={createWidget} className={`${cls.btn} w-full py-3`}>
                  {editingWidget ? "حفظ التعديلات" : "إنشاء Widget"}
                </button>
              </div>
            </aside>
          </div>
        )}
      </main>

      {/* ── Widget Preview Modal ── */}
      {widgetPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-night/80 backdrop-blur-sm" onClick={() => setWidgetPreview(null)}>
          <div className="relative w-full max-w-sm bg-pine border border-verde/25 rounded-3xl p-6 msg-in shadow-[0_40px_120px_-30px_rgba(0,0,0,0.9)]" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setWidgetPreview(null)} className="absolute top-4 left-4 text-sage hover:text-bone transition-colors" aria-label="إغلاق">
              <IconX className="w-5 h-5" />
            </button>
            <h3 className="font-display font-bold text-xl text-bone mb-4 text-center">معاينة Widget</h3>
            <div className="bg-bone rounded-2xl p-4 mb-4">
              <div className="bg-white rounded-xl shadow-lg overflow-hidden" style={{ height: "400px" }}>
                <div className="h-12 flex items-center gap-2 px-4 text-white" style={{ background: widgetPreview.primary_color }}>
                  <span className="text-lg">💬</span>
                  <div>
                    <p className="text-sm font-bold">{widgetPreview.name}</p>
                    <p className="text-[10px] opacity-90">{st?.businessName}</p>
                  </div>
                </div>
                <div className="flex-1 p-4 bg-gray-50" style={{ height: "calc(100% - 48px - 60px)" }}>
                  <div className="bg-white rounded-lg p-3 text-sm text-gray-800 shadow-sm">
                    {widgetPreview.welcome_message}
                  </div>
                </div>
                <div className="h-15 bg-white border-t border-gray-200 flex items-center gap-2 p-2">
                  <input className="flex-1 px-3 py-2 border border-gray-300 rounded-full text-sm" placeholder={widgetPreview.placeholder} readOnly />
                  <button className="w-9 h-9 rounded-full flex items-center justify-center text-white" style={{ background: widgetPreview.primary_color }}>
                    →
                  </button>
                </div>
              </div>
            </div>
            <div className="bg-night/60 border border-verde/15 rounded-xl p-3">
              <p className="text-[11px] text-sage mb-2">كود التضمين:</p>
              <code className="text-[10px] text-verde break-all" dir="ltr">
                {`<script src="${API}/widget.js" data-token="${widgetPreview.public_token}"></script>`}
              </code>
              <button
                onClick={() => copyEmbedCode(widgetPreview.public_token)}
                className="mt-2 text-[11px] font-bold text-oro hover:text-bone transition-colors"
              >
                {copiedCode === widgetPreview.public_token ? "✓ تم النسخ" : "نسخ الكود"}
              </button>
            </div>
          </div>
        </div>
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
