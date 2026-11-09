/**
 * REVIEW ONLY. Not deployed, not scheduled.
 * Internal effects are stored in PostgreSQL, never sent to Meta.
 * FLOW_INTERNAL_ACTIONS_ENABLED is OFF unless explicitly approved.
 *
 * Optional standalone tick of the internal executor (internalEffects.ts).
 * The scheduled flow-outbox-worker runs the same executor after its message
 * pass, so no extra Cron job is required; both are safe to run concurrently
 * (conditional lease claim + idempotent writes).
 * The previous body called flow_apply_internal_effect (20261028228000),
 * which only serves test_only tenants and ignores per-run effect order;
 * that SQL function is left installed and unchanged.
 */
import {createClient} from "npm:@supabase/supabase-js@2";
import {runInternalEffects,internalActionsReleased} from "./internalEffects.ts";
const env=(key:string)=>Deno.env.get(key)??"";
const reply=(status:number,data:unknown)=>new Response(JSON.stringify(data),{
 status,headers:{"content-type":"application/json","cache-control":"no-store"}});
Deno.serve(async req=>{
 if(req.method!=="POST")return reply(405,{error:"Method not allowed"});
 const key=env("SUPABASE_SERVICE_ROLE_KEY");
 if(!key||req.headers.get("authorization")!=="Bearer "+key)
  return reply(401,{error:"Unauthorized"});
 if(!internalActionsReleased(k=>Deno.env.get(k)))return reply(423,{enabled:false});
 let body:unknown;
 try{body=await req.json();}catch{return reply(400,{error:"Invalid JSON"});}
 if(!body||typeof body!=="object"||
   (body as Record<string,unknown>).mode!=="tick")
  return reply(400,{error:"Unsupported mode"});
 const sb=createClient(env("SUPABASE_URL"),key,{
  auth:{persistSession:false,autoRefreshToken:false}
 });
 const status=await runInternalEffects(sb,{canaryAccountId:env("FLOW_DURABLE_CANARY_ACCOUNT_ID")});
 if(status.blocked_global)return reply(423,{enabled:false});
 return reply(200,{status,sends:0});
});
