/**
 * Helpers for sending/reading Messenger and Instagram messages via Graph API.
 *
 * Instagram supports two authentication flows:
 *
 * 1) Instagram Login:
 *    - token usually starts with "IG"
 *    - uses graph.instagram.com
 *
 * 2) Facebook Login for Instagram API:
 *    - Page/User access token usually starts with "EAA"
 *    - uses graph.facebook.com
 *
 * IMPORTANT:
 * For Facebook Login → Instagram API, `externalId` must be the
 * Instagram Professional Account ID when sending an Instagram message.
 */

export const FB_GRAPH = "https://graph.facebook.com/v21.0";
export const IG_GRAPH = "https://graph.instagram.com/v21.0";

export function isInstagramLoginToken(token: string): boolean {
  return token.startsWith("IG");
}

type SendMetaDirectMessageOptions = {
  channel: "facebook" | "instagram";
  externalId: string;
  token: string;
  recipientId: string;
  text: string;
};

/**
 * Send a direct message through Facebook/Instagram Graph API.
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

  /* Instagram Login */
  if (channel === "instagram" && isInstagramLoginToken(token)) {
    url = `${IG_GRAPH}/me/messages`;
    headers = { ...headers, Authorization: `Bearer ${token}` };
    body = payload;
  }
  /* Facebook Login → Instagram API */
  else if (channel === "instagram") {
    if (!externalId) {
      throw new Error(
        "Missing Instagram Business Account ID for Instagram message sending"
      );
    }
    url = `${FB_GRAPH}/${externalId}/messages`;
    body = { ...payload, access_token: token };
  }
  /* Facebook Messenger */
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
 * Build a URL for retrieving the sender profile.
 *
 * For Instagram Login we request:
 *   name, username, profile_pic
 *
 * For Facebook Login → Instagram we request:
 *   name, profile_picture (this flow does not expose `username`)
 *
 * For Messenger:
 *   name, picture
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
 * Extract a normalized profile from whatever Graph API returns.
 * Returns { name, avatar } where both may be null.
 */
export function parseSenderProfile(pj: any): {
  name: string | null;
  avatar: string | null;
} {
  if (!pj) return { name: null, avatar: null };

  const name =
    (typeof pj.name === "string" && pj.name) ||
    (typeof pj.username === "string" && `@${pj.username}`) ||
    null;

  const avatar =
    (typeof pj.profile_pic === "string" && pj.profile_pic) ||
    (typeof pj.profile_picture === "string" && pj.profile_picture) ||
    (typeof pj.picture?.data?.url === "string" && pj.picture.data.url) ||
    null;

  return { name, avatar };
}
