/**
 * نظام القنوات الموحّد — WhatsApp / Instagram / Facebook Messenger
 * مصدر واحد للأيقونات والألوان والتسميات في الموقع التعريفي ولوحة التحكم.
 */
import type { ReactNode } from "react";

export type ChannelId = "whatsapp" | "instagram" | "facebook";

export interface ChannelMeta {
  id: ChannelId;
  label: string;          // الاسم العربي للقناة
  badge: string;          // نص الشارة الصغيرة
  color: string;          // لون التمييز (hex)
  bgClass: string;        // خلفية خفيفة للشارة
  textClass: string;      // لون النص المطابق
  borderClass: string;    // حدود ناعمة
  icon: ReactNode;
  note: string;           // ملاحظة Meta الرسمية المختصرة
}

/* أيقونات المنصات الأصلية (SVG paths رسمية مبسطة) */
const IconWhatsApp = ({ className = "w-4 h-4" }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.732a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" />
  </svg>
);

const IconInstagram = ({ className = "w-4 h-4" }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
    <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z" />
  </svg>
);

const IconFacebookMessenger = ({ className = "w-4 h-4" }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
    <path d="M12 0C5.233 0 0 5.134 0 11.867c0 2.644.885 5.093 2.408 7.084.157.203.204.462.127.705l-.793 2.486a.527.527 0 00.656.66l2.663-.845a.705.705 0 01.535.038 11.7 11.7 0 006.402 1.901c6.635 0 11.8-5.133 11.8-11.866C24 5.134 18.635 0 12 0zm6.943 8.84l-3.27 5.2C12.83 16.113 11.553 16.6 10.2 16.6c-1.353 0-2.63-.487-3.473-2.56l-.217-.447 3.44-2.035a.4.4 0 01.486.046l2.02 2.02a.6.6 0 00.84 0l3.02-3.02a.4.4 0 01.63.476z" />
  </svg>
);

export const CHANNELS: Record<ChannelId, ChannelMeta> = {
  whatsapp: {
    id: "whatsapp",
    label: "واتساب",
    badge: "WhatsApp",
    color: "#25D366",
    bgClass: "bg-[#25D366]/10",
    textClass: "text-[#25D366]",
    borderClass: "border-[#25D366]/30",
    icon: <IconWhatsApp />,
    note: "الربط يعتمد على WhatsApp Business Platform (Cloud API) من Meta، والرسوم وسياسات المراسلة تخضع لشروط Meta.",
  },
  instagram: {
    id: "instagram",
    label: "إنستغرام",
    badge: "Instagram",
    color: "#E1306C",
    bgClass: "bg-[#E1306C]/10",
    textClass: "text-[#E1306C]",
    borderClass: "border-[#E1306C]/30",
    icon: <IconInstagram />,
    note: "دعم المراسلة يتطلب حساب Instagram احترافياً مؤهلاً وصلاحيات Meta المناسبة.",
  },
  facebook: {
    id: "facebook",
    label: "فيسبوك",
    badge: "Facebook",
    color: "#1877F2",
    bgClass: "bg-[#1877F2]/10",
    textClass: "text-[#1877F2]",
    borderClass: "border-[#1877F2]/30",
    icon: <IconFacebookMessenger />,
    note: "المراسلة مرتبطة بصفحات Facebook المؤهلة وصلاحيات التطبيق المعتمدة.",
  },
};

export const CHANNEL_LIST: ChannelMeta[] = [
  CHANNELS.whatsapp,
  CHANNELS.instagram,
  CHANNELS.facebook,
];

/** اشتقاق القناة من معرّف المحادثة أو رقم الهاتف أو صراحةً من حقل channel */
export function detectChannel(
  c: { channel?: string; wa_chat_id?: string; customer_phone?: string } | null | undefined
): ChannelId {
  if (!c) return "whatsapp";
  if (c.channel === "instagram" || c.channel === "facebook" || c.channel === "whatsapp") {
    return c.channel as ChannelId;
  }
  const id = `${c.wa_chat_id ?? ""}${c.customer_phone ?? ""}`;
  if (/^ig:/i.test(id)) return "instagram";
  if (/^(fb:|messenger:)/i.test(id)) return "facebook";
  return "whatsapp";
}

/** شارة صغيرة للقناة تُستخدم في قائمة المحادثات ورأس الدردشة */
export function ChannelBadge({ channel, compact = false }: { channel: ChannelId; compact?: boolean }) {
  const meta = CHANNELS[channel];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold ${meta.bgClass} ${meta.textClass} ${meta.borderClass}`}
      title={meta.label}
    >
      <span className="w-3 h-3 shrink-0">{meta.icon}</span>
      {!compact && meta.badge}
    </span>
  );
}
