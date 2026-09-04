/**
 * مدير جلسات واتساب عبر Baileys (خاصية الأجهزة المرتبطة).
 *
 * - جلسة مستقلة لكل عميل (tenant = agent/workspace) مع مفاتيح دائمة في
 *   data/auth/<tenantId> — بعد إعادة تشغيل السيرفر لا يُطلب QR ما دامت الجلسة صالحة.
 * - آلة حالات صريحة: QR_REQUIRED → CONNECTING → CONNECTED
 *   (مع DISCONNECTED / LOGGED_OUT / ERROR).
 * - ناشر أحداث (subscribe) يبث كل تغيّر حالة وكل QR جديد فور صدوره من Baileys
 *   لمسارات SSE — الواجهة لا تنشئ الجلسة أبدًا، فقط تعرض.
 *
 * تنبيه: ربط غير رسمي من Meta وقد يعرّض الرقم للتقييد.
 * المسار الرسمي المستقبلي: WhatsApp Business Cloud API (انظر README).
 */
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  type WASocket,
} from "@whiskeysockets/baileys";
import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import QRCode from "qrcode";
import { config } from "../config.js";
import { encryptField, maskPhone } from "../crypto.js";
import { db } from "../db.js";

export type SessionState =
  | "QR_REQUIRED"
  | "CONNECTING"
  | "CONNECTED"
  | "DISCONNECTED"
  | "LOGGED_OUT"
  | "ERROR";

export type SessionSnapshot = {
  sessionId: string;
  state: SessionState;
  /** صورة PNG (data URL) للـ QR الخام الصادر من جلسة واتساب — null خارج حالة QR_REQUIRED */
  qrDataUrl: string | null;
  /** رقم الحساب مقنّعًا (متاح بعد الربط) */
  phone: string | null;
  error: string | null;
  updatedAt: number;
};

type Listener = (snap: SessionSnapshot) => void;

const RECONNECT_DELAYS = [2000, 4000, 8000, 16000, 30000];
const CONNECT_ERROR = "تعذر إنشاء جلسة واتساب، تحقق من اتصال الخادم.";

const logger = pino({ level: "silent" });
const sessions = new Map<string, WaSession>();

type IncomingHandler = (
  tenantId: string,
  chatId: string,
  text: string,
  waMessageId: string | null
) => Promise<void>;
let onIncoming: IncomingHandler | null = null;

/** يربط محرك الرد بالجلسات (يُستدعى مرة واحدة من index.ts) */
export function initWa(handler: IncomingHandler) {
  onIncoming = handler;
}

const authDir = (tenantId: string) => path.join(config.dataDir, "auth", tenantId);

class WaSession {
  readonly tenantId: string;
  private socket: WASocket | null = null;
  private state: SessionState = "DISCONNECTED";
  private qrDataUrl: string | null = null;
  private phone: string | null = null;
  private error: string | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private starting: Promise<void> | null = null;
  private listeners = new Set<Listener>();

  constructor(tenantId: string) {
    this.tenantId = tenantId;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  isRunning(): boolean {
    return this.socket !== null;
  }

  snapshot(): SessionSnapshot {
    return {
      sessionId: this.tenantId,
      state: this.state,
      qrDataUrl: this.state === "QR_REQUIRED" ? this.qrDataUrl : null,
      phone: this.phone ? maskPhone(this.phone) : null,
      error: this.error,
      updatedAt: Date.now(),
    };
  }

  private emit() {
    const snap = this.snapshot();
    for (const l of this.listeners) {
      try {
        l(snap);
      } catch {
        /* مستمع واحد لا يكسر البقية */
      }
    }
  }

  private setState(s: SessionState, error: string | null = null) {
    this.state = s;
    this.error = error;
    if (s !== "QR_REQUIRED") this.qrDataUrl = null;
    this.emit();
  }

  /** إنشاء مقبس Baileys (مرة واحدة حتى مع استدعاءات متزامنة) */
  async start(): Promise<void> {
    if (this.socket) return;
    if (this.starting) return this.starting;
    this.starting = this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart(): Promise<void> {
    this.setState("CONNECTING");
    try {
      const dir = authDir(this.tenantId);
      fs.mkdirSync(dir, { recursive: true });
      // مفاتيح دائمة → لا QR جديد بعد إعادة التشغيل ما دامت الجلسة صالحة
      const { state, saveCreds } = await useMultiFileAuthState(dir);
      if (this.socket) return; // سبقنا استدعاء آخر

      const sock = makeWASocket({
        auth: state,
        logger,
        printQRInTerminal: false,
        generateHighQualityLinkPreview: false,
        browser: ["Milano", "Chrome", "1.0"],
        markOnlineOnConnect: false,
      });
      this.socket = sock;
      this.bindEvents(sock, saveCreds);
    } catch (e) {
      console.error(`[wa:${this.tenantId}] start failed:`, e);
      this.socket = null;
      this.setState("ERROR", CONNECT_ERROR);
    }
  }

  private bindEvents(sock: WASocket, saveCreds: () => Promise<void>) {
    const stale = () => this.socket !== sock;

    sock.ev.on("creds.update", () => {
      saveCreds().catch(() => {});
    });

    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      if (stale()) return;

      // QR خام جديد من واتساب (يُجدَّد كل ~20 ثانية) → نعرض دائمًا آخر واحد فعّال
      if (qr) {
        try {
          this.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 360 });
        } catch {
          this.qrDataUrl = null;
        }
        this.state = "QR_REQUIRED";
        this.error = null;
        this.emit();
      }

      if (connection === "connecting") this.setState("CONNECTING");

      if (connection === "open") {
        this.reconnectAttempt = 0;
        try {
          const id = sock.user?.id ?? "";
          this.phone = id.split(":")[0].split("@")[0] || null;
          if (this.phone) {
            db.from("tenants")
              .update({ phone_encrypted: encryptField(this.phone) })
              .eq("id", this.tenantId)
              .then(() => {});
          }
        } catch {
          /* غير حرج */
        }
        this.setState("CONNECTED");
      }

      if (connection === "close") {
        this.socket = null;
        const code = (lastDisconnect?.error as any)?.output?.statusCode;

        if (code === DisconnectReason.loggedOut) {
          // فُصل من الأجهزة المرتبطة → نمسح المفاتيح؛ الجلسة التالية تحتاج QR جديد
          fs.rmSync(authDir(this.tenantId), { recursive: true, force: true });
          this.phone = null;
          this.setState("LOGGED_OUT");
          return;
        }

        this.setState("DISCONNECTED");
        if (this.reconnectAttempt < RECONNECT_DELAYS.length) {
          const delay = RECONNECT_DELAYS[this.reconnectAttempt];
          this.reconnectAttempt += 1;
          this.reconnectTimer = setTimeout(() => {
            this.start().catch(() => {});
          }, delay);
        } else {
          // استُنفدت المحاولات → مقبس جديد: يتصل وحده إن كانت المفاتيح صالحة،
          // وإلا يصدر QR جديد (أو LOGGED_OUT إن رُفضت الجلسة)
          this.reconnectAttempt = 0;
          this.start().catch(() => {});
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (stale() || type !== "notify" || !onIncoming) return;
      for (const m of messages) {
        try {
          if (m.key.fromMe || !m.message) continue;
          const jid = m.key.remoteJid;
          if (!jid || jid.includes("@g.us")) continue; // MVP: محادثات خاصة فقط
          const text =
            (m.message as any).conversation ||
            (m.message as any).extendedTextMessage?.text ||
            "";
          if (!text.trim()) continue;
          await onIncoming(this.tenantId, jid, text.trim(), m.key.id ?? null);
        } catch (e) {
          console.error("[wa] message handler error:", e);
        }
      }
    });
  }

