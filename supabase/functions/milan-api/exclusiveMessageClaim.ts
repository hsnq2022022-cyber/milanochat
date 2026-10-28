/** Exclusive Webhook owner. Fail closed on claim storage failure; never send twice. */
export type Route = "legacy_ai" | "flow";
export type Claimed = {
  acquired: boolean;
  route: Route;
  outgoing_message_id: string;
};
export type Result =
  | "duplicate" | "claim_failed" | "empty" | "sent_and_billed"
  | "sent_billing_failed" | "sent_persist_failed" | "send_failed";

export type Dependencies = {
  prepareFlow(): Promise<string | null>;
  claim(engineReady: boolean): Promise<Claimed | null>;
  legacyAnswer(): Promise<string | null>;
  send(text: string): Promise<void>;
  persistSent(messageId: string, text: string): Promise<boolean>;
  debit(messageId: string): Promise<number>;
};

/**
 * At most ONE network send per committed claim. No automatic retry after an
 * ambiguous network error: Meta may have accepted the original request.
 * This is at-most-once attempt, NOT end-to-end guaranteed delivery.
 * Missing/failed DB claim blocks sends rather than bypassing the mutex.
 */
export async function processExclusiveEvent(d: Dependencies): Promise<Result> {
  let prepared: string | null = null;
  try { prepared = await d.prepareFlow(); } catch { prepared = null; }
  let c: Claimed | null;
  try { c = await d.claim(Boolean(prepared)); }
  catch { return "claim_failed"; }
  if (!c || !["legacy_ai", "flow"].includes(c.route) ||
      typeof c.outgoing_message_id !== "string") return "claim_failed";
  if (!c.acquired) return "duplicate";

  let reply: string | null;
  try {
    // Flow preparation is completed BEFORE the exclusive claim. A broken
    // engine falls back to legacy and the stored claim chooses legacy.
    reply = c.route === "flow" && prepared ? prepared : await d.legacyAnswer();
  } catch {
    return "empty";
  }
  if (!reply?.trim()) return "empty";
  try { await d.send(reply.trim()); }
  catch { return "send_failed"; }
  let persisted = false;
  try { persisted = await d.persistSent(c.outgoing_message_id, reply.trim()); }
  catch { /* Not safe to send again after an external provider accepted. */ }
  if (!persisted) return "sent_persist_failed";
  try {
    const debit = await d.debit(c.outgoing_message_id);
    // Existing RPC contract: >=0 success, -2 already charged, -1 no credit,
    // -3 ownership failure. Only -2 is idempotent billing success.
    return Number.isInteger(debit) && (debit >= 0 || debit === -2)
      ? "sent_and_billed" : "sent_billing_failed";
  } catch { return "sent_billing_failed"; }
}
