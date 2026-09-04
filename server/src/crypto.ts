/**
 * تشفير حقلي عند الراحة (AES-256-GCM) للحقول الحساسة:
 * أرقام واتساب، محتوى الرسائل، أسئلة العملاء.
 * الصيغة: enc:v1:<iv hex>:<tag hex>:<ciphertext hex>
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { config } from "./config.js";

const ALGO = "aes-256-gcm";

function key(): Buffer {
  // نشتق مفتاح 32 بايت ثابت الطول حتى لو قُدّم hex أو نص
  return createHash("sha256").update(config.fieldEncryptionKey, "utf8").digest();
}

export function encryptField(plain: string): string {
  if (!plain) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["enc:v1", iv.toString("hex"), tag.toString("hex"), data.toString("hex")].join(":");
}

export function decryptField(stored: string | null | undefined): string {
  if (!stored) return "";
  if (!stored.startsWith("enc:v1:")) return stored; // نص قديم غير مشفر — نعيده كما هو
  const [, , ivHex, tagHex, dataHex] = stored.split(":");
  const decipher = createDecipheriv(ALGO, key(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const out = Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final(),
  ]);
  return out.toString("utf8");
}

/** قناع لعرض الأرقام في الواجهة: 5665XXXXX */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 5) return "••••";
  return digits.slice(0, 4) + "•".repeat(Math.max(0, digits.length - 4));
}
