/**
 * PURE read of the operator registry automation_flow_canary_accounts (service_role has SELECT only).
 * Shared by publication (publication/runtime agreement) and the workers (wake / outbox / internal
 * effects), so every durable path asks the SAME question the SQL claim asks:
 * "did the operator register exactly (tenant, account, platform)?".
 *
 * Registry key: PRIMARY KEY (tenant_id, platform) = at most ONE durable account per tenant and platform.
 * Fail closed: a read error is "unavailable" (never "registered").
 */
export type Db={from:(table:string)=>any};
export type RegistryScope={tenantId:string;accountId:string;platform:string};
export type RegistryStatus="registered"|"missing"|"another_account"|"unavailable";

export async function durableRegistryStatus(client:Db,scope:RegistryScope):Promise<RegistryStatus>{
 const {data,error}=await client.from("automation_flow_canary_accounts")
  .select("channel_account_id")
  .eq("tenant_id",scope.tenantId).eq("platform",scope.platform).maybeSingle();
 if(error)return "unavailable";
 if(!data)return "missing";
 return data.channel_account_id===scope.accountId?"registered":"another_account";
}


/**
 * Where the registry applies. The test-only tenant mode (flow_claim_inbound, test_only=true) never used
 * the registry; every production (non test_only) durable path requires it, exactly like
 * flow_claim_inbound_durable.
 */
export const registryRequired=(testOnly:unknown):boolean=>testOnly!==true;
