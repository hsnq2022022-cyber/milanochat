/**
 * PURE (no env, no IO). Which channel accounts the advanced (durable) Flow
 * engine may serve, as configured by the operator secret
 * FLOW_DURABLE_CANARY_ACCOUNT_ID.
 *
 * Historically that secret held ONE account id, so only one account in the
 * whole system could ever run advanced flows. It now accepts either
 *   - one account id (exactly the previous behaviour), or
 *   - a comma-separated allowlist of account ids (a staged rollout).
 *
 * This is ONE of several independent gates, never the only one. A message is
 * still served only if, per tenant, ALL of these hold (each fails closed):
 *   1. this allowlist contains the exact channel account id;
 *   2. the operator registered (tenant, account, platform) in
 *      automation_flow_canary_accounts (SQL: PRIMARY KEY (tenant_id,platform),
 *      writable only by an operator database session, never by an Edge
 *      Function; flow_claim_inbound_durable re-verifies it per event);
 *   3. global switch ON, tenant switch ON + production_approved;
 *   4. an active, supported publication for that exact account;
 *   5. the per-feature operator flags (buttons, delay, images, internal
 *      actions, AI step, ...) and the worker release gate.
 *
 * Rollout of a new customer: register the tenant/account row (2) AND add the
 * account id here (1). Rollback of one customer: remove the id (immediate for
 * every Edge Function on its next invocation) and/or delete the registry row
 * (stops new durable claims at once; V2 / AI keep answering). Rolling back
 * everyone: unset the secret or set FLOW_DURABLE_INGRESS_ENABLED=false.
 *
 * Fail closed: not a string, empty, more than MAX entries, or ANY malformed
 * entry (empty item, bad characters) invalidates the WHOLE list, so a typo can
 * never silently widen or half-apply the rollout.
 */
/** Staged rollout ceiling: room for ~100 customers with up to two channel accounts each (200 uuids = ~7.4 kB of secret).
 *  Still fail-closed beyond it; each account additionally needs its operator-written registry row and tenant switches. */
export const DURABLE_ACCOUNT_ALLOWLIST_MAX=200;
const ENTRY=/^[A-Za-z0-9_-]{1,64}$/; // channel_accounts.id (uuid) fits; no whitespace, no wildcards

/** The allowed ids, or null when the value is missing or malformed. */
export function parseDurableAccountAllowlist(raw:unknown):ReadonlySet<string>|null{
 if(typeof raw!=="string")return null;
 const parts=raw.split(",").map(p=>p.trim());
 if(parts.length===0||parts.length>DURABLE_ACCOUNT_ALLOWLIST_MAX)return null;
 for(const p of parts)if(!ENTRY.test(p))return null;
 return new Set(parts);
}

/** True only for an exact, case-sensitive member of a valid allowlist. */
export function durableAccountAllowed(raw:unknown,accountId:unknown):boolean{
 if(typeof accountId!=="string"||accountId.length===0)return false;
 const list=parseDurableAccountAllowlist(raw);
 return list!==null&&list.has(accountId);
}
