/**
 * مساعدات إرسال/قراءة رسائل Messenger و Instagram عبر Graph API.
 *
 * يدعم نوعين من رموز Instagram:
 *  - Instagram Login (الجديد): رمز يبدأ بـ "IG" ويُستخدم مع graph.instagram.com
 *  - Facebook Login (القديم): رمز صفحة/مستخدم يبدأ بـ "EAA" ويُستخدم مع graph.facebook.com
 * التمييز بالبادئة يتم هنا فقط حتى لا يحتاج المخطط (schema) لأي عمود جديد.
 */

export const FB_GRAPH = "https://graph.facebook.com/v21.0";
export const IG_GRAPH = "https://graph.instagram.com/v21.0";

export function isInstagramLoginToken(token: string): boolean {
  return token.startsWith("IG");
}

export async function sendMetaDirectMessage(opts: {
  channel: "facebook" | "instagram";
  externalId: string;
  token: string;
  recipientId: string;
  text: string;
}): Promise<void> {
  const { channel, externalId, token, recipientId, text } = opts;
  const payload = { recipient: { id: recipientId }, message: { text } };

  let url: string;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  let body: Record<string, unknown> = payload;

  if (channel === "instagram" && isInstagramLoginToken(token)) {
    url = `${IG_GRAPH}/me/messages`;
    headers.Authorization = `Bearer ${token}`;
  } else {
    url =
      channel === "instagram"
        ? `${FB_GRAPH}/${externalId}/messages`
        : `${FB_GRAPH}/me/messages`;
    body = { ...payload, access_token: token };
  }

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message ?? `Graph API HTTP ${res.status}`);
}

/** رابط جلب اسم/صورة المرسل */
export function senderProfileUrl(
  channel: "facebook" | "instagram",
  senderId: string,
  token: string
): string {
  const t = encodeURIComponent(token);
  if (channel === "instagram") {
    return isInstagramLoginToken(token)
      ? `${IG_GRAPH}/${senderId}?fields=name,username,profile_pic&access_token=${t}`
      : `${FB_GRAPH}/${senderId}?fields=name,profile_picture&access_token=${t}`;
  }
  return `${FB_GRAPH}/${senderId}?fields=name,picture&access_token=${t}`;
}
