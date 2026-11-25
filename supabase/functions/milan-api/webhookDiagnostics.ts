/**
 * Fixed-field diagnostics for webhook requests whose X-Hub-Signature-256 did
 * not verify. Pure and total: it never throws and never returns a value taken
 * from the payload or the signature. Every output is a boolean, a bounded
 * count, or one of a closed set of labels, so it is safe to log.
 *
 * Purpose: tell apart event types and the signature header shape of requests
 * that fail verification (for example a second Meta app delivering to the
 * same callback URL) without logging message content, ids, secrets or the
 * signature itself. The input is UNVERIFIED, so everything is clamped.
 */
const MAX_ENTRIES = 20;
const MAX_ITEMS = 50;
const EVENT_KEYS = ["message", "read", "reaction", "postback", "message_edit", "referral", "delivery", "optin"] as const;
const CHANGE_FIELDS = ["messages", "messaging_seen", "messaging_postbacks", "message_reactions", "comments", "mentions", "live_comments"] as const;

export type InvalidSignatureDiagnostics = {
  object: "instagram" | "page" | "other";
  bytes: number;
  signature_header: "absent" | "malformed" | "wellformed";
  entries: number;
  entry_with_messaging: number;
  entry_with_changes: number;
  entry_other: number;
  events: Record<string, number>;
  change_fields: Record<string, number>;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function bump(map: Record<string, number>, key: string) {
  map[key] = (map[key] ?? 0) + 1;
}

export function invalidSignatureDiagnostics(
  raw: string,
  body: unknown,
  signatureHeader: string | null | undefined,
): InvalidSignatureDiagnostics {
  const out: InvalidSignatureDiagnostics = {
    object: "other",
    bytes: 0,
    signature_header: "absent",
    entries: 0,
    entry_with_messaging: 0,
    entry_with_changes: 0,
    entry_other: 0,
    events: {},
    change_fields: {},
  };
  try {
    out.bytes = Math.min(new TextEncoder().encode(String(raw)).length, 1_000_000);
    if (typeof signatureHeader === "string" && signatureHeader.length > 0) {
      out.signature_header = /^sha256=[0-9a-f]{64}$/i.test(signatureHeader) ? "wellformed" : "malformed";
    }
    if (!isRecord(body)) return out;
    if (body.object === "instagram" || body.object === "page") out.object = body.object;
    const entries = Array.isArray(body.entry) ? body.entry : [];
    out.entries = Math.min(entries.length, MAX_ENTRIES);
    let scanned = 0;
    for (const entry of entries.slice(0, MAX_ENTRIES)) {
      if (!isRecord(entry)) { out.entry_other++; continue; }
      let known = false;
      if (Array.isArray(entry.messaging)) {
        known = true;
        out.entry_with_messaging++;
        for (const item of entry.messaging) {
          if (scanned++ >= MAX_ITEMS) break;
          if (!isRecord(item)) { bump(out.events, "other"); continue; }
          const hit = EVENT_KEYS.filter((k) => k in item);
          if (hit.length === 0) bump(out.events, "other");
          for (const k of hit) bump(out.events, k);
        }
      }
      if (Array.isArray(entry.changes)) {
        known = true;
        out.entry_with_changes++;
        for (const ch of entry.changes) {
          if (scanned++ >= MAX_ITEMS) break;
          const f = isRecord(ch) ? ch.field : undefined;
          bump(out.change_fields,
            typeof f === "string" && (CHANGE_FIELDS as readonly string[]).includes(f) ? f : "other");
        }
      }
      if (!known) out.entry_other++;
    }
  } catch {
    // Total by design: diagnostics must never affect the webhook response.
  }
  return out;
}
