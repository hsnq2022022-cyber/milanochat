/**
 * Server-side operator allowlist for flow-publication (pure: no Deno globals,
 * no imports; Node-testable). Never import this from src/ (browser bundle).
 *
 * FLOW_OPERATOR_USER_IDS: comma-separated Supabase Auth user UUIDs, read by
 * the handler from the Edge env on EVERY request (rotation needs no restart).
 * The whole list is rejected (fail closed: nobody is an operator) when it is
 * missing, empty, too long, has too many entries, an empty segment, the nil
 * UUID or any entry that is not a strict 8-4-4-4-12 hex UUID. There is never
 * partial acceptance.
 *
 * Identity is ONLY the verified auth user id (client.auth.getUser(jwt)).
 * Request-body ids, headers, email, user/app metadata, tenant ownership and
 * tenant_staff roles never make anyone an operator.
 *
 * LIMITATION (by design): being an operator does NOT grant cross-tenant
 * access. An operator still resolves the tenant only by tenants.user_id =
 * their own auth id, and every action stays scoped to that tenant and its
 * accounts exactly as for any owner. Cross-tenant operator tooling would be a
 * future separate design.
 */

/** Strict, versionless 8-4-4-4-12 hex UUID (compared after lowercasing). */
const OPERATOR_UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NIL_UUID="00000000-0000-0000-0000-000000000000";
export const OPERATOR_ALLOWLIST_MAX_LENGTH=4096;
export const OPERATOR_ALLOWLIST_MAX_ENTRIES=50;

export type OperatorAllowlist={ok:true;ids:ReadonlySet<string>}|{ok:false};

/**
 * Actions any authenticated tenant owner may call (no allowlist). Everything
 * else (readiness, catalog, read, list, legacy publish, activate, rollback and
 * any unknown, future, missing or non-string action) needs an operator.
 * `deactivate` is the owner's emergency stop: still scoped to the caller's own
 * tenant/account by the handler and the DB function.
 */
export const CUSTOMER_ACTIONS:ReadonlySet<string>=new Set([
 "accounts","capabilities","publish_live","deactivate","operator_status"
]);

export function isCustomerAction(action:unknown):boolean{
 return typeof action==="string"&&CUSTOMER_ACTIONS.has(action);
}

export function parseOperatorAllowlist(raw:string|undefined|null):OperatorAllowlist{
 if(typeof raw!=="string")return {ok:false};
 if(raw.length===0||raw.length>OPERATOR_ALLOWLIST_MAX_LENGTH)return {ok:false};
 const parts=raw.split(",");
 if(parts.length>OPERATOR_ALLOWLIST_MAX_ENTRIES)return {ok:false};
 const ids=new Set<string>();
 for(const part of parts){
  const id=part.trim().toLowerCase();
  if(id.length===0||!OPERATOR_UUID.test(id)||id===NIL_UUID)return {ok:false};
  ids.add(id);
 }
 return ids.size>0?{ok:true,ids}:{ok:false};
}

export function isOperator(userId:unknown,parsed:OperatorAllowlist):boolean{
 if(!parsed||parsed.ok!==true||typeof userId!=="string")return false;
 return parsed.ids.has(userId.toLowerCase());
}
