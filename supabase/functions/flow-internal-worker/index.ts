/**
 * REVIEW ONLY. Not deployed, not scheduled.
 * Internal effects are stored in PostgreSQL, never sent to Meta.
 * FLOW_INTERNAL_ACTIONS_ENABLED is OFF unless explicitly approved.
 */
import {createClient} from "npm:@supabase/supabase-js@2";
const env=(key:string)=>Deno.env.get(key)??"";
const reply=(status:number,data:unknown)=>new Response(JSON.stringify(data),{
 status,headers:{"content-type":"application/json","cache-control":"no-store"}});
Deno.serve(async req=>{
 if(req.method!=="POST")return reply(405,{error:"Method not allowed"});
 const key=env("SUPABASE_SERVICE_ROLE_KEY");
 if(!key||req.headers.get("authorization")!=="Bearer "+key)
  return reply(401,{error:"Unauthorized"});
 if(env("FLOW_INTERNAL_ACTIONS_ENABLED")!=="true")return reply(423,{enabled:false});
 let body:unknown;
 try{body=await req.json();}catch{return reply(400,{error:"Invalid JSON"});}
 if(!body||typeof body!=="object"||
   (body as Record<string,unknown>).mode!=="tick")
  return reply(400,{error:"Unsupported mode"});
 const sb=createClient(env("SUPABASE_URL"),key,{
  auth:{persistSession:false,autoRefreshToken:false}
 });
 const {data:global,error:ge}=await sb.from("automation_flow_global_switch")
  .select("enabled").eq("singleton",true).single();
 if(ge||global?.enabled!==true)return reply(423,{enabled:false});
 const {data,eRror}=await sb.from("automation_flow_outbox")
  .select("tenant_id,id,effect_kind")
  .eq("delivery_status","pending")
  .in("effect_kind",["tag","untag","staff_notification"])
  .order("created_at",{ascending:true}).limit(30);
 if(eRror)return reply(503,{error:"Unable to load internal effects"});
 let applied=0,skipped=0;
 for(const item of data??[]){
  const {data:ok,error}=await sb.rpc("flow_apply_internal_effect",{
   p_tenant:item.tenant_id,p_outbox:item.id
  });
  if(error){
   console.error("[flow-internal] atomic effect error",{
    code:error.code??"unknown",outboxId:item.id
   });
   skipped++;continue;
  }
  if(ok===true)applied++;
  else skipped++;
 }
 return reply(200,{processed:(data??[]).length,applied,skipped,sends:0});
});
