/**
 * مدير جلسات واتساب عبر Meta Cloud API الرسمي من Meta.
 *
 * - لا يستخدم Baileys أو WhatsApp Web أو QR
 * - الاتصال يتم عبر Meta WhatsApp Cloud API
 * - استقبال الرسائل يتم عبر Webhook
 * - إرسال الرسائل يتم عبر Graph API
 * - كل Tenant يتم التحقق منه بشكل مستقل
 */

import { maskPhone } from "../crypto.js";
import { metaCloudAPI } from "./metaCloudAPI.js";

export type SessionState =
  | "CONNECTED"
  | "DISCONNECTED"
  | "ERROR";

export type SessionSnapshot = {
  sessionId: string;
  state: SessionState;
  qrDataUrl: null;
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

/**
 * يربط محرك الرد بالجلسات.
 *
 * محفوظ للتوافق مع النظام الحالي.
 * استقبال رسائل Meta يتم فعليًا عبر Webhook.
 */
export function initWa(handler: IncomingHandler) {
  onIncoming = handler;
}

/**
 * جلسة Meta Cloud API.
 *
 * لا توجد جلسة WhatsApp Web فعلية هنا.
 * الحالة تعكس صلاحية اتصال Meta Cloud API لهذا الـ tenant.
 */
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
      qrDataUrl: null,
      phone: this.phone ? maskPhone(this.phone) : null,
      error: this.error,
      updatedAt: Date.now(),
    };
  }

  private emit() {
    const snap = this.snapshot();

    for (const listener of this.listeners) {
      try {
        listener(snap);
      } catch (error) {
        console.error(
          `[wa:${this.tenantId}] session listener error:`,
          error
        );
      }
    }
  }

  private setState(
    state: SessionState,
    error: string | null = null
  ) {
    this.state = state;
    this.error = error;
    this.emit();
  }

  /**
   * التحقق من اتصال Meta Cloud API لهذا الـ tenant.
   */
  async start(): Promise<void> {
    try {
      console.log(
        `[wa:${this.tenantId}] Checking Meta Cloud API connection...`
      );

      const connected = await metaCloudAPI.isConnected(
        this.tenantId
      );

      if (connected) {
        console.log(
          `[wa:${this.tenantId}] Meta Cloud API connected`
        );

        this.setState("CONNECTED", null);
        return;
      }

      console.warn(
        `[wa:${this.tenantId}] Meta Cloud API is not connected`
      );

      this.setState(
        "DISCONNECTED",
        "Meta Cloud API غير متصل - تحقق من إعدادات WhatsApp Cloud API"
      );
    } catch (error) {
      console.error(
        `[wa:${this.tenantId}] Meta Cloud API connection check failed:`,
        error
      );

      this.setState(
        "ERROR",
        "فشل التحقق من اتصال Meta Cloud API"
      );
    }
  }

  /**
   * إرسال رسالة نصية عبر Meta Cloud API.
   */
  async send(
    chatId: string,
    text: string
  ): Promise<void> {
    if (this.state !== "CONNECTED") {
      await this.start();
    }

    if (this.state !== "CONNECTED") {
      throw new Error(
        "واتساب غير متصل حاليًا - تحقق من إعدادات Meta Cloud API"
      );
    }

    await metaCloudAPI.sendMessage(
      this.tenantId,
      chatId,
      text
    );
  }

  /**
   * في Meta Cloud API لا يوجد logout مثل WhatsApp Web.
   *
   * هذه الدالة فقط تفصل الحالة المحلية داخل السيرفر.
   */
  async logout(): Promise<void> {
    this.phone = null;

    this.setState(
      "DISCONNECTED",
      null
    );
  }
}

/* =========================================================
   Public Session Manager API
   ========================================================= */

/**
 * الحصول على جلسة موجودة أو إنشاء جلسة جديدة.
 */
function getOrCreate(tenantId: string): WaSession {
  let session = sessions.get(tenantId);

  if (!session) {
    session = new WaSession(tenantId);
    sessions.set(tenantId, session);
  }

  return session;
}

/**
 * إنشاء/التحقق من جلسة Tenant.
 *
 * لا يوجد QR.
 * لا يوجد Baileys.
 * لا يوجد WhatsApp Web.
 */
export async function ensureSession(
  tenantId: string
): Promise<SessionSnapshot> {
  if (!tenantId) {
    throw new Error("tenantId مطلوب");
  }

  const session = getOrCreate(tenantId);

  if (!session.isRunning()) {
    await session.start();
  }

  return session.snapshot();
}

/**
 * الحصول على الحالة الحالية.
 */
export function getSnapshot(
  tenantId: string
): SessionSnapshot {
  return getOrCreate(tenantId).snapshot();
}

/**
 * الاشتراك في تحديثات حالة الجلسة.
 */
export function subscribeSession(
  tenantId: string,
  listener: Listener
): () => void {
  return getOrCreate(tenantId).subscribe(listener);
}

/**
 * فصل الحالة المحلية للـ Tenant.
 *
 * لا يقوم بإلغاء ربط رقم WhatsApp من Meta.
 */
export async function logoutSession(
  tenantId: string
): Promise<void> {
  await getOrCreate(tenantId).logout();
}

/**
 * إرسال رسالة.
 */
export async function sendText(
  tenantId: string,
  chatId: string,
  text: string
): Promise<void> {
  if (!tenantId) {
    throw new Error("tenantId مطلوب");
  }

  if (!chatId) {
    throw new Error("chatId مطلوب");
  }

  if (!text?.trim()) {
    throw new Error("نص الرسالة مطلوب");
  }

  const session = getOrCreate(tenantId);

  await session.send(
    chatId,
    text
  );
}

/**
 * حالة WhatsApp المستخدمة بواسطة Dashboard.
 *
 * يتم التحقق مباشرة من Meta Cloud API
 * باستخدام tenantId الحقيقي.
 */
export async function waStatus(
  tenantId: string
): Promise<{
  status:
    | "idle"
    | "connected"
    | "disconnected"
    | "error";
  qr: null;
  phoneMasked: string | null;
}> {
  if (!tenantId) {
    return {
      status: "error",
      qr: null,
      phoneMasked: null,
    };
  }

  try {
    const connected =
      await metaCloudAPI.isConnected(
        tenantId
      );

    if (connected) {
      return {
        status: "connected",
        qr: null,
        phoneMasked: null,
      };
    }

    return {
      status: "disconnected",
      qr: null,
      phoneMasked: null,
    };
  } catch (error) {
    console.error(
      `[wa:${tenantId}] waStatus failed:`,
      error
    );

    return {
      status: "error",
      qr: null,
      phoneMasked: null,
    };
  }
}

/**
 * Meta Cloud API لا يحتاج إلى استعادة جلسات محفوظة.
 *
 * لا نستخدم tenantId = "default".
 * حالة كل Tenant يتم فحصها عند الحاجة.
 */
export async function restorePersistedSessions(): Promise<void> {
  console.log(
    "[wa] Meta Cloud API enabled - no persisted WhatsApp sessions to restore"
  );

  console.log(
    "[wa] Connection status will be checked per tenant"
  );
}