  /** إرسال رسالة نصية — ترمي خطأ إن لم تكن الجلسة متصلة */
  async send(chatId: string, text: string): Promise<void> {
    if (!this.socket || this.state !== "CONNECTED") {
      throw new Error("واتساب غير متصل حاليًا — أعد الربط من اللوحة");
    }
    await this.socket.sendMessage(chatId, { text });
  }

  /** تسجيل خروج حقيقي: يفصل الجهاز ويمسح المفاتيح المخزنة */
  async logout(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const sock = this.socket;
    this.socket = null;
    if (sock) {
      try {
        await sock.logout();
      } catch {
        /* نتجاهل أخطاء الإنهاء */
      }
    }
    fs.rmSync(authDir(this.tenantId), { recursive: true, force: true });
    this.phone = null;
    this.setState("LOGGED_OUT");
  }
}

/* ── الواجهة العامة للمدير ── */

function getOrCreate(tenantId: string): WaSession {
  let s = sessions.get(tenantId);
  if (!s) {
    s = new WaSession(tenantId);
    sessions.set(tenantId, s);
  }
  return s;
}

/** إنشاء/استرجاع جلسة العميل وبدء المقبس إن لم يكن يعمل */
export async function ensureSession(tenantId: string): Promise<SessionSnapshot> {
  const s = getOrCreate(tenantId);
  if (!s.isRunning()) await s.start();
  return s.snapshot();
}

export function getSnapshot(tenantId: string): SessionSnapshot {
  return getOrCreate(tenantId).snapshot();
}

/** الاشتراك في بث أحداث الجلسة (SSE) — يعيد دالة إلغاء الاشتراك */
export function subscribeSession(tenantId: string, fn: Listener): () => void {
  return getOrCreate(tenantId).subscribe(fn);
}

export async function logoutSession(tenantId: string): Promise<void> {
  await getOrCreate(tenantId).logout();
}

export async function sendText(tenantId: string, chatId: string, text: string): Promise<void> {
  const s = sessions.get(tenantId);
  if (!s) throw new Error("واتساب غير متصل حاليًا — أعد الربط من اللوحة");
  await s.send(chatId, text);
}

/** توافقية مع لوحة التحكم القديمة (ملخص الحالة) */
export function waStatus(tenantId: string): {
  status: "idle" | "qr" | "connecting" | "connected" | "disconnected";
  qr: null;
  phoneMasked: string | null;
} {
  const s = sessions.get(tenantId);
  if (!s) return { status: "idle", qr: null, phoneMasked: null };
  const snap = s.snapshot();
  const status =
    snap.state === "CONNECTED"
      ? "connected"
      : snap.state === "CONNECTING"
        ? "connecting"
        : snap.state === "QR_REQUIRED"
          ? "qr"
          : snap.state === "DISCONNECTED"
            ? "disconnected"
            : "idle";
  return { status, qr: null, phoneMasked: snap.phone };
}

/** عند إقلاع السيرفر: إعادة وصل الجلسات التي لها مفاتيح محفوظة مسبقًا */
export async function restorePersistedSessions(): Promise<void> {
  const root = path.join(config.dataDir, "auth");
  if (!fs.existsSync(root)) return;
  const ids = fs.readdirSync(root).filter((f) => !f.startsWith("."));
  for (const id of ids) {
    const hasCreds = fs.existsSync(path.join(root, id, "creds.json"));
    if (hasCreds) {
      console.log(`[wa] استعادة جلسة محفوظة: ${id}`);
      ensureSession(id).catch((e) => console.error(`[wa] restore ${id} failed:`, e));
    }
  }
}
