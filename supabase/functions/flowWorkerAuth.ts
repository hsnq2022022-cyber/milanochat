/**
 * Authenticates internal Flow worker ticks.
 *
 * The built-in service-role secret is needed for the Supabase DB client.
 * Cron has an independent Bearer token stored in BOTH Supabase Vault and the
 * Edge Function secret named flow_worker_service_role_key.
 * A missing/empty override never grants access.
 */
export function acceptsFlowWorkerBearer(
 authorization:string|null,
 serviceRoleKey:string,
 cronBearerKey:string
):boolean{
 if(!serviceRoleKey||!authorization||!authorization.startsWith("Bearer "))return false;
 return authorization==="Bearer "+serviceRoleKey||
   (cronBearerKey.length>0&&authorization==="Bearer "+cronBearerKey);
}
