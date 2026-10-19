/**
 * لوحة تحكم إدارة ســوشـــيــــال — حقيقية عبر Supabase Auth + الخادم.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import confetti from "canvas-confetti";
import { apiAuthFetch, apiBase, backendMode, type WaSnapshot } from "../lib/api";
import { getSupabase, getStoredClaim, clearStoredClaim } from "../lib/supabase";
import { CHANNELS, ChannelBadge, detectChannel, type ChannelId } from "../lib/channels";
import {
  IconWhatsapp, IconCheck, IconX, IconPlus, IconTrash, IconSend,
  IconLogout, IconRefresh, IconDatabase, IconCard, IconGlobe, IconMapPin,
  IconPen, IconQuestion, IconHandoff, IconLog, IconCoin, IconSparkle, IconChevronDown,
  IconFacebook, IconInstagram,
} from "../components/Icons";

/* ═══════════ الأنواع ═══════════ */

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

/* ═══════════ أدوات ═══════════ */

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

/* ═══════════ المكوّن الرئيسي ═══════════ */

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
  const [agentPrompt, setAgentPrompt] = useState<string>("");
  const [agentPromptSaving, setAgentPromptSaving] = useState(false);

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
                showToast("انتهت مدة Human Agent");
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
        if (!data.session) setAuthNote("تم إنشاء الحساب — فعّله من بريدك.");
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
      .catch(() => {
        // إذا كان الرمز غير صالح (404)، احذفه لتجنب تكرار المحاولة
        clearStoredClaim();
      })
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

  useEffect(() => {
    if (demo || !token) return;
    apiAuthFetch<{ prompt: string | null }>(token, "/api/dashboard/agent-prompt")
      .then((r) => setAgentPrompt(r.prompt ?? ""))
      .catch(() => {});
  }, [demo, token]);

  /* ── Realtime ── */
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
              // ✅ تحديث الاسم والصورة عند وصولهما من الـ webhook
              customerName: row.customer_name ?? c.customerName,
              customerAvatar: row.customer_avatar ?? c.customerAvatar,
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
          loadThread(convId).catch((err) => console.error("فشل جلب الرسائل:", err));
        });
      }
    };

    const channel = sb
      .channel("dashboard-realtime")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "conversations" }, handleConvInsert)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "conversations" }, handleConvUpdate)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, handleMessageInsert)
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR") console.warn("[Realtime] channel error");
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

  const loadChannels = useCallback(async () => {
    if (!token || demo) return;
    setChLoading(true);
    try {
      const [accounts, summary] = await Promise.all([
        apiAuthFetch<any[]>(token, "/api/channels/accounts"),
        apiAuthFetch<ChannelSummary>(token, "/api/channels/summary"),
      ]);

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
    if (demo || backendMode !== "supabase") return;
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
        "oauth_state:state_signature": "تعذر التحقق من جلسة الربط — أعد المحاولة.",
        "oauth_state:state_expired": "انتهت صلاحية جلسة الربط.",
        "oauth_state:state_reused": "تم استخدام جلسة الربط مسبقًا.",
        oauth_token_exchange: "رفضت Meta تبادل الرمز — تحقق من Valid OAuth Redirect URI.",
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
          : "اكتمل تسجيل الدخول عبر Meta — لم يُعثر على حسابات مؤهلة."
      );
      loadChannels();
      window.history.replaceState({}, "", "#/dashboard");
    }
    const err = q.get("error");
    if (err) {
      const map: Record<string, string> = {
        oauth_missing: "لم يكتمل تفويض Meta.",
        oauth_state: "انتهت صلاحية جلسة الربط.",
        oauth_channel: "قناة غير معروفة.",
        oauth_not_configured: "تطبيق Meta غير مُهيّأ.",
        oauth_token: "رفضت Meta تبادل الرمز.",
        oauth_failed: "حدث خطأ أثناء الربط.",
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
      showToast("واتساب يُدار من بطاقة الاتصال في «نظرة عامة»");
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
      // مصدر واحد وحيد: دالة channels على Supabase Edge Functions (خادم Railway أُغلق)
      const r = await apiAuthFetch<{ url: string }>(
        token,
        `/api/channels/meta/oauth-url?channel=${channel}&tenantId=${encodeURIComponent(st?.tenantId ?? "")}`
      );
      if (r?.url) window.location.href = r.url;
      else showToast("لم يُرجع الخادم رابط OAuth");
    } catch (e: any) {
      showToast(String(e?.message ?? "") || "تعذر بدء ربط Meta");
      setChBusyPlatform(null);
    }
  };

  const disconnectSocialChannel = async (platform: "facebook" | "instagram") => {
    if (!token || !st?.tenantId) return;
    if (!window.confirm(`فصل ${platform === "facebook" ? "Facebook" : "Instagram"}؟`)) return;
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
    if (!window.confirm(`فصل ${acc.display_name ?? acc.external_id}؟`)) return;
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

  const saveAgentPrompt = async () => {
    if (!token) return;
    setAgentPromptSaving(true);
    try {
      await apiAuthFetch(token, "/api/dashboard/agent-prompt", {
        method: "POST",
        body: JSON.stringify({ prompt: agentPrompt }),
      });
      showToast("تم حفظ رسالة التوجيه");
    } catch (e: any) {
      showToast(e?.message ?? "تعذر الحفظ");
    } finally {
      setAgentPromptSaving(false);
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
      showToast("فُتحت صفحة الدفع");
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

  /* ── Widgets ── */
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

  /* ═══════════ شاشات ما قبل اللوحة ═══════════ */

  if (!authed) {
    return (
      <Shell>
        <div className="max-w-5xl mx-auto px-5 pt-16 pb-20">
          <div className="grid lg:grid-cols-[1.1fr_1fr] gap-8 items-stretch">
            <div className={`${cls.card} p-8 lg:p-10 flex flex-col justify-between overflow-hidden relative`}>
              <div className="absolute -top-20 -left-20 w-64 h-64 rounded-full bg-verde/10 blur-3xl" aria-hidden="true" />
              <div>
                <span className="inline-flex items-center gap-2 text-verde mb-6">
                  <img src={LOGO_URL} alt="" className="w-11 h-11 rounded-full object-cover" />
                  <span className="font-display font-bold text-3xl text-bone">
                    إدارة ســوشـــيــــال<span className="text-oro">.</span>
                  </span>
                </span>
                <h1 className="font-display font-bold text-3xl lg:text-4xl leading-snug text-bone mb-5">
                  غرفة عمليات<span className="text-oro"> موظفك الآلي</span>
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
            </div>

            <div className={`${cls.card} p-8`}>
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
                <p className="text-xs text-sage mb-6">عبر Supabase Auth</p>
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
            </div>
          </div>
        </div>
      </Shell>
    );
  }

  if (!demo && needClaim && !st) {
    return (
      <Shell>
        <div className="max-w-xl mx-auto px-5 pt-24 pb-20">
          <div className={`${cls.card} p-8`}>
            <h2 className="font-display font-bold text-2xl text-bone mb-2">اربط حسابك بمشروعك</h2>
            <p className="text-sm text-sage leading-6 mb-6">الصق رمز الضم الذي ظهر لك.</p>
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
            <button onClick={logout} className="mt-4 w-full text-xs text-sage hover:text-oro underline underline-offset-4">
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
            {backendMode === "supabase" ? "جارٍ تحميل لوحتك…" : "تجهيز بيانات العرض…"}
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
    { id: "channels" as const, label: "القنوات", icon: <IconGlobe className="w-4 h-4" /> },
  ];

  const waLive = st.waStatus === "connected" || !!st.phone;
  const fbAccounts = chAccounts.filter((a) => a.channel === "facebook");
  const igAccounts = chAccounts.filter((a) => a.channel === "instagram");

  return (
    <Shell>
      <header className="sticky top-0 z-40 bg-night/85 backdrop-blur-md border-b border-verde/12">
        <div className="max-w-6xl mx-auto px-5 h-16 flex items-center justify-between gap-3">
          <a href="#top" className="flex items-center gap-2 group shrink-0">
            <img src={LOGO_URL} alt="" className="w-8 h-8 rounded-full object-cover" />
            <span className="font-display font-bold text-xl text-bone hidden sm:block">
              إدارة ســوشـــيــــال<span className="text-oro">.</span>
            </span>
          </a>
          <div className="flex items-center gap-2.5">
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
                  <IconWhatsapp className="w-4 h-4" /> متصل عبر Cloud API
                </span>
              ) : (
                <span className="text-xs text-oro font-semibold flex items-center gap-1">
                  <IconWhatsapp className="w-4 h-4" /> تحقق من إعدادات Cloud API
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

        <div className="relative bg-pine/50 border border-verde/12 rounded-2xl p-1.5 grid grid-cols-5 mb-6 max-w-2xl">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-[13px] font-bold transition-colors duration-300 ${
                tab === t.id ? "text-oro bg-moss" : "text-sage hover:text-bone"
              }`}
            >
              {t.icon}{t.label}
              {t.badge ? (
                <span className="min-w-5 h-5 px-1 rounded-full bg-oro text-ink text-[10.5px] font-bold flex items-center justify-center tabular-nums">
                  {t.badge}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        {tab === "convs" && (
          <div className="grid lg:grid-cols-[320px_1fr] gap-4 items-start">
            <aside className={`${cls.card} overflow-hidden ${mobileThread ? "hidden lg:block" : ""}`}>
              <div className="px-4 py-3.5 border-b border-verde/10 flex items-center justify-between">
                <p className="text-xs font-bold text-sage">صندوق المحادثات الموحد</p>
                <span className="w-2 h-2 rounded-full bg-verde live-dot" />
              </div>
              <div className="px-3 py-2.5 border-b border-verde/8 flex gap-1.5 flex-wrap">
                {([["all", "الكل"], ["whatsapp", "واتساب"], ["instagram", "إنستغرام"], ["facebook", "فيسبوك"]] as const).map(([id, label]) => (
                  <button
                    key={id}
                    onClick={() => setConvFilter(id)}
                    className={`text-[10.5px] font-bold px-2.5 py-1 rounded-full border transition-all ${
                      convFilter === id ? "bg-moss text-oro border-oro/40" : "text-sage border-verde/15 hover:text-bone"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <ul className="max-h-[520px] overflow-y-auto qa-scroll">
                {st.loadingList ? (
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
                ) : st.convs.filter((c) => convFilter === "all" || (c.channel ?? "whatsapp") === convFilter).length === 0 ? (
                  <li className="px-5 py-10 text-center text-xs text-sage/70 leading-6">
                    لا محادثات بعد — اربط قناة من تبويب «القنوات».
                  </li>
                ) : st.convs.filter((c) => convFilter === "all" || (c.channel ?? "whatsapp") === convFilter).map((c) => {
                  const sel = c.id === activeConv;
                  const ch = (c.channel ?? "whatsapp") as ChannelId;
                  const displayName = c.customerName || c.phone || "—";
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
                        <div className="flex items-start gap-3">
                          {c.customerAvatar ? (
                            <img src={c.customerAvatar} alt="" className="w-11 h-11 rounded-full object-cover border border-verde/25 shrink-0 bg-moss" referrerPolicy="no-referrer" loading="lazy" />
                          ) : (
                            <span className="w-11 h-11 rounded-full bg-moss border border-verde/25 text-verde flex items-center justify-center shrink-0">
                              <ChannelIcon channel={ch} className="w-5 h-5" />
                            </span>
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2 mb-0.5">
                              <span className="text-[13px] font-bold text-bone truncate">{displayName}</span>
                              <span className="text-[10px] text-sage tabular-nums shrink-0">{fmtTime(c.lastAt)}</span>
                            </div>
                            <p className="text-[11.5px] text-sage truncate">
                              {c.lastMessagePreview ?? c.msgs[c.msgs.length - 1]?.body ?? "—"}
                            </p>
                            <div className="flex gap-1.5 mt-1.5 flex-wrap items-center">
                              <ChannelBadge channel={ch} />
                              {c.transferred && (
                                <span className="text-[9.5px] font-bold text-oro-soft bg-oro/10 border border-oro/30 rounded-full px-2 py-0.5 inline-flex items-center gap-1">
                                  <IconHandoff className="w-3 h-3" /> محوّلة لبشري
                                </span>
                              )}
                              {typeof c.unreadCount === "number" && c.unreadCount > 0 && !sel && (
                                <span className="text-[9.5px] font-bold text-white bg-verde rounded-full px-2 py-0.5 inline-flex items-center gap-1">
                                  {c.unreadCount} جديدة
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </aside>

            <section className={`${cls.card} overflow-hidden ${!mobileThread && !active ? "hidden lg:flex" : "flex"} flex-col`} style={{ minHeight: 460 }}>
              {!active ? (
                <div className="flex-1 flex flex-col items-center justify-center text-center p-10 gap-3">
                  <span className="text-verde/50"><IconLog className="w-10 h-10" /></span>
                  <p className="text-sm text-sage">اختر محادثة لعرض رسائلها والرد منها</p>
                </div>
              ) : (
                <>
                  <div className="px-4 py-3 border-b border-verde/10 flex items-center gap-3 bg-wa-dark/40">
                    <button onClick={() => setMobileThread(false)} className="lg:hidden text-sage hover:text-bone" aria-label="عودة">
                      <IconChevronDown className="w-4 h-4 rotate-90" />
                    </button>
                    {active.customerAvatar ? (
                      <img src={active.customerAvatar} alt="" className="w-9 h-9 rounded-full object-cover border border-verde/30 shrink-0 bg-moss" referrerPolicy="no-referrer" />
                    ) : (
                      <span className="w-9 h-9 rounded-full bg-moss border border-verde/30 text-verde flex items-center justify-center shrink-0">
                        <ChannelIcon channel={(active.channel ?? "whatsapp") as ChannelId} className="w-4.5 h-4.5" />
                      </span>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-bold text-bone truncate">{active.customerName || active.phone || "—"}</p>
                      <p className="text-[10.5px] text-sage mt-0.5">
                        {active.humanAgentActive
                          ? `Human Agent — ${Math.floor((active.remainingSeconds ?? 0) / 60)}:${String((active.remainingSeconds ?? 0) % 60).padStart(2, '0')}`
                          : active.transferred ? "محوّلة لك" : active.paused ? "موقوف" : "الرد الآلي يعمل"}
                      </p>
                    </div>
                    {active.humanAgentActive ? (
                      <button
                        onClick={async () => {
                          await apiAuthFetch(token!, `/api/dashboard/conversations/${active.id}/release`, { method: "POST" });
                          setSt((prev) => prev ? { ...prev, convs: prev.convs.map((c) => c.id === active.id ? { ...c, transferred: false, humanAgentActive: false, remainingSeconds: 0, humanAgentExpiresAt: null } : c) } : null);
                          showToast("تم إنهاء Human Agent");
                        }}
                        className="text-[10px] font-bold text-red-600 bg-red-100 border border-red-300 rounded-full px-2.5 py-1 inline-flex items-center gap-1"
                      >
                        <IconX className="w-3 h-3" /> إلغاء
                      </button>
                    ) : !active.transferred ? (
                      <button
                        onClick={async () => {
                          const res = await apiAuthFetch<{ expiresAt: string }>(token!, `/api/dashboard/conversations/${active.id}/takeover`, { method: "POST" });
                          setSt((prev) => prev ? { ...prev, convs: prev.convs.map((c) => c.id === active.id ? { ...c, transferred: true, humanAgentActive: true, remainingSeconds: 900, humanAgentExpiresAt: res.expiresAt } : c) } : null);
                        }}
                        className="text-[10px] font-bold text-white bg-blue-600 rounded-full px-2.5 py-1 inline-flex items-center gap-1"
                      >
                        <IconHandoff className="w-3 h-3" /> Human Agent
                      </button>
                    ) : (
                      <button
                        onClick={async () => {
                          await apiAuthFetch(token!, `/api/dashboard/conversations/${active.id}/release`, { method: "POST" });
                          setSt((prev) => prev ? { ...prev, convs: prev.convs.map((c) => c.id === active.id ? { ...c, transferred: false, humanAgentActive: false, remainingSeconds: 0, humanAgentExpiresAt: null } : c) } : null);
                          showToast("تم العودة للرد الآلي");
                        }}
                        className="text-[10px] font-bold text-emerald-600 bg-emerald-100 border border-emerald-300 rounded-full px-2.5 py-1 inline-flex items-center gap-1"
                      >
                        <IconCheck className="w-3 h-3" /> العودة للآلي
                      </button>
                    )}
                  </div>

                  <div className="flex-1 overflow-y-auto qa-scroll p-4 space-y-2.5" style={{ maxHeight: 400 }}>
                    {active.msgs.map((m) => (
                      <div key={m.id} className={`flex ${m.direction === "out" ? "justify-start" : "justify-end"} msg-in`}>
                        <div className={`max-w-[78%] rounded-2xl px-3.5 py-2.5 shadow-sm ${m.direction === "out" ? "bg-wa-out rounded-bl-md" : "bg-wa-in rounded-br-md"}`}>
                          <p className="text-[13px] leading-6 text-bone">{m.body}</p>
                          <p className="flex items-center justify-end gap-1.5 mt-1 text-[9.5px] text-sage/80">
                            {m.direction === "out" && (
                              <span className={`rounded-full px-1.5 py-px border text-[8.5px] font-bold ${m.is_auto ? "border-verde/50 text-verde" : "border-oro/50 text-oro-soft"}`}>
                                {m.is_auto ? "آلي" : "أنت"}
                              </span>
                            )}
                            {m.status === "failed" && (
                              <button onClick={() => retrySend(m)} className="text-red-400 hover:text-red-300 font-bold text-xs" title="إعادة">❌</button>
                            )}
                            <span className="tabular-nums">{fmtTime(m.created_at)}</span>
                          </p>
                        </div>
                      </div>
                    ))}
                    <div ref={threadEndRef} />
                  </div>

                  <div className="p-3.5 border-t border-verde/10 bg-night/40">
                    <div className="relative">
                      <textarea
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); replyManual(); } }}
                        rows={1}
                        disabled={!(active.humanAgentActive || active.transferred)}
                        placeholder={(active.humanAgentActive || active.transferred) ? "اكتب ردّك اليدوي…" : "اضغط Human Agent للرد يدويًا"}
                        className={`w-full min-h-[80px] p-3 rounded-xl text-sm resize-none outline-none transition-all ${
                          (active.humanAgentActive || active.transferred)
                            ? 'bg-night/70 text-bone border border-verde/20 focus:border-oro/70'
                            : 'bg-night/40 text-sage/60 border border-verde/10 cursor-not-allowed'
                        }`}
                      />
                      <button
                        onClick={replyManual}
                        disabled={sending || !draft.trim() || !(active.humanAgentActive || active.transferred)}
                        className={`absolute bottom-3 left-3 p-2 rounded-lg transition-all ${
                          (active.humanAgentActive || active.transferred) && draft.trim() ? 'bg-oro text-night' : 'bg-night/50 text-sage/30'
                        }`}
                        aria-label="إرسال"
                      >
                        <IconSend className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </>
              )}
            </section>
          </div>
        )}

        {tab === "unresolved" && (
          <div className="space-y-4">
            {st.unresolved.length === 0 && (
              <div className={`${cls.card} p-12 text-center`}>
                <span className="text-verde inline-block mb-3"><IconCheck className="w-8 h-8" /></span>
                <p className="font-display font-bold text-lg text-bone">لا أسئلة عالقة</p>
              </div>
            )}
            {st.unresolved.map((u) => {
              const a = answers[u.id] ?? { text: "", save: true };
              return (
                <article key={u.id} className={`${cls.card} p-5`}>
                  <p className="font-display font-bold text-[15px] text-bone mb-3">{u.question}</p>
                  <textarea
                    value={a.text}
                    onChange={(e) => setAnswers((prev) => ({ ...prev, [u.id]: { ...a, text: e.target.value } }))}
                    rows={2}
                    placeholder="اكتب الإجابة…"
                    className={`${cls.input} resize-none mb-3`}
                  />
                  <button onClick={() => resolveOne(u)} className={`${cls.btn} !py-2 !px-4 text-xs`}>
                    {u.conversationId ? "إرسالها للعميل وحلّها" : "حفظها وحلّها"}
                  </button>
                </article>
              );
            })}
          </div>
        )}

        {tab === "knowledge" && (
          <>
          <section className={`${cls.card} p-5 mb-4`}>
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-bold text-bone inline-flex items-center gap-2">
                <IconSparkle className="w-4.5 h-4.5 text-oro" />
                رسالة توجيه الوكيل (System Message)
              </p>
              <span className="text-[10.5px] text-sage tabular-nums">
                {agentPrompt.length} / 8000
              </span>
            </div>

            <p className="text-[11.5px] text-sage leading-6 mb-3">
              هذه الرسالة تحدد شخصية الوكيل وأسلوبه في الرد. اكتبها بالعربية.
              إذا تركتها فارغة، سيستخدم الوكيل الإعداد الافتراضي.
            </p>

            <textarea
              value={agentPrompt}
              onChange={(e) => setAgentPrompt(e.target.value)}
              rows={12}
              maxLength={8000}
              placeholder="أنت وكيل خدمة عملاء ذكي واحترافي..."
              className={`${cls.input} resize-y font-mono text-[12px] leading-6 mb-3`}
              dir="rtl"
            />

            <div className="flex gap-2 flex-wrap">
              <button
                onClick={saveAgentPrompt}
                disabled={agentPromptSaving}
                className={`${cls.btn} !py-2 !px-4 text-xs`}
              >
                <IconCheck className="w-3.5 h-3.5" />
                {agentPromptSaving ? "جارٍ الحفظ…" : "حفظ رسالة التوجيه"}
              </button>
              <button
                onClick={() => setAgentPrompt("")}
                className={`${cls.btnGhost} !py-2 !px-4 text-xs`}
              >
                مسح الحقل
              </button>
            </div>
          </section>
          <div className="grid lg:grid-cols-[1fr_360px] gap-4 items-start">
            <section className={`${cls.card} overflow-hidden`}>
              <div className="px-5 py-4 border-b border-verde/10">
                <p className="text-sm font-bold text-bone inline-flex items-center gap-2">
                  <IconDatabase className="w-4.5 h-4.5 text-verde" /> مصادر معلومات الموظف
                </p>
              </div>
              <ul className="divide-y divide-verde/8">
                {st.sources.length === 0 && (
                  <li className="px-5 py-12 text-center text-xs text-sage/70">لا مصادر بعد.</li>
                )}
                {st.sources.map((s) => (
                  <li key={s.id} className="px-5 py-4 flex items-center gap-3.5">
                    <span className="w-9 h-9 rounded-xl bg-moss border border-verde/25 text-verde flex items-center justify-center shrink-0">
                      <IconPen className="w-4.5 h-4.5" />
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-semibold text-bone truncate" dir="auto">
                        {s.url ?? (s.kind === "manual-text" ? "نص يدوي" : s.kind)}
                      </p>
                      <p className="text-[10.5px] text-sage mt-0.5">{fmtDate(s.createdAt)}</p>
                    </div>
                    <button onClick={() => deleteSource(s.id)} className="text-sage/40 hover:text-oro shrink-0" aria-label="حذف">
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
                    className={`flex-1 py-2 rounded-lg text-xs font-bold ${newSource.kind === k ? "bg-moss text-oro" : "text-sage"}`}
                  >
                    {k === "url" ? "رابط" : "نص"}
                  </button>
                ))}
              </div>
              {newSource.kind === "url" ? (
                <input dir="ltr" value={newSource.url} onChange={(e) => setNewSource((p) => ({ ...p, url: e.target.value }))} className={`${cls.input} text-left mb-4`} placeholder="https://your-site.com" />
              ) : (
                <textarea value={newSource.text} onChange={(e) => setNewSource((p) => ({ ...p, text: e.target.value }))} rows={5} className={`${cls.input} resize-none mb-4`} placeholder="الصق معلومات مشروعك…" />
              )}
              <button onClick={addSource} className={`${cls.btn} w-full py-3`}>
                <IconPlus className="w-4 h-4" /> استخراج وفهرسة
              </button>
            </aside>
          </div>
          </>
        )}

        {tab === "widgets" && (
          <div className="grid lg:grid-cols-[1fr_400px] gap-4 items-start">
            <section className={`${cls.card} overflow-hidden`}>
              <div className="px-5 py-4 border-b border-verde/10 flex items-center justify-between">
                <p className="text-sm font-bold text-bone">💬 Widgets الخاصة بك</p>
                <span className="text-[11px] text-sage">{widgets.length} widget</span>
              </div>
              <ul className="divide-y divide-verde/8">
                {widgets.length === 0 && (
                  <li className="px-5 py-12 text-center text-xs text-sage/70">لا widgets بعد.</li>
                )}
                {widgets.map((w) => (
                  <li key={w.id} className="px-5 py-4">
                    <p className="text-[14px] font-semibold text-bone truncate">{w.name}</p>
                    <div className="flex gap-2 mt-2 flex-wrap">
                      <button onClick={() => setWidgetPreview(w)} className="text-[11px] text-verde hover:text-oro">معاينة</button>
                      <button onClick={() => copyEmbedCode(w.public_token)} className="text-[11px] text-verde hover:text-oro">
                        {copiedCode === w.public_token ? "✓ تم النسخ" : "نسخ الكود"}
                      </button>
                      <button onClick={() => toggleWidget(w.id, !w.enabled)} className="text-[11px] text-oro hover:text-bone">
                        {w.enabled ? "تعطيل" : "تفعيل"}
                      </button>
                      <button onClick={() => deleteWidget(w.id)} className="text-[11px] text-red-400 hover:text-red-300">حذف</button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            <aside className={`${cls.card} p-5`}>
              <p className="text-sm font-bold text-bone mb-4">إنشاء Widget جديد</p>
              <div className="space-y-3">
                <input value={widgetForm.name} onChange={(e) => setWidgetForm({ ...widgetForm, name: e.target.value })} className={cls.input} placeholder="اسم الـ widget" />
                <textarea value={widgetForm.welcomeMessage} onChange={(e) => setWidgetForm({ ...widgetForm, welcomeMessage: e.target.value })} rows={2} className={`${cls.input} resize-none`} placeholder="رسالة الترحيب" />
                <button onClick={createWidget} className={`${cls.btn} w-full py-3`}>إنشاء Widget</button>
              </div>
            </aside>
          </div>
        )}

        {tab === "channels" && (
          <div className="space-y-6">
            <div>
              <h2 className="font-display font-bold text-2xl text-bone">القنوات والحسابات</h2>
              <p className="text-sm text-sage mt-1">اربط قنوات التواصل الخاصة بنشاطك التجاري.</p>
            </div>

            <div className="grid md:grid-cols-3 gap-4">
              {/* WhatsApp */}
              <div className={`${cls.card} p-5 flex flex-col`}>
                <div className="flex items-center justify-between mb-3">
                  <div className="w-12 h-12 rounded-2xl flex items-center justify-center" style={{ background: "#25D366" }}>
                    <IconWhatsapp className="w-6 h-6 text-white" />
                  </div>
                  <span className={`text-[10px] font-bold px-2 py-1 rounded-full border ${
                    waLive ? "bg-verde/10 text-verde border-verde/30" : "bg-moss text-sage border-verde/20"
                  }`}>
                    {waLive ? "متصل" : "غير متصل"}
                  </span>
                </div>
                <h3 className="font-display font-bold text-lg text-bone mb-1">WhatsApp Business</h3>
                <p className="text-xs text-sage mb-2 leading-5">الرسائل عبر WhatsApp Cloud API.</p>
                {st.phone && (
                  <p className="text-[11px] text-mist mb-3 tabular-nums" dir="ltr">+{st.phone.replace(/\D/g, "")}</p>
                )}
                <div className="mt-auto">
                  <button onClick={() => handleConnectChannel("whatsapp")} className={`${cls.btn} w-full py-2.5 text-xs`}>
                    إعداد الربط
                  </button>
                </div>
              </div>

              {/* Facebook */}
              <div className={`${cls.card} p-5 flex flex-col`}>
                <div className="flex items-center justify-between mb-3">
                  <div className="w-12 h-12 rounded-2xl flex items-center justify-center" style={{ background: "#1877F2" }}>
                    <IconFacebook className="w-6 h-6 text-white" />
                  </div>
                  <span className={`text-[10px] font-bold px-2 py-1 rounded-full border ${
                    fbAccounts.some((a) => a.status === "active") ? "bg-verde/10 text-verde border-verde/30" : "bg-moss text-sage border-verde/20"
                  }`}>
                    {fbAccounts.some((a) => a.status === "active") ? "متصل" : "غير متصل"}
                  </span>
                </div>
                <h3 className="font-display font-bold text-lg text-bone mb-1">Facebook Messenger</h3>
                <p className="text-xs text-sage mb-3 leading-5">اربط صفحات Facebook لإدارة رسائل Messenger.</p>
                {fbAccounts.length > 0 ? (
                  <ul className="space-y-1.5 mb-3">
                    {fbAccounts.map((a) => (
                      <li key={a.id} className="flex items-center gap-2 bg-night/50 border border-verde/10 rounded-xl px-3 py-2">
                        {a.avatar_url ? (
                          <img src={a.avatar_url} alt="" className="w-6 h-6 rounded-full object-cover" referrerPolicy="no-referrer" />
                        ) : (
                          <span className="w-6 h-6 rounded-full bg-[#1877F2]/15 text-[#6ea3f5] flex items-center justify-center"><IconFacebook className="w-3.5 h-3.5" /></span>
                        )}
                        <span className="text-[11.5px] text-bone font-semibold truncate flex-1">{a.display_name ?? a.external_id}</span>
                        <button onClick={() => openManageAccount(a)} className="text-[10px] font-bold text-oro hover:text-bone shrink-0">إدارة</button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="mt-auto space-y-2">
                  <button onClick={() => handleConnectChannel("facebook")} className={`${cls.btn} w-full py-2.5 text-xs`} disabled={chBusyPlatform === "facebook"}>
                    {chBusyPlatform === "facebook" ? "جارٍ التحويل…" : fbAccounts.length > 0 ? "ربط صفحة أخرى" : "ربط Facebook"}
                  </button>
                </div>
              </div>

              {/* Instagram */}
              <div className={`${cls.card} p-5 flex flex-col`}>
                <div className="flex items-center justify-between mb-3">
                  <div className="w-12 h-12 rounded-2xl flex items-center justify-center" style={{ background: "linear-gradient(45deg, #F58529, #DD2A7B, #8134AF)" }}>
                    <IconInstagram className="w-6 h-6 text-white" />
                  </div>
                  <span className={`text-[10px] font-bold px-2 py-1 rounded-full border ${
                    igAccounts.some((a) => a.status === "active") ? "bg-verde/10 text-verde border-verde/30" : "bg-moss text-sage border-verde/20"
                  }`}>
                    {igAccounts.some((a) => a.status === "active") ? "متصل" : "غير متصل"}
                  </span>
                </div>
                <h3 className="font-display font-bold text-lg text-bone mb-1">Instagram DM</h3>
                <p className="text-xs text-sage mb-3 leading-5">اربط حساب Instagram الاحترافي لإدارة الرسائل.</p>

                {igAccounts.length > 0 ? (
                  <div className="space-y-2 mb-3">
                    {igAccounts.map((a) => (
                      <div key={a.id} className="flex items-center gap-3 bg-night/50 border border-verde/15 rounded-xl px-3 py-2.5">
                        {a.avatar_url ? (
                          <img
                            src={a.avatar_url}
                            alt=""
                            className="w-10 h-10 rounded-full object-cover border border-verde/25"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <span className="w-10 h-10 rounded-full bg-gradient-to-tr from-[#F58529] via-[#DD2A7B] to-[#8134AF] flex items-center justify-center">
                            <IconInstagram className="w-5 h-5 text-white" />
                          </span>
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-[13px] font-bold text-bone truncate" dir="ltr">
                            {a.display_name ?? `@${a.external_id}`}
                          </p>
                          <p className="text-[10px] text-sage tabular-nums truncate" dir="ltr">
                            ID: {a.external_id}
                          </p>
                          <p className="text-[10px] text-verde">
                            {a.status === "active" ? "نشط" : a.status}
                          </p>
                        </div>
                        <button
                          onClick={() => openManageAccount(a)}
                          className="text-[10px] font-bold text-oro hover:text-bone shrink-0"
                        >
                          إدارة
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}

                <div className="mt-auto space-y-2">
                  <button onClick={() => handleConnectChannel("instagram")} className={`${cls.btn} w-full py-2.5 text-xs`} disabled={chBusyPlatform === "instagram"}>
                    {chBusyPlatform === "instagram" ? "جارٍ التحويل…" : igAccounts.length > 0 ? "ربط حساب آخر" : "ربط Instagram"}
                  </button>
                  {igAccounts.length > 0 && (
                    <button onClick={() => disconnectSocialChannel("instagram")} className="w-full py-2 text-[11px] font-bold text-red-300/80 hover:text-red-300 border border-red-400/20 rounded-xl">
                      فصل القناة
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {manageAcc && (
          <div className="fixed inset-0 z-50 flex items-stretch justify-start" role="dialog" aria-modal="true">
            <button className="absolute inset-0 bg-night/80 backdrop-blur-sm" onClick={() => setManageAcc(null)} aria-label="إغلاق" />
            <div className="relative ms-auto h-full w-full max-w-md bg-pine border-s border-verde/25 overflow-y-auto p-6 space-y-5 msg-in">
              <div className="flex items-center justify-between">
                <h3 className="font-display font-bold text-lg text-bone">إدارة الحساب</h3>
                <button onClick={() => setManageAcc(null)} className="p-2 text-sage hover:text-bone">
                  <IconX className="w-5 h-5" />
                </button>
              </div>

              <div className={`${cls.card} p-4 space-y-2`}>
                <div className="flex items-center gap-3">
                  {manageAcc.avatar_url ? (
                    <img src={manageAcc.avatar_url} alt="" className="w-12 h-12 rounded-full object-cover border border-verde/25" referrerPolicy="no-referrer" />
                  ) : (
                    <span className="w-12 h-12 rounded-full bg-moss flex items-center justify-center text-verde">
                      {manageAcc.channel === "instagram" ? <IconInstagram className="w-6 h-6" /> : <IconFacebook className="w-6 h-6" />}
                    </span>
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-bone truncate" dir="ltr">{manageAcc.display_name ?? manageAcc.external_id ?? "—"}</p>
                    <p className="text-[11px] text-sage">
                      {CHANNELS[manageAcc.channel].label} · {CHANNEL_STATUS_LABEL[manageAcc.status]?.text ?? manageAcc.status}
                    </p>
                  </div>
                </div>
                <p className="text-[10.5px] text-sage/70 tabular-nums" dir="ltr">ID: {manageAcc.external_id ?? "—"}</p>
                <p className="text-[10.5px] text-sage/70">تاريخ الربط: {manageAcc.created_at ? fmtDate(manageAcc.created_at) : "—"}</p>
              </div>

              <div className={`${cls.card} p-4 space-y-3`}>
                <p className="text-xs font-bold text-sage">وكيل الذكاء الاصطناعي</p>
                <label className="flex items-center justify-between gap-2 cursor-pointer">
                  <span className="text-[12.5px] text-bone">تفعيل الوكيل</span>
                  <input
                    type="checkbox"
                    checked={manageAcc.agent_enabled}
                    onChange={(e) => {
                      const v = e.target.checked;
                      setManageAcc((p) => (p ? { ...p, agent_enabled: v } : p));
                      patchAccount(manageAcc.id, { agent_enabled: v });
                    }}
                    className="accent-verde w-4 h-4"
                  />
                </label>
                <label className="flex items-center justify-between gap-2 cursor-pointer">
                  <span className="text-[12.5px] text-bone">الرد التلقائي</span>
                  <input
                    type="checkbox"
                    checked={manageAcc.auto_reply}
                    onChange={(e) => {
                      const v = e.target.checked;
                      setManageAcc((p) => (p ? { ...p, auto_reply: v } : p));
                      patchAccount(manageAcc.id, { auto_reply: v });
                    }}
                    className="accent-verde w-4 h-4"
                  />
                </label>
              </div>

              <div className={`${cls.card} p-4 space-y-3`}>
                <p className="text-xs font-bold text-sage">التحويل إلى موظف</p>
                <label className="flex items-center justify-between gap-2 cursor-pointer">
                  <span className="text-[12.5px] text-bone">عند طلب العميل</span>
                  <input type="checkbox" checked={handoffCfg.onRequest} onChange={(e) => setHandoffCfg({ ...handoffCfg, onRequest: e.target.checked })} className="accent-verde w-4 h-4" />
                </label>
                <label className="flex items-center justify-between gap-2 cursor-pointer">
                  <span className="text-[12.5px] text-bone">عند عدم معرفة الإجابة</span>
                  <input type="checkbox" checked={handoffCfg.onNoAnswer} onChange={(e) => setHandoffCfg({ ...handoffCfg, onNoAnswer: e.target.checked })} className="accent-verde w-4 h-4" />
                </label>
                <div>
                  <label className="block text-[11px] text-sage mb-1">كلمات مفتاحية (مفصولة بفواصل)</label>
                  <input value={handoffCfg.keywords} onChange={(e) => setHandoffCfg({ ...handoffCfg, keywords: e.target.value })} className={cls.input} placeholder="شكوى، استرجاع" />
                </div>
                <button onClick={saveHandoffRules} className={`${cls.btn} w-full py-2.5 text-xs`}>حفظ القواعد</button>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => startMetaOAuth(manageAcc.channel as "facebook" | "instagram")}
                  className={`${cls.btnGhost} flex-1 py-2.5 text-xs`}
                >
                  إعادة الاتصال
                </button>
                <button
                  onClick={() => disconnectAccount(manageAcc)}
                  className="inline-flex items-center justify-center gap-2 border border-red-500/40 text-red-400 font-semibold text-sm px-4 py-2.5 rounded-xl hover:bg-red-500/10 text-xs flex-1"
                >
                  فصل الحساب
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      {widgetPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-night/80 backdrop-blur-sm" onClick={() => setWidgetPreview(null)}>
          <div className="relative w-full max-w-sm bg-pine border border-verde/25 rounded-3xl p-6" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setWidgetPreview(null)} className="absolute top-4 left-4 text-sage hover:text-bone">
              <IconX className="w-5 h-5" />
            </button>
            <h3 className="font-display font-bold text-xl text-bone mb-4 text-center">معاينة Widget</h3>
            <p className="text-center text-sm text-sage">{widgetPreview.name}</p>
          </div>
        </div>
      )}

      {payOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
          <button className="absolute inset-0 bg-night/80 backdrop-blur-sm" onClick={() => setPayOpen(false)} aria-label="إغلاق" />
          <div className="relative w-full max-w-lg bg-pine border border-verde/25 rounded-3xl p-6">
            <button onClick={() => setPayOpen(false)} className="absolute top-4 left-4 text-sage hover:text-bone">
              <IconX className="w-5 h-5" />
            </button>
            <h3 className="font-display font-bold text-xl text-bone mb-1">اشحن رصيد الردود</h3>
            <div className="space-y-3">
              {[
                { id: "starter", name: "البداية", credits: 1000, price: 35000 },
                { id: "growth", name: "النمو", credits: 3000, price: 85000, hot: true },
                { id: "scale", name: "التوسع", credits: 10000, price: 225000 },
              ].map((p) => (
                <button
                  key={p.id}
                  onClick={() => recharge(p.id)}
                  className={`w-full flex items-center gap-4 rounded-2xl border p-4 text-start transition-all ${
                    p.hot ? "border-oro/60 bg-oro/5" : "border-verde/20 bg-night/40"
                  }`}
                >
                  <span className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${p.hot ? "bg-oro/15 text-oro" : "bg-moss text-verde"}`}>
                    <IconCoin className="w-5 h-5" />
                  </span>
                  <span className="flex-1">
                    <span className="block text-sm font-bold text-bone">{p.name}</span>
                    <span className="block text-[11px] text-sage mt-0.5">{p.credits.toLocaleString("en")} رد</span>
                  </span>
                  <span className="font-display font-bold text-xl text-bone tabular-nums">
                    {p.price.toLocaleString("en")} <span className="text-[11px] text-sage">د.ع</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

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
