/**
 * Bounded per-stage timing for the inbound webhook path (R1).
 *
 * Pure, dependency-free and total: it never throws and its output contains
 * only a closed set of stage names mapped to non-negative integer milliseconds
 * (clamped). Nothing taken from a request, a payload, a token or a customer can
 * reach it, so the snapshot is always safe to log.
 */
export const STAGES = [
  "verify",       // X-Hub-Signature-256 HMAC check
  "receipts",     // optional signed-receipt storage (flag, default OFF)
  "lookup",       // channel_accounts resolution
  "handle",       // whole handleIncomingWebhookMessage (durable ingress decision)
  "conversation", // inside handle: tenant + conversation resolution
  "persist",      // inside handle: inbound message insert
  "route",        // inside handle: routeInbound (includes durable/claim work)
  "durable",      // inside route: attemptDurableInstagram
  "total",        // handler start -> just before the HTTP response
] as const;
export type Stage = typeof STAGES[number];
export type StageSnapshot = Partial<Record<Stage, number>>;

export const MAX_STAGE_MS = 3_600_000;

export type StageTimer = {
  /** Begin timing `stage`; call the returned function to stop (idempotent). */
  start(stage: Stage): () => void;
  /** Time an async operation into `stage` (also on rejection). */
  span<T>(stage: Stage, fn: () => Promise<T>): Promise<T>;
  /** Accumulated whole milliseconds per recorded stage. */
  snapshot(): StageSnapshot;
};

const clamp = (ms: number): number =>
  Number.isFinite(ms) && ms > 0 ? Math.min(Math.round(ms), MAX_STAGE_MS) : 0;

export function createStageTimer(now: () => number = () => performance.now()): StageTimer {
  const totals: Partial<Record<Stage, number>> = {};
  const known = new Set<string>(STAGES);
  const add = (stage: Stage, ms: number) => {
    if (!known.has(stage)) return;
    totals[stage] = clamp((totals[stage] ?? 0) + (Number.isFinite(ms) ? ms : 0));
  };
  return {
    start(stage) {
      let t0 = 0;
      try { t0 = now(); } catch { /* clock failure: record 0 */ }
      let done = false;
      return () => {
        if (done) return;
        done = true;
        try { add(stage, now() - t0); } catch { /* never throws */ }
      };
    },
    async span(stage, fn) {
      const end = this.start(stage);
      try { return await fn(); } finally { end(); }
    },
    snapshot() {
      const out: StageSnapshot = {};
      for (const s of STAGES) if (s in totals) out[s] = totals[s];
      return out;
    },
  };
}

/** Inert timer for callers that do not collect timings (recovery, WhatsApp). */
export const NOOP_STAGE_TIMER: StageTimer = {
  start: () => () => {},
  span: (_s, fn) => fn(),
  snapshot: () => ({}),
};
