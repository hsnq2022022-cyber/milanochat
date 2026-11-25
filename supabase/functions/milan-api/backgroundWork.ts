/**
 * Best-effort background execution for NON-CRITICAL webhook work (R1).
 *
 * Only work that is not needed for message acceptance may be handed to this
 * helper (sender-profile enrichment). Durable ingress, routing and the 503
 * retry decision are always awaited by the caller BEFORE this runs.
 *
 * Contract:
 *  - Jobs run sequentially inside ONE promise that never rejects: each job is
 *    isolated by try/catch and a failure is reported with a fixed category only
 *    (never an error message, stack, URL, token or identifier).
 *  - If a `waitUntil` is available (Supabase Edge Runtime
 *    `EdgeRuntime.waitUntil`) the promise is registered with it and this
 *    function returns immediately ("background").
 *  - If it is not available, or registering throws, the jobs are awaited
 *    inline ("inline"), i.e. the previous behaviour. Nothing is dropped.
 *  - Losing a background job at instance shutdown is acceptable by design:
 *    the enrichment is optional and is retried on the customer's next message.
 */
export type WaitUntil = (promise: Promise<unknown>) => void;
export type BackgroundMode = "none" | "background" | "inline";

export function failureCategory(e: unknown): "timeout" | "network" | "unknown" {
  try {
    const n = typeof e === "object" && e !== null ? (e as { name?: unknown }).name : undefined;
    if (n === "AbortError" || n === "TimeoutError") return "timeout";
    if (n === "TypeError") return "network";
  } catch { /* hostile error object */ }
  return "unknown";
}

export async function runBackgroundJobs(
  jobs: ReadonlyArray<() => Promise<unknown>>,
  waitUntil: WaitUntil | null | undefined,
  warn: (message: string, fields: Record<string, unknown>) => void = (m, f) => console.warn(m, f),
): Promise<BackgroundMode> {
  if (jobs.length === 0) return "none";
  const work: Promise<void> = (async () => {
    for (const job of jobs) {
      try {
        await job();
      } catch (e) {
        try { warn("[instagram_webhook] background_task_failed", { category: failureCategory(e) }); } catch { /* never throws */ }
      }
    }
  })().catch(() => { /* unreachable: every job is isolated; keep the promise non-rejecting */ });

  if (typeof waitUntil === "function") {
    try {
      waitUntil(work);
      return "background";
    } catch {
      /* registering failed: fall through and await inline so work is not lost */
    }
  }
  await work;
  return "inline";
}
