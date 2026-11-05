/**
 * READ-ONLY Flow (V3/V4) review helpers for flow-delivery-review.
 * Pure: no Deno/npm imports, so it is testable under node --experimental-strip-types.
 * Every query is scoped with .eq("tenant_id", tenantId) for the owner-verified tenant.
 */
// deno-lint-ignore no-explicit-any
type Query = any;
export type ReviewClient = { from(table: string): Query };
type Result = { data?: unknown; error?: unknown; count?: number | null };

export const RUN_STATUSES = ["ready", "awaiting_input", "sleeping", "handoff", "completed", "blocked"] as const;
export const ATTENTION_RUN_STATUSES = ["awaiting_input", "sleeping", "handoff", "blocked"] as const;
export const FAILED_OUTBOX_STATUSES = ["uncertain", "dead_letter", "billing_blocked"] as const;
// Internal (non-provider) actions; same kind names as INTERNAL_KINDS in
// supabase/functions/flow-internal-worker/internalEffects.ts. Shown to the owner in their
// in-flight and finished states too (failure states already come through flowFailures).
export const INTERNAL_EFFECT_KINDS = ["tag", "untag", "staff_notification", "handoff"] as const;
export const INTERNAL_VIEW_STATUSES = ["pending", "leased", "retry_wait", "settled", "cancelled"] as const;
export const INTERNAL_VIEW_LIMIT = 100;
const ATTEMPT_STATUSES = ["attempting", "confirmed", "uncertain"];
const REVIEW_STATUSES = ["none", "queued", "resolved"];
const OUTBOX_STATUSES = ["pending", "retry_wait", "leased", "uncertain", "charge_pending", "settled",
  "billing_blocked", "dead_letter", "cancelled"];
const EFFECT_KINDS = ["message", "question", "delay", "handoff", "tag", "untag", "staff_notification"];
const PLATFORMS = ["instagram", "facebook", "whatsapp"];

// Column lists come from supabase/migrations/20261028226000_flow_outbox_delivery_attempts.sql,
// tests/sql/fixtures/installed-flow-runtime.sql and 20261029130000_flow_run_lifecycle.sql.
// Payload / variables / lease tokens are deliberately never selected.
export const ATTEMPT_COLUMNS =
  "outbox_id,claim_id,status,provider_message_id,attempted_at,uncertain_at,review_status,review_requested_at";
export const OUTBOX_BASE_COLUMNS = "id,run_id,effect_kind,delivery_status,attempts,retry_at,created_at";
export const OUTBOX_LIFECYCLE_COLUMNS = OUTBOX_BASE_COLUMNS + ",cancel_reason,cancelled_at";
export const RUN_BASE_COLUMNS = "id,flow_key,platform,run_status,wake_at,updated_at";
export const RUN_LIFECYCLE_COLUMNS = RUN_BASE_COLUMNS + ",ended_reason,ended_at";

const str = (v: unknown, max = 255) => typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
const oneOf = (v: unknown, allowed: readonly string[]) => typeof v === "string" && allowed.includes(v) ? v : null;
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : 0;
const rowsOf = (v: unknown) => Array.isArray(v) ? v.filter(r => r && typeof r === "object") as Record<string, unknown>[] : [];

export function mapAttempt(r: Record<string, unknown>) {
  const outbox_id = str(r.outbox_id, 64), status = oneOf(r.status, ATTEMPT_STATUSES);
  if (!outbox_id || !status) return null;
  return {
    outbox_id, claim_id: str(r.claim_id, 64), status,
    provider_message_id: str(r.provider_message_id), attempted_at: str(r.attempted_at, 64),
    uncertain_at: str(r.uncertain_at, 64), review_status: oneOf(r.review_status, REVIEW_STATUSES) ?? "none",
    review_requested_at: str(r.review_requested_at, 64),
  };
}
export function mapOutbox(r: Record<string, unknown>) {
  const id = str(r.id, 64), delivery_status = oneOf(r.delivery_status, OUTBOX_STATUSES);
  if (!id || !delivery_status) return null;
  return {
    id, run_id: str(r.run_id, 64), effect_kind: oneOf(r.effect_kind, EFFECT_KINDS), delivery_status,
    attempts: num(r.attempts), retry_at: str(r.retry_at, 64), created_at: str(r.created_at, 64),
    cancel_reason: str(r.cancel_reason, 64), cancelled_at: str(r.cancelled_at, 64),
  };
}
export function mapRun(r: Record<string, unknown>) {
  const id = str(r.id, 64), run_status = oneOf(r.run_status, RUN_STATUSES);
  if (!id || !run_status) return null;
  return {
    id, flow_key: str(r.flow_key, 128), platform: oneOf(r.platform, PLATFORMS) ?? "unknown", run_status,
    wake_at: str(r.wake_at, 64), updated_at: str(r.updated_at, 64),
    ended_reason: str(r.ended_reason, 64), ended_at: str(r.ended_at, 64),
  };
}
/** mapOutbox restricted to internal kinds in the internal view statuses (defence in depth). */
export function mapInternal(r: Record<string, unknown>) {
  const m = mapOutbox(r);
  if (!m || !m.effect_kind) return null;
  if (!(INTERNAL_EFFECT_KINDS as readonly string[]).includes(m.effect_kind)) return null;
  if (!(INTERNAL_VIEW_STATUSES as readonly string[]).includes(m.delivery_status)) return null;
  return m;
}
const mapAll = <T>(rows: unknown, fn: (r: Record<string, unknown>) => T | null) =>
  rowsOf(rows).map(fn).filter((x): x is T => x !== null);

