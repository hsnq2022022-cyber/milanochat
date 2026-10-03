/**
 * مساعدات إرسال/قراءة رسائل Messenger و Instagram عبر Graph API.
 *
 * يدعم نوعين من رموز Instagram:
 *  - Instagram Login (الجديد): رمز يبدأ بـ "IG" ويُستخدم مع graph.instagram.com
 *  - Facebook Login (القديم): رمز صفحة/مستخدم يبدأ بـ "EAA" ويُستخدم مع graph.facebook.com
 *
 * التمييز بين النوعين يتم بالبادئة في هذا الملف فقط، حتى لا نحتاج
 * إلى عمود جديد في قاعدة البيانات.
 *
 * ملاحظة مهمة لتدفق Facebook Login → Instagram API:
 *   `externalId` يجب أن يكون Instagram Professional Account ID (IG_ID)
 *   عند إرسال رسالة Instagram.
 */

export const FB_GRAPH = "https://graph.facebook.com/v21.0";
export const IG_GRAPH = "https://graph.instagram.com/v21.0";

/**
 * هل الرمز من نوع Instagram Login؟ (يبدأ بـ IG)
 */
export function isInstagramLoginToken(token: string): boolean {
  return typeof token === "string" && token.startsWith("IG");
}

type SendMetaDirectMessageOptions = {
  channel: "facebook" | "instagram";
  externalId: string;
  token: string;
  recipientId: string;
  text: string;
};

/**
 * إرسال رسالة مباشرة عبر Facebook/Instagram Graph API.
 */
export async function sendMetaDirectMessage(
  opts: SendMetaDirectMessageOptions
): Promise<void> {
  const { channel, externalId, token, recipientId, text } = opts;

  if (!token) throw new Error("Missing Meta access token");
  if (!recipientId) throw new Error("Missing recipient ID");
  if (!text) throw new Error("Missing message text");

  const payload = {
    recipient: { id: recipientId },
    message: { text },
  };

  let url: string;
  let headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  let body: Record<string, unknown>;

  /* ─── Instagram Login (رموز IG) ─── */
  if (channel === "instagram" && isInstagramLoginToken(token)) {
    url = `${IG_GRAPH}/me/messages`;
    headers = { ...headers, Authorization: `Bearer ${token}` };
    body = payload;
  }
  /* ─── Facebook Login → Instagram API (رموز EAA) ─── */
  else if (channel === "instagram") {
    if (!externalId) {
      throw new Error(
        "Missing Instagram Business Account ID for Instagram message sending"
      );
    }
    url = `${FB_GRAPH}/${externalId}/messages`;
    body = { ...payload, access_token: token };
  }
  /* ─── Facebook Messenger ─── */
  else {
    url = `${FB_GRAPH}/me/messages`;
    body = { ...payload, access_token: token };
  }

  console.log("[MetaSend] Sending message", {
    channel,
    externalId,
    recipientId,
    endpoint: url,
    tokenType:
      channel === "instagram"
        ? isInstagramLoginToken(token)
          ? "instagram-login"
          : "facebook-login-page-token"
        : "facebook",
  });

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const responseText = await res.text();
  let json: any = {};
  try {
    json = responseText ? JSON.parse(responseText) : {};
  } catch {
    json = { raw: responseText };
  }

  if (!res.ok) {
    console.error("[MetaSend] Graph API error", {
      status: res.status,
      statusText: res.statusText,
      endpoint: url,
      error: json?.error ?? json,
    });
    throw new Error(
      json?.error?.message ??
        json?.error?.error_user_msg ??
        `Graph API HTTP ${res.status}`
    );
  }

  console.log("[MetaSend] Message sent successfully", {
    channel,
    externalId,
    recipientId,
    response: json,
  });
}

/**
 * بناء رابط جلب بيانات المرسل (اسم + صورة).
 *
 * - Instagram Login: نطلب name, username, profile_pic
 * - Facebook Login → Instagram: نطلب name, profile_picture (لا يوفّر username)
 * - Messenger: نطلب name, picture
 */
export function senderProfileUrl(
  channel: "facebook" | "instagram",
  senderId: string,
  token: string
): string {
  const encodedToken = encodeURIComponent(token);

  if (channel === "instagram") {
    if (isInstagramLoginToken(token)) {
      return `${IG_GRAPH}/${senderId}?fields=name,username,profile_pic&access_token=${encodedToken}`;
    }
    return `${FB_GRAPH}/${senderId}?fields=name,profile_picture&access_token=${encodedToken}`;
  }

  return `${FB_GRAPH}/${senderId}?fields=name,picture&access_token=${encodedToken}`;
}

/**
 * استخراج بروفايل موحّد من أي استجابة يعيدها Graph API.
 *
 * الأولوية للاسم الكامل (`name`)، وإن لم يتوفر نستخدم اسم المستخدم
 * (`@username`) كبديل. وإن لم يتوفر أي منهما نُعيد null.
 *
 * الصورة: نجرّب `profile_pic` (Instagram Login) ثم `profile_picture`
 * (Facebook Login) ثم `picture.data.url` (Messenger).
 */
export function parseSenderProfile(pj: any): {
  name: string | null;
  avatar: string | null;
} {
  if (!pj || typeof pj !== "object") {
    return { name: null, avatar: null };
  }

  /* ── الاسم ── */
  let name: string | null = null;

  if (typeof pj.name === "string" && pj.name.trim().length > 0) {
    name = pj.name.trim();
  } else if (
    typeof pj.username === "string" &&
    pj.username.trim().length > 0
  ) {
    name = `@${pj.username.trim()}`;
  }

  /* ── الصورة ── */
  let avatar: string | null = null;

  if (typeof pj.profile_pic === "string" && pj.profile_pic.length > 0) {
    avatar = pj.profile_pic;
  } else if (
    typeof pj.profile_picture === "string" &&
    pj.profile_picture.length > 0
  ) {
    avatar = pj.profile_picture;
  } else if (
    typeof pj.picture?.data?.url === "string" &&
    pj.picture.data.url.length > 0
  ) {
    avatar = pj.picture.data.url;
  }

  return { name, avatar };
}
