/**
 * generate-flow: credit port (reserve BEFORE the LLM, commit on success,
 * release on any failure), backed by migration
 * 20261029310000_flow_ai_generations (service_role-only SECURITY DEFINER RPCs,
 * tenant row locked FOR UPDATE, credits in tenants.credits_remaining).
 * Until that migration is applied every RPC call errors and the handler fails
 * CLOSED (no charge, no LLM call). FLOW_AI_BUILDER_ENABLED is default OFF.
 *
 *   flow_ai_generation_reserve(p_tenant_id uuid, p_request_id uuid,
 *     p_prompt_sha256 text, p_cost integer) -> jsonb {status, document?, remaining?}
 *     first releases this tenant's reservations older than 180 s, then:
 *     reserved | in_flight | cached(+document) | no_credit | mismatch | invalid
 *   flow_ai_generation_commit(p_tenant_id, p_request_id, p_document jsonb)
 *     -> committed | already | not_reserved
 *   flow_ai_generation_release(p_tenant_id, p_request_id) -> released | noop
 */
export const FLOW_AI_COST = 5;

export type ReserveOutcome =
  | { status: "reserved" }
  | { status: "cached"; document: unknown }
  | { status: "in_flight" }
  | { status: "no_credit" }
  | { status: "mismatch" }
  | { status: "invalid" };
export type CommitOutcome = "committed" | "already" | "not_reserved";
export type ReleaseOutcome = "released" | "noop";

export interface CreditPort {
  reserve(tenantId: string, requestId: string, promptSha256: string, cost: number): Promise<ReserveOutcome>;
  commit(tenantId: string, requestId: string, document: unknown): Promise<CommitOutcome>;
  release(tenantId: string, requestId: string): Promise<ReleaseOutcome>;
}

export type RpcClient = {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
};

export class CreditError extends Error { constructor() { super("credit_rpc"); } }

const RESERVE_STATUSES = new Set(["reserved", "cached", "in_flight", "no_credit", "mismatch", "invalid"]);

export function supabaseCreditPort(client: RpcClient): CreditPort {
  return {
    async reserve(tenantId, requestId, promptSha256, cost) {
      const { data, error } = await client.rpc("flow_ai_generation_reserve", {
        p_tenant_id: tenantId, p_request_id: requestId, p_prompt_sha256: promptSha256, p_cost: cost,
      });
      const d = data as { status?: unknown; document?: unknown } | null;
      if (error || !d || typeof d.status !== "string" || !RESERVE_STATUSES.has(d.status)) throw new CreditError();
      if (d.status === "cached") return { status: "cached", document: d.document };
      return { status: d.status } as ReserveOutcome;
    },
    async commit(tenantId, requestId, document) {
      const { data, error } = await client.rpc("flow_ai_generation_commit", {
        p_tenant_id: tenantId, p_request_id: requestId, p_document: document,
      });
      if (error || (data !== "committed" && data !== "already" && data !== "not_reserved")) throw new CreditError();
      return data;
    },
    async release(tenantId, requestId) {
      const { data, error } = await client.rpc("flow_ai_generation_release", {
        p_tenant_id: tenantId, p_request_id: requestId,
      });
      if (error || (data !== "released" && data !== "noop")) throw new CreditError();
      return data;
    },
  };
}
