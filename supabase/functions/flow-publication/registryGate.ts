/**
 * Publication <-> runtime agreement for the durable rollout.
 *
 * The runtime claims an inbound event for the durable Flow engine only when
 * BOTH hold: (1) the account is in the FLOW_DURABLE_CANARY_ACCOUNT_ID
 * allowlist (TypeScript gate) and (2) the operator registered exactly
 * (tenant, account, platform) in automation_flow_canary_accounts
 * (flow_claim_inbound_durable re-checks it per event, in SQL).
 *
 * Publication used to check only (1). An allowlisted account WITHOUT a
 * registry row therefore showed a Flow as "live" while the runtime never
 * started it and the AI answered. This module reads the same registry
 * (service_role has SELECT only) so publication refuses to report "live"
 * unless the runtime will really accept the account.
 *
 * SUPPORT MODEL. The registry key is PRIMARY KEY (tenant_id, platform): AT MOST
 * ONE durable account per tenant and platform. This is deliberate and is NOT
 * changed here (no migration). A second allowlisted account of the same tenant
 * and platform can never be registered, so publication reports it as
 * "another_account" with an explicit reason instead of implying it works.
 * Different tenants each have their own row, so several tenants (one account
 * each) work side by side.
 *
 * Read-only, tenant/account/platform scoped, fails closed ("unavailable").
 */
import {durableRegistryStatus,registryRequired,type RegistryStatus,type RegistryScope} from "../_shared/durableRegistry.ts";
export {durableRegistryStatus,registryRequired};
export type {RegistryStatus,RegistryScope};

export const REGISTRY_MISSING_CODE="FLOW_DURABLE_REGISTRY_MISSING";
export const REGISTRY_ANOTHER_ACCOUNT_CODE="FLOW_DURABLE_REGISTRY_OTHER_ACCOUNT";
export const REGISTRY_UNAVAILABLE_CODE="FLOW_DURABLE_REGISTRY_UNAVAILABLE";

/** Arabic, customer-safe: no env names, no ids. */
export const REGISTRY_MESSAGES:Record<"missing"|"another_account",string>={
 missing:"هذا الحساب غير مفعّل بعد للمسارات المتقدمة لدى فريق الإدارة، لذلك لم يتم تشغيل المسار. تواصل مع الدعم لتفعيله ثم أعد المحاولة.",
 another_account:"المسارات المتقدمة مفعّلة حالياً لحساب آخر في نشاطك على هذه المنصة، ويدعم النظام حساباً واحداً فقط لكل نشاط ومنصة. لم يتم تشغيل المسار على هذا الحساب."
};

/** HTTP result for a non-registered status, or null when registered. */
export function registryFailure(status:RegistryStatus):{status:number;body:{ok:false;error:string;code?:string}}|null{
 if(status==="registered")return null;
 if(status==="unavailable")return {status:503,body:{ok:false,error:"Registry check unavailable",code:REGISTRY_UNAVAILABLE_CODE}};
 return {status:409,body:{ok:false,error:REGISTRY_MESSAGES[status],
  code:status==="missing"?REGISTRY_MISSING_CODE:REGISTRY_ANOTHER_ACCOUNT_CODE}};
}

/** canaryMatched for the read-only capability/readiness reports: allowlist AND registry. */
export const durableRuntimeAccepts=(allowlisted:boolean,status:RegistryStatus):boolean=>
 allowlisted&&status==="registered";
