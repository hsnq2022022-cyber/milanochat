/**
 * READ-ONLY operations console. No sending, charging or resolving.
 * Dormant until FLOW_DELIVERY_REVIEW_ENABLED=true and deployed with JWT checks.
 */
import {createClient} from "npm:@supabase/supabase-js@2";
const env=(k:string)=>Deno.env.get(k)??"";
const ORIGIN="https://hsnq2022022-cyber.github.io";
const headers={"content-type":"application/json;charset=utf-8","cache-control":"no-store",
 "access-control-allow-origin":ORIGIN,"access-control-allow-headers":"apikey,authorization,content-type",
 "access-control-allow-methods":"POST,OPTIONS","vary":"Origin"};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers});
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function handle(req:Request){
 if(req.headers.get("origin")!==ORIGIN)return json({error:"Origin not permitted"},403);
 if(req.method==="OPTIONS")return new Response(null,{status:204,headers});
 if(req.method!=="POST")return json({error:"Method not allowed"},405);
 if(env("FLOW_DELIVERY_REVIEW_ENABLED")!=="true")
  return json({error:"Delivery review disabled"},423);
 const key=env("SUPABASE_SERVICE_ROLE_KEY"),base=env("SUPABASE_URL");
 if(!key||!base)return json({error:"Unavailable"},503);
 const auth=req.headers.get("authorization")??"";
 if(!auth.startsWith("Bearer ")||auth.length>8192)return json({error:"Unauthorized"},401);
 let body:unknown;
 try{
  const raw=await req.text();if(raw.length>1024)return json({error:"Payload too large"},413);
  body=JSON.parse(raw);
 }catch{return json({error:"Invalid JSON"},400)}
 if(!body||typeof body!=="object"||Array.isArray(body))
  return json({error:"Invalid body"},400);
 const data=body as Record<string,unknown>;
 if(typeof data.tenantId!=="string"||!UUID.test(data.tenantId)||
    !["queue","metrics"].includes(String(data.mode)))
  return json({error:"Invalid tenant or mode"},400);
 const sb=createClient(base,key,{auth:{autoRefreshToken:false,persistSession:false}});
 const {data:user,error:ue}=await sb.auth.getUser(auth.slice(7));
 if(ue||!user.user)return json({error:"Unauthorized"},401);
 const {data:tenant,error:te}=await sb.from("tenants")
  .select("id,user_id").eq("id",data.tenantId).maybeSingle();
 if(te)return json({error:"Tenant unavailable"},503);
 if(!tenant||tenant.user_id!==user.user.id)return json({error:"Not authorized"},403);
 if(data.mode==="queue"){
  const {data:rows,error}=await sb.from("automation_delivery_attempts")
   .select("claim_id,platform,status,provider_message_id,attempted_at,uncertain_at,review_status,review_requested_at")
   .eq("tenant_id",tenant.id).eq("review_status","queued")
   .order("attempted_at",{ascending:false}).limit(100);
  if(error)return json({error:"Queue unavailable"},503);
  return json({items:rows??[],readOnly:true});
 }
 const since=new Date(Date.now()-30*86400000).toISOString();
 const {data:rows,error}=await sb.from("automation_flow_metrics")
  .select("event_key").eq("tenant_id",tenant.id)
  .gte("occurred_at",since).order("occurred_at",{ascending:false}).limit(1000);
 if(error)return json({error:"Metrics unavailable"},503);
 const events:Record<string,number>={};
 for(const row of rows??[]){
  if(typeof row.event_key==="string" && /^[a-z_]{1,40}$/.test(row.event_key))
   events[row.event_key]=(events[row.event_key]??0)+1;
 }
 return json({events,periodDays:30,truncated:(rows?.length??0)===1000});
}
if(import.meta.main)Deno.serve(handle);
