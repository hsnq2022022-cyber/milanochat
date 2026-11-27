/**
 * Authenticates internal Flow worker ticks.
 *
 * The built-in service-role secret is needed for the Supabase DB client.
 * Cron has an independent Bearer token stored in BOTH Supabase Vault and the
 * Edge Function secret named flow_worker_service_role_key.
 * A missing/empty override never grants access.
 *
 * Secrets are compared in constant time (no early exit on the first differing
 * byte, no length-dependent shortcut on the compared content).
 */
export function constantTimeEqual(a:string,b:string):boolean{
 const enc=new TextEncoder();
 const x=enc.encode(a),y=enc.encode(b);
 let diff=x.length^y.length;
 const n=Math.max(x.length,y.length);
 for(let i=0;i<n;i++)diff|=(x[i]??0)^(y[i]??0);
 return diff===0;
}
export function acceptsFlowWorkerBearer(
 authorization:string|null,
 serviceRoleKey:string,
 cronBearerKey:string
):boolean{
 if(!serviceRoleKey||!authorization||!authorization.startsWith("Bearer "))return false;
 const service=constantTimeEqual(authorization,"Bearer "+serviceRoleKey);
 const cron=cronBearerKey.length>0&&constantTimeEqual(authorization,"Bearer "+cronBearerKey);
 return service||cron;
}
