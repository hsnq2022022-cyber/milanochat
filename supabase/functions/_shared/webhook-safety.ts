/**
 * Webhook authentication and inbound deduplication are deliberately fail-closed.
 * Helpers are compatible with Deno Edge Functions and Node's Web Crypto tests.
 */
export type InboundInsertResult = {
  error: { code?: string; message?: string } | null;
};

export type InboundInsertDecision = "accepted" | "duplicate" | "rejected" | "missing_event_id";

/** لا يُسمح برد تلقائي على حدث لا يحمل معرّفًا ثابتًا من Meta. */
export function classifyInboundInsert(
  stableProviderEventId: string | null,
  result: InboundInsertResult,
): InboundInsertDecision {
  if (
    typeof stableProviderEventId !== "string" ||
    !stableProviderEventId.trim() ||
    stableProviderEventId.length > 256
  ) return "missing_event_id";
  if (!result || !("error" in result)) return "rejected";
  if (!result.error) return "accepted";
  if (result.error.code === "23505") return "duplicate";
  return "rejected";
}

/**
 * Verifies X-Hub-Signature-256 over the EXACT raw request bytes.
 * No configured app secret => unauthorized; never bypass verification.
 */
export async function verifyWebhookHmac(
  rawBody: string,
  signatureHeader: string,
  configuredSecrets: readonly string[],
): Promise<boolean> {
  if (typeof rawBody !== "string" || typeof signatureHeader !== "string" ||
      !/^sha256=[0-9a-f]{64}$/i.test(signatureHeader)) return false;
  const secrets = [...new Set(configuredSecrets.map(value => value.trim()).filter(Boolean))];
  if (secrets.length === 0) return false;

  const receivedHex = signatureHeader.slice(7);
  const signature = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    signature[i] = Number.parseInt(receivedHex.slice(i * 2, i * 2 + 2), 16);
  }
  const encoder = new TextEncoder();
  for (const secret of secrets) {
    try {
      const key = await crypto.subtle.importKey(
        "raw", encoder.encode(secret), {name:"HMAC",hash:"SHA-256"}, false, ["verify"],
      );
      if (await crypto.subtle.verify("HMAC",key,signature,encoder.encode(rawBody))) return true;
    } catch {
      // تجاهل المفتاح التالف فقط؛ لا تتجاوز عملية التحقق.
    }
  }
  return false;
}
