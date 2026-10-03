/**
 * لوحة تحكم إدارة ســوشـــيــــال — حقيقية عبر Supabase Auth + الخادم،
 * وبوضع عرض حيّ (بيانات محاكاة + سيناريو تلقائي) عندما لا تتوفر متغيرات البيئة.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import confetti from "canvas-confetti";
import { apiAuthFetch, apiEnabled, api, backendMode, API, type WaSnapshot } from "../lib/api";
import { getSupabase, getStoredClaim, clearStoredClaim } from "../lib/supabase";
import { CHANNELS, ChannelBadge, detectChannel, type ChannelId } from "../lib/channels";
import {
  IconWhatsapp, IconCheck, IconX, IconPlus, IconTrash, IconSend,
  IconLogout, IconRefresh, IconDatabase, IconCard, IconGlobe, IconMapPin,
  IconPen, IconQuestion, IconHandoff, IconLog, IconCoin, IconSparkle, IconChevronDown,
  IconFacebook, IconInstagram,
} from "../components/Icons";

/* ═══════════ أنواع القنوات ═══════════ */

type ChannelAccount = {
  id: string;
  channel: ChannelId;
  external_id: string;
  externalId?: string;
  display_name: string | null;
  displayName?: string | null;
  avatar_url: string | null;
  avatarUrl?: string | null;
  status: "active" | "needs_reauth" | "disconnected";
  agent_enabled: boolean;
  agentEnabled?: boolean;
  auto_reply: boolean;
  autoReply?: boolean;
  language: string | null;
  handoff_rules: Record<string, unknown> | null;
  handoffRules?: Record<string, unknown> | null;
  agent_config: Record<string, unknown> | null;
  agentConfig?: Record<string, unknown> | null;
  token_expires_at: string | null;
  tokenExpiresAt?: string | null;
  created_at: string;
  createdAt?: string;
  updated_at: string;
  updatedAt?: string;
};

type ChannelSummary = Record<ChannelId, { accounts: number; active: number; conversations: number }>;

type MetaStatus = {
  configured: boolean;
  appReviewNote?: string;
  developersUrl?: string;
};

const CHANNEL_STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  active: { text: "متصل", cls: "text-verde bg-verde/10 border-verde/30" },
  needs_reauth: { text: "يحتاج إعادة تفويض", cls: "text-oro-soft bg-oro/10 border-oro/30" },
  disconnected: { text: "غير متصل", cls: "text-sage bg-moss border-verde/20" },
};

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
  customerAvatar?: string | null;
  channel?: "whatsapp" | "instagram" | "facebook";
  accountId?: string | null;
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
  loadingList?: boolean;
};

/* ═══════════════ أدوات ═══════════════ */

