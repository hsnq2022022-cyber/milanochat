/**
 * مدير جلسات واتساب عبر Baileys (خاصية الأجهزة المرتبطة).
 * - جلسة واحدة لكل عميل (tenant) مع مفاتيح دائمة في data/auth/<tenantId>
 *   فلا يحتاج العميل لمسح QR من جديد عند إعادة تشغيل السيرفر.
 * - أحداث QR والاتصال تُعرض للواجهة عبر مسارات REST (polling).
 *
 * تنبيه: هذا ربط غير رسمي من Meta وقد يعرّض الرقم للتقييد.
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
import { config } from "../config.js";
import { encryptField, maskPhone } from "../crypto.js";
import { db } from "../db.js";

export type WaStatus = "idle" | "starting" | "qr" | "connecting" | "connected" | "disconnected";

type Session = {
  tenantId: string;
  socket: WASocket | null;
  status: WaStatus;
  /** نص QR الخام من Baileys — يُحوَّل إلى صورة في المسار */
  qr: string | null;
  phone: string | null;
};

const sessions = new Map<string, Session>();
const logger = pino({ level: "silent" });

type IncomingHandler = (
  tenantId: string,
  chatId: string,
  text: string,
  waMessageId: string | null
) => Promise<void>;

let onIncoming: IncomingHandler | null = null;

/** يربط محرك الرد بالجلسات (يُستدعى مرة واحدة من index.ts لفك أي اعتماد دائري) */
export function initWa(handler: IncomingHandler) {
  onIncoming = handler;
}

const authDir = (tenantId: string) => path.join(config.dataDir, "auth", tenantId);

export function getSession(tenantId: string): Session | undefined {
  return sessions.get(tenantId);
}

export function waStatus(tenantId: string): {
  status: WaStatus;
  qr: string | null;
  phoneMasked: string | null;
} {
  const s = sessions.get(tenantId);
  if (!s) return { status: "idle", qr: null, phoneMasked: null };
  return { status: s.status, qr: s.qr, phoneMasked: s.phone ? maskPhone(s.phone) : null };
}

export async function startSession(tenantId: string): Promise<WaStatus> {
  const existing = sessions.get(tenantId);
  if (existing?.socket) return existing.status;

  const dir = authDir(tenantId);
  fs.mkdirSync(dir, { recursive: true });

  // حالة المصادقة تُحفَظ في ملفات دائمة → لا QR جديد بعد إعادة التشغيل
  const { state, saveCreds } = await useMultiFileAuthState(dir);

  const sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false,
    generateHighQualityLinkPreview: false,
    browser: ["Milano", "Chrome", "1.0"],
    markOnlineOnConnect: false,
  });

  const session: Session = { tenantId, socket: sock, status: "starting", qr: null, phone: null };
  sessions.set(tenantId, session);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      session.qr = qr;
      session.status = "qr";
    }
    if (connection === "connecting") session.status = "connecting";

    if (connection === "open") {
      session.status = "connected";
      session.qr = null;
      try {
        const id = sock.user?.id ?? "";
        session.phone = id.split(":")[0].split("@")[0] || null;
        if (session.phone) {
          db.from("tenants")
            .update({ phone_encrypted: encryptField(session.phone) })
            .eq("id", tenantId)
            .then(() => {});
        }
      } catch {
        /* غير حرج */
      }
    }

    if (connection === "close") {
      session.status = "disconnected";
      session.socket = null;
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        // خرج من الأجهزة المرتبطة → نمسح المفاتيح ليُعاد الربط بـ QR جديد
        fs.rmSync(dir, { recursive: true, force: true });
      } else {
        // إعادة اتصال تلقائية مع تأخير متدرج
        setTimeout(() => {
          startSession(tenantId).catch(() => {});
        }, 4000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify" || !onIncoming) return;
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
        await onIncoming(tenantId, jid, text.trim(), m.key.id ?? null);
      } catch (e) {
        console.error("[wa] message handler error:", e);
      }
    }
  });

  return session.status;
}

export async function sendText(tenantId: string, chatId: string, text: string): Promise<void> {
  const s = sessions.get(tenantId);
  if (!s?.socket || s.status !== "connected") {
    throw new Error("واتساب غير متصل حاليًا — أعد الربط من اللوحة");
  }
  await s.socket.sendMessage(chatId, { text });
}

export async function stopSession(tenantId: string, logout: boolean): Promise<void> {
  const s = sessions.get(tenantId);
  if (s?.socket) {
    try {
      if (logout) await s.socket.logout();
      else await s.socket.end(undefined);
    } catch {
      /* نتجاهل أخطاء الإنهاء */
    }
  }
  if (logout) {
    fs.rmSync(authDir(tenantId), { recursive: true, force: true });
    sessions.delete(tenantId);
  } else if (s) {
    s.socket = null;
    s.status = "disconnected";
  }
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
      startSession(id).catch((e) => console.error(`[wa] restore ${id} failed:`, e));
    }
  }
}