/** Selects with lifecycle columns first; falls back to base columns if they are not installed. */
async function selectDefensive(sb: ReviewClient, table: string, cols: string[],
  shape: (q: Query) => Query): Promise<Result> {
  let last: Result = { data: null, error: "unavailable" };
  for (const c of cols) {
    last = await shape(sb.from(table).select(c));
    if (!last.error) return last;
  }
  return last;
}

export async function loadFlowReview(sb: ReviewClient, tenantId: string) {
  const attemptsQ = sb.from("automation_flow_delivery_attempts").select(ATTEMPT_COLUMNS)
    .eq("tenant_id", tenantId).or("status.eq.uncertain,review_status.eq.queued")
    .order("attempted_at", { ascending: false }).limit(100);
  const outboxQ = selectDefensive(sb, "automation_flow_outbox", [OUTBOX_LIFECYCLE_COLUMNS, OUTBOX_BASE_COLUMNS],
    q => q.eq("tenant_id", tenantId).in("delivery_status", [...FAILED_OUTBOX_STATUSES])
      .order("created_at", { ascending: false }).limit(100));
  // Internal actions (no payload selected: tag values / notification text never leave the DB).
  const internalQ = selectDefensive(sb, "automation_flow_outbox", [OUTBOX_LIFECYCLE_COLUMNS, OUTBOX_BASE_COLUMNS],
    q => q.eq("tenant_id", tenantId).in("effect_kind", [...INTERNAL_EFFECT_KINDS])
      .in("delivery_status", [...INTERNAL_VIEW_STATUSES])
      .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(INTERNAL_VIEW_LIMIT));
  const runsQ = selectDefensive(sb, "automation_flow_runs", [RUN_LIFECYCLE_COLUMNS, RUN_BASE_COLUMNS],
    q => q.eq("tenant_id", tenantId).in("run_status", [...ATTENTION_RUN_STATUSES])
      .order("updated_at", { ascending: false }).limit(50));
  const countQs = RUN_STATUSES.map(s => sb.from("automation_flow_runs")
    .select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("run_status", s));
  const [attempts, outbox, runs, internal, ...counts] =
    await Promise.all([attemptsQ, outboxQ, runsQ, internalQ, ...countQs]) as Result[];
  const runCounts: Record<string, number> = {};
  let countsOk = true;
  RUN_STATUSES.forEach((s, i) => {
    const c = counts[i];
    if (c?.error || typeof c?.count !== "number") countsOk = false;
    runCounts[s] = typeof c?.count === "number" ? c.count : 0;
  });
  return {
    flowItems: attempts.error ? [] : mapAll(attempts.data, mapAttempt),
    flowFailures: outbox.error ? [] : mapAll(outbox.data, mapOutbox),
    flowRuns: runs.error ? [] : mapAll(runs.data, mapRun),
    runCounts,
    flowAvailable: !attempts.error && !outbox.error && !runs.error && countsOk,
    // Additive: internal actions in pending/leased/retry_wait/settled/cancelled. Separate from
    // flowFailures so existing consumers keep their "failures only" semantics.
    flowInternal: internal.error ? [] : mapAll(internal.data, mapInternal).slice(0, INTERNAL_VIEW_LIMIT),
    flowInternalAvailable: !internal.error,
  };
}
