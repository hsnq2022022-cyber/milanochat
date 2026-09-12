/**
 * مدير جلسات واتساب عبر Meta Cloud API (الرسمي من Meta).
 *
 * - يستخدم Meta WhatsApp Cloud API الرسمي بدلاً من Baileys/QR
 * - لا يحتاج QR code أو مسح من الجوال
 * - الرسائل ترد عبر Webhook من Meta
 * - الرسائل تُرسل عبر Graph API
 *
 * ملاحظة: Baileys لا يزال موجوداً كـ fallback لكن غير مستخدم في المسار الرئيسي
 */
import { config } from "../config.js";
import { encryptField, maskPhone } from "../crypto.js";
import { db } from "../db.js";
import { metaCloudAPI } from "./metaCloudAPI.js";
import type { WhatsAppProvider } from "./provider.js";

export type SessionState =
  | "CONNECTED"
  | "DISCONNECTED"
  | "ERROR";

export type SessionSnapshot = {
  sessionId: string;
  state: SessionState;
  /** QR لم يعد مستخدماً في Meta Cloud API */
  qrDataUrl: null;
  /** رقم الحساب مقنّعًا */
  phone: string | null;
  error: string | null;
  updatedAt: number;
};

type Listener = (snap: SessionSnapshot) => void;

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

class WaSession {
  readonly tenantId: string;
  private state: SessionState = "DISCONNECTED";
  private phone: string | null = null;
  private error: string | null = null;
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
    return this.state === "CONNECTED";
  }

  snapshot(): SessionSnapshot {
    return {
      sessionId: this.tenantId,
      state: this.state,
      qrDataUrl: null, // QR لم يعد مستخدماً
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
    this.emit();
  }

  /** التحقق من الاتصال عبر Meta Cloud API */
  async start(): Promise<void> {
    try {
      const connected = await metaCloudAPI.isConnected(this.tenantId);
      if (connected) {
        this.setState("CONNECTED");
      } else {
        this.setState("ERROR", "Meta Cloud API غير متصل - تحقق من Environment Variables");
      }
    } catch (e) {
      console.error(`[wa:${this.tenantId}] connection check failed:`, e);
      this.setState("ERROR", "فشل التحقق من اتصال Meta Cloud API");
    }
  }

  /** إرسال رسالة نصية عبر Meta Cloud API */
  async send(chatId: string, text: string): Promise<void> {
    if (this.state !== "CONNECTED") {
      throw new Error("واتساب غير متصل حاليًا - تحقق من Meta Cloud API configuration");
    }
    await metaCloudAPI.sendMessage(this.tenantId, chatId, text);
  }

  /** تسجيل الخروج - في Cloud API لا يوجد تسجيل خروج حقيقي */
  async logout(): Promise<void> {
    this.phone = null;
    this.setState("DISCONNECTED");
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
export async function waStatus(tenantId: string): Promise<{
  status: "idle" | "connected" | "disconnected" | "error";
  qr: null;
  phoneMasked: string | null;
}> {
  // التحقق من Cloud API مباشرة بدلاً من sessions Map
  const connected = await metaCloudAPI.isConnected(tenantId);
  
  if (connected) {
    return { 
      status: "connected", 
      qr: null, 
      phoneMasked: null // سيتم ملؤه من Cloud API لاحقاً إذا لزم
    };
  } else {
    return { 
      status: "disconnected", 
      qr: null, 
      phoneMasked: null 
    };
  }
}

/** في Meta Cloud API لا نحتاج لاستعادة جلسات - الاتصال دائم طالما الـ token صالح */
export async function restorePersistedSessions(): Promise<void> {
  console.log("[wa] Meta Cloud API - لا حاجة لاستعادة جلسات محفوظة");
  // في Cloud API، نتحقق فقط من صلاحية الـ token
  const connected = await metaCloudAPI.isConnected("default");
  if (connected) {
    console.log("[wa] Meta Cloud API connected successfully");
  } else {
    console.warn("[wa] Meta Cloud API not connected - check environment variables");
  }
}