const LOGO_URL = `${import.meta.env.BASE_URL}logo.png`;

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" });
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("ar", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

const normalizeDirection = (d: string | null | undefined): "in" | "out" =>
  d === "out" || d === "outbound" ? "out" : "in";

const extractBody = (row: any): string => {
  if (!row) return "";
  if (typeof row.body === "string" && row.body.length > 0) return row.body;
  return "";
};

const ChannelIcon = ({ channel, className = "w-4.5 h-4.5" }: { channel?: ChannelId; className?: string }) => {
  if (channel === "instagram") return <IconInstagram className={className} />;
  if (channel === "facebook") return <IconFacebook className={className} />;
  return <IconWhatsapp className={className} />;
};

/**
 * تطبيع بيانات الحساب: نحوّل camelCase (من الـ API) إلى snake_case
 * (الذي يقرأه باقي الكود). هذا يضمن عمل كل الحقول في الواجهة.
 */
const normalizeChannelAccount = (a: any): ChannelAccount => ({
  ...a,
  external_id: a.external_id ?? a.externalId ?? "",
  externalId: a.externalId ?? a.external_id ?? "",
  display_name: a.display_name ?? a.displayName ?? null,
  displayName: a.displayName ?? a.display_name ?? null,
  avatar_url: a.avatar_url ?? a.avatarUrl ?? null,
  avatarUrl: a.avatarUrl ?? a.avatar_url ?? null,
  agent_enabled: a.agent_enabled ?? a.agentEnabled ?? true,
  agentEnabled: a.agentEnabled ?? a.agent_enabled ?? true,
  auto_reply: a.auto_reply ?? a.autoReply ?? true,
  autoReply: a.autoReply ?? a.auto_reply ?? true,
  handoff_rules: a.handoff_rules ?? a.handoffRules ?? {},
  handoffRules: a.handoffRules ?? a.handoff_rules ?? {},
  agent_config: a.agent_config ?? a.agentConfig ?? {},
  agentConfig: a.agentConfig ?? a.agent_config ?? {},
  token_expires_at: a.token_expires_at ?? a.tokenExpiresAt ?? null,
  tokenExpiresAt: a.tokenExpiresAt ?? a.token_expires_at ?? null,
  created_at: a.created_at ?? a.createdAt ?? "",
  createdAt: a.createdAt ?? a.created_at ?? "",
  updated_at: a.updated_at ?? a.updatedAt ?? "",
  updatedAt: a.updatedAt ?? a.updated_at ?? "",
});

const cls = {
  card: "bg-pine/70 border border-verde/15 rounded-2xl",
  input:
    "w-full bg-night/70 border border-verde/20 rounded-xl px-4 py-2.5 text-sm text-bone placeholder:text-sage/45 focus:outline-none focus:border-oro/70 focus:ring-2 focus:ring-oro/20 transition-all duration-300",
  btn: "inline-flex items-center justify-center gap-2 bg-verde text-ink font-display font-bold text-sm px-5 py-2.5 rounded-xl hover:bg-oro transition-all duration-300 active:scale-[0.97] disabled:opacity-50",
  btnGhost:
    "inline-flex items-center justify-center gap-2 border border-verde/25 text-mist font-semibold text-sm px-4 py-2.5 rounded-xl hover:border-oro/60 hover:text-oro transition-all duration-300 active:scale-[0.97]",
};

const now = () => new Date().toISOString();

/* ═══════════════ المكوّن الرئيسي ═══════════════ */

export default function Dashboard() {
  const sb = useMemo(() => getSupabase(), []);
  const demo = sb === null;

  const [authed, setAuthed] = useState(demo ? false : true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authMode, setAuthMode] = useState<"login" | "signup">("login");
  const [authBusy, setAuthBusy] = useState(false);
  const [authErr, setAuthErr] = useState("");
  const [authNote, setAuthNote] = useState("");
  const [token, setToken] = useState<string | null>(null);

  const [st, setSt] = useState<DashState | null>(null);
  const [needClaim, setNeedClaim] = useState(false);
  const [claimVal, setClaimVal] = useState("");
  const [claimErr, setClaimErr] = useState("");
  const [claimBusy, setClaimBusy] = useState(false);

  const [tab, setTab] = useState<"convs" | "unresolved" | "knowledge" | "widgets" | "channels">("convs");
  const [socialChannels, setSocialChannels] = useState<any[]>([]);
  const [activeConv, setActiveConv] = useState<string | null>(null);
  const [mobileThread, setMobileThread] = useState(false);
  const [draft, setDraft] = useState("");
  const [resumeAuto, setResumeAuto] = useState(true);
  const [sending, setSending] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [answers, setAnswers] = useState<Record<string, { text: string; save: boolean }>>({});
  const [newSource, setNewSource] = useState<{ kind: "url" | "text"; url: string; text: string }>({ kind: "url", url: "", text: "" });

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

  const [humanAgentCountdown, setHumanAgentCountdown] = useState<Record<string, number>>({});

  const [chAccounts, setChAccounts] = useState<ChannelAccount[]>([]);
  const [chSummary, setChSummary] = useState<ChannelSummary | null>(null);
  const [metaStatus, setMetaStatus] = useState<MetaStatus | null>(null);
  const [chLoading, setChLoading] = useState(false);
  const [chBusyId, setChBusyId] = useState<string | null>(null);
  const [chBusyPlatform, setChBusyPlatform] = useState<string | null>(null);
  const [manageAcc, setManageAcc] = useState<ChannelAccount | null>(null);
  const [handoffCfg, setHandoffCfg] = useState({ onRequest: true, onNoAnswer: true, keywords: "" });
  const [convFilter, setConvFilter] = useState<"all" | ChannelId>("all");
  const [waConnectedAt, setWaConnectedAt] = useState<string | null>(null);

  const threadEndRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<number | null>(null);

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
          return {};
        }

        return hasChanged ? next : prev;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [token]);

  /* ── جلسة Supabase ── */
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

  /* ── دخول/تسجيل ── */
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

  /* ── تحميل البيانات ── */
  const loadAll = useCallback(async (skipConvs = false) => {
    if (!token) return;
    try {
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
        loadingList: !skipConvs && (!prev || prev.convs.length === 0),
      }));

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
                  phone: c.customerPhone || "",
                  customerName: c.customerName || null,
                  channel: ["whatsapp", "instagram", "facebook"].includes(c.channel) ? c.channel : undefined,
                  accountId: c.accountId ?? null,
                  customerAvatar: c.customerAvatar || null,
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
              loadingList: false,
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

  useEffect(() => {
    if (demo || !authed || !token) {
      setSt(null);
      return;
    }
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, authed, token]);

  /* ═══════════════════════════════════════════════════════════
   *  قناة Realtime موحّدة (محادثات + رسائل)
   * ═══════════════════════════════════════════════════════════ */
  useEffect(() => {
    if (demo || !token || needClaim || !sb) return;

    const handleConvInsert = (payload: any) => {
      const row = payload.new ?? {};
      setSt((prev) => {
        if (!prev) return prev;
        if (prev.convs.some((c) => c.id === row.id)) return prev;
        queueMicrotask(() => loadAll(false).catch(() => {}));
        return prev;
      });
    };

    const handleConvUpdate = (payload: any) => {
      const row = payload.new ?? {};

      setSt((prev) => {
        if (!prev) return prev;
        const prevConv = prev.convs.find((c) => c.id === row.id);
        const wasTransferred = prevConv?.transferred ?? false;
        const nowTransferred = Boolean(row.transferred);
        const isAutoTransfer =
          row.auto_paused_reason === "ai_handoff" ||
          row.auto_paused_reason === "no_answer" ||
          row.auto_paused_reason === "low_confidence" ||
          row.human_agent_activated_by === null;

        if (!wasTransferred && nowTransferred && isAutoTransfer) {
          queueMicrotask(() => {
            showToast("🔔 محادثة تحتاج تدخلك — الموظف الذكي لم يجد إجابة مؤكدة");
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

    const handleMessageInsert = (payload: any) => {
      const row = payload.new ?? {};
      const convId: string = row.conversation_id;
      if (!convId) return;

      const direction = normalizeDirection(row.direction);
      const isActive = activeConvRef.current === convId;

      setSt((prev) => {
        if (!prev) return prev;
        const target = prev.convs.find((c) => c.id === convId);

        if (!target) {
          queueMicrotask(() => loadAll(false).catch(() => {}));
          return prev;
        }

        const updatedConv: ConvItem = {
          ...target,
          lastAt: row.created_at ?? now(),
          lastMessagePreview: target.lastMessagePreview || "…",
          unreadCount:
            isActive || direction === "out"
              ? (target.unreadCount ?? 0)
              : (target.unreadCount ?? 0) + 1,
          msgs: target.msgs,
        };

        const others = prev.convs.filter((c) => c.id !== convId);
        return { ...prev, convs: [updatedConv, ...others] };
      });

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
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "conversations" }, handleConvInsert)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "conversations" }, handleConvUpdate)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, handleMessageInsert)
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR") {
          console.warn("[Realtime] channel error — check RLS / publication");
        }
      });

    return () => {
      sb.removeChannel(channel);
    };
  }, [demo, token, needClaim, sb]);

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

  const activeThread = st?.convs.find((c) => c.id === activeConv) ?? null;
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [activeThread?.msgs.length]);

  /* ═══════════ القنوات ═══════════ */

  /**
   * ⚡ الإصلاح الجوهري:
   * الـ API يُرجع الحقول بصيغة camelCase (displayName, avatarUrl, externalId...)
   * لكن كل الكود يقرأ snake_case (display_name, avatar_url, external_id...).
   * الحل: نُطبّع كل حساب عند التحميل، فيصبح متاحًا بالصيغتين.
   */
  const loadChannels = useCallback(async () => {
    if (!token || demo) return;
    setChLoading(true);
    try {
      const [accounts, summary] = await Promise.all([
        apiAuthFetch<any[]>(token, "/api/channels/accounts"),
        apiAuthFetch<ChannelSummary>(token, "/api/channels/summary"),
      ]);

      // التطبيع: camelCase → snake_case
      const normalized: ChannelAccount[] = (accounts ?? []).map(normalizeChannelAccount);

      setChAccounts(normalized);
      setChSummary(summary ?? null);
    } catch (e) {
      console.error("[Dashboard] channels load error:", e);
    } finally {
      setChLoading(false);
    }
  }, [token, demo]);

  useEffect(() => {
    if (demo || !authed || !token || needClaim) return;
    loadChannels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, authed, token, needClaim]);

  useEffect(() => {
    if (demo || !apiEnabled) return;
    apiAuthFetch<MetaStatus>(token!, "/api/channels/meta/status").then(setMetaStatus).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, token]);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("tab") === "channels") setTab("channels");
    const connected = q.get("channel_connected");
    if (connected) {
      const name = q.get("name");
      showToast(
        `تم ربط ${connected === "facebook" ? "Facebook Messenger" : "Instagram"} بنجاح ✅${name ? ` (${name})` : ""}`
      );
      if (q.get("note") === "personal_account") {
        setTimeout(() => showToast("تنبيه: الحساب شخصي — حوّله إلى احترافي/أعمال لتفعيل استقبال الرسائل والرد الآلي"), 1200);
      }
      loadChannels();
      loadSocialChannels();
      window.history.replaceState({}, "", "#/dashboard");
    }
    const chErr = q.get("channel_error");
    if (chErr) {
      const map: Record<string, string> = {
        user_cancelled: "تم إلغاء الربط — لم تُمنح صلاحيات Meta.",
        missing_params: "لم تكتمل بيانات العودة من Meta — أعد المحاولة.",
        oauth_state: "انتهت صلاحية جلسة الربط — ابدأ الربط من جديد.",
        "oauth_state:state_signature": "تعذر التحقق من جلسة الربط — أعد الضغط على «ربط Instagram».",
        "oauth_state:state_expired": "انتهت صلاحية جلسة الربط (أكثر من 15 دقيقة).",
        "oauth_state:state_reused": "تم استخدام جلسة الربط مسبقًا — أعد المحاولة.",
        oauth_token_exchange: "رفضت Meta تبادل الرمز — تحقق من مطابقة Valid OAuth Redirect URI.",
        config_redirect_uri: "إعداد PUBLIC_URL على الخادم غير صحيح.",
      };
      const decoded = decodeURIComponent(chErr);
      showToast("فشل الربط: " + (map[decoded] ?? decoded));
      window.history.replaceState({}, "", "#/dashboard");
    }
    if (q.get("connected") === "1") {
      const fb = Number(q.get("fb") ?? 0);
      const ig = Number(q.get("ig") ?? 0);
      showToast(
        fb + ig > 0
          ? `تم ربط ${fb > 0 ? `${fb} صفحة Facebook` : ""}${fb > 0 && ig > 0 ? " و" : ""}${ig > 0 ? `${ig} حساب Instagram` : ""} بنجاح ✅`
          : "اكتمل تسجيل الدخول عبر Meta — لم يُعثر على صفحات أو حسابات إنستغرام مؤهلة."
      );
      loadChannels();
      window.history.replaceState({}, "", "#/dashboard");
    }
    const err = q.get("error");
    if (err) {
      const map: Record<string, string> = {
        oauth_missing: "لم يكتمل تفويض Meta — أعد المحاولة.",
        oauth_state: "انتهت صلاحية جلسة الربط — ابدأ الربط من جديد.",
        oauth_channel: "قناة غير معروفة في طلب الربط.",
        oauth_not_configured: "تطبيق Meta غير مُهيّأ على الخادم بعد.",
        oauth_token: "رفضت Meta تبادل الرمز — أعد المحاولة.",
        oauth_failed: "حدث خطأ أثناء إتمام الربط.",
      };
      showToast(map[err] ?? "تعذر إتمام ربط Meta.");
      window.history.replaceState({}, "", "#/dashboard");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadSocialChannels = useCallback(async () => {
    if (!token || demo) return;
    try {
      const data = await apiAuthFetch<any[]>(
        token,
        `/api/dashboard/channels?tenantId=${encodeURIComponent(st?.tenantId ?? "")}`
      );
      setSocialChannels(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error("[Dashboard] social channels load error:", e);
    }
  }, [token, demo, st?.tenantId]);

  useEffect(() => {
    if (tab === "channels") loadSocialChannels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const handleConnectChannel = async (platform: "whatsapp" | "facebook" | "instagram") => {
    if (!token) return;
    if (platform === "whatsapp") {
      showToast("واتساب يُدار من بطاقة الاتصال في «نظرة عامة» — WhatsApp Cloud API");
      return;
    }
    try {
      await apiAuthFetch(token, "/api/dashboard/channels/connect", {
        method: "POST",
        body: JSON.stringify({ platform, tenantId: st?.tenantId }),
      });
    } catch {
      /* تجاهل */
    }
    startMetaOAuth(platform);
  };

  const startMetaOAuth = async (channel: "facebook" | "instagram") => {
    if (!token) return;
    setChBusyPlatform(channel);
    try {
      let r: { url: string };
      try {
        r = await apiAuthFetch<{ url: string }>(token, "/api/auth/facebook/start", {
          method: "POST",
          body: JSON.stringify({ platform: channel, tenantId: st?.tenantId }),
        });
      } catch {
        r = await apiAuthFetch<{ url: string }>(
          token,
          `/api/channels/meta/oauth-url?channel=${channel}`
        );
      }
      if (r?.url) window.location.href = r.url;
      else showToast("لم يُرجع الخادم رابط OAuth — تأكد من ضبط META_APP_ID/META_APP_SECRET");
    } catch (e: any) {
      const msg = String(e?.message ?? "");
      showToast(
        msg.includes("oauth_not_configured") || msg.includes("غير مُهيّأ")
          ? "تطبيق Meta غير مُهيّأ على الخادم بعد"
          : msg || "تعذر بدء ربط Meta"
      );
      setChBusyPlatform(null);
    }
  };

  const disconnectSocialChannel = async (platform: "facebook" | "instagram") => {
    if (!token || !st?.tenantId) return;
    if (!window.confirm(`فصل ${platform === "facebook" ? "Facebook Messenger" : "Instagram"}؟ ستوقف الرسائل الواردة لهذه القناة حتى إعادة الربط.`)) return;
    try {
      await apiAuthFetch(token, "/api/auth/disconnect", {
        method: "POST",
        body: JSON.stringify({ platform, tenantId: st.tenantId }),
      });
      showToast("تم فصل القناة");
      loadSocialChannels();
      loadChannels();
    } catch (e: any) {
      showToast(e?.message || "تعذر الفصل");
    }
  };

  const patchAccount = async (id: string, patch: Partial<ChannelAccount>) => {
    if (!token) return;
    setChBusyId(id);
    try {
      const updated = await apiAuthFetch<any>(token, `/api/channels/accounts/${id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      setChAccounts((prev) => prev.map((a) => (a.id === id ? { ...a, ...normalizeChannelAccount(updated) } : a)));
      showToast("تم حفظ الإعدادات");
    } catch (e: any) {
      showToast(e?.message ?? "فشل الحفظ");
    } finally {
      setChBusyId(null);
    }
  };

  const disconnectAccount = async (acc: ChannelAccount) => {
    if (!token) return;
    if (!window.confirm(`فصل ${acc.display_name ?? acc.external_id}؟ ستوقف الرسائل الواردة لهذه القناة حتى إعادة الربط.`)) return;
    setChBusyId(acc.id);
    try {
      await apiAuthFetch(token, `/api/channels/accounts/${acc.id}`, { method: "DELETE" });
      showToast("تم فصل الحساب");
      setManageAcc(null);
      loadChannels();
    } catch (e: any) {
      showToast(e?.message ?? "فشل الفصل");
    } finally {
      setChBusyId(null);
    }
  };

  const openManageAccount = (acc: ChannelAccount) => {
    setManageAcc(acc);
    const hr = (acc.handoff_rules ?? {}) as Record<string, unknown>;
    setHandoffCfg({
      onRequest: hr.onRequest !== false,
      onNoAnswer: hr.onNoAnswer !== false,
      keywords: Array.isArray(hr.keywords) ? (hr.keywords as string[]).join("، ") : "",
    });
  };

  const saveHandoffRules = async () => {
    if (!manageAcc || !token) return;
    await patchAccount(manageAcc.id, {
      handoff_rules: {
        onRequest: handoffCfg.onRequest,
        onNoAnswer: handoffCfg.onNoAnswer,
        keywords: handoffCfg.keywords.split(/[،,]/).map((s) => s.trim()).filter(Boolean),
      } as any,
    });
  };

  const openConversation = (convId: string) => {
    setActiveConv(convId);
    setMobileThread(true);
    setSt((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        convs: prev.convs.map((c) => c.id === convId ? { ...c, unreadCount: 0 } : c),
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
      const result: any = await apiAuthFetch<any>(
        token!,
        `/api/dashboard/conversations/${activeConv}/reply`,
        { method: "POST", body: JSON.stringify({ text: outgoing, resumeAuto }) }
      );

      const realId = result?.id ?? result?.message?.id ?? tempId;
      const realBody = result?.body ?? result?.message?.body ?? outgoing;

      setSt((prev) => {
        if (!prev) return prev;
        const target = prev.convs.find((c) => c.id === activeConv);
        if (!target) return prev;
        const newMsgs = target.msgs.map(m =>
          m.id === tempId ? { ...m, id: realId, body: realBody, status: "sent" as const } : m
        );
        const updatedConv = { ...target, msgs: newMsgs };
        const others = prev.convs.filter((c) => c.id !== activeConv);
        return { ...prev, convs: [updatedConv, ...others] };
      });
      showToast("أُرسل الرد للعميل");
    } catch (e: any) {
      showToast(e?.message ?? "تعذر الإرسال");
    }
  };

  const retrySend = async (msg: ThreadMsg) => {
    if (msg.status !== "failed" || !activeConv) return;
    try {
      await apiAuthFetch(token!, `/api/dashboard/conversations/${activeConv}/reply`, {
        method: "POST",
        body: JSON.stringify({ text: msg.body, resumeAuto: false }),
      });
      setSt((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          convs: prev.convs.map((c) =>
            c.id === activeConv
              ? { ...c, msgs: c.msgs.map(m => m.id === msg.id ? { ...m, status: "sent" as const } : m) }
              : c
          ),
        };
      });
    } catch {
      showToast("فشل الإرسال مجددًا");
    }
  };

  const resolveOne = async (item: UnresolvedItem) => {
    const a = answers[item.id]?.text.trim();
    const save = answers[item.id]?.save ?? true;
    if (!a) { showToast("اكتب الإجابة أولاً"); return; }
    try {
      await apiAuthFetch(token!, `/api/dashboard/unresolved/${item.id}/resolve`, {
        method: "POST",
        body: JSON.stringify({ answer: a, saveToKb: save, sendToCustomer: Boolean(item.conversationId) }),
      });
      loadAll();
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
    try {
      await apiAuthFetch(token!, `/api/dashboard/knowledge/${id}`, { method: "DELETE" });
      loadAll();
      showToast("حُذف المصدر");
    } catch {
      showToast("تعذر الحذف");
    }
  };

  const recharge = async (pkgId: string) => {
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

  /* ═══════════ Widgets ═══════════ */

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
    if (!demo && token) loadWidgets();
  }, [demo, token, loadWidgets]);

  const createWidget = async () => {
    if (!widgetForm.name.trim()) { showToast("أدخل اسم الـ widget"); return; }
    try {
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
    } catch (e: any) {
      showToast(e?.message || "تعذر إنشاء الـ widget");
    }
  };

  const updateWidget = async (id: string, updates: any) => {
    try {
      const updated = await apiAuthFetch(token!, `/api/widgets/dashboard/${id}`, {
        method: "PUT",
        body: JSON.stringify(updates),
      });
      setWidgets(widgets.map(w => w.id === id ? updated : w));
      showToast("تم تحديث الـ widget");
      setEditingWidget(null);
    } catch (e: any) {
      showToast(e?.message || "تعذر تحديث الـ widget");
    }
  };

  const deleteWidget = async (id: string) => {
    if (!confirm("هل أنت متأكد من حذف هذا الـ widget؟")) return;
    try {
      await apiAuthFetch(token!, `/api/widgets/dashboard/${id}`, { method: "DELETE" });
      setWidgets(widgets.filter(w => w.id !== id));
      showToast("تم حذف الـ widget");
    } catch (e: any) {
      showToast(e?.message || "تعذر حذف الـ widget");
    }
  };

  const toggleWidget = async (id: string, enabled: boolean) => {
    try {
      await apiAuthFetch(token!, `/api/widgets/dashboard/${id}`, {
        method: "PUT",
        body: JSON.stringify({ enabled }),
      });
      setWidgets(widgets.map(w => w.id === id ? { ...w, enabled } : w));
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
