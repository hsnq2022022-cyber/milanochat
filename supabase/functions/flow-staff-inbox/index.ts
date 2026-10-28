/**
 * FUTURE ONLY: owner/assigned-staff read-only notification inbox.
 * No deploy. Requires tenant_staff_memberships + flow_staff_notifications
 * migrations and independent rate-limit/security GO.
 */
import {createClient} from "npm:@supabase/supabase-js@2";
const origin="https://hsnq2022022-cyber.github.io";
const headers={
 "Access-Control-Allow-Origin":origin,
 "Access-Control-Allow-Methods":"POST, OPTIONS",
 "Access-Control-Allow-Headers":"authorization,apikey,content-type",
 "Vary":"Origin","Content-Type":"application/json; charset=utf-8",
 "Cache-Control":"no-store"
};
const response=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const env=(s:string)=>Deno.env.get(s)??"";
export async function handleStaffInbox(req:Request,factory:typeof createClient=createClient):Promise<Response>{
 if(req.headers.get("origin")!==origin)
  return new Response(JSON.stringify({error:"Origin not permitted"}),{status:403,
   headers:{"content-type":"application/json","vary":"Origin"}});
 if(req.method==="OPTIONS")return new Response(null,{status:204,headers});
 if(req.method!=="POST")return response({error:"Method not allowed"},405);
 if(env("FLOW_STAFF_INBOX_ENABLED")!=="true")
  return response({error:"Staff inbox disabled"},423);
 const bearer=req.headers.get("authorization")??"";
 if(!bearer.startsWith("Bearer ")||bearer.length>8192)
  return response({error:"Authentication required"},401);
 const key=env("SUPABASE_SERVICE_ROLE_KEY"),url=env("SUPABASE_URL");
 if(!key||!url)return response({error:"Configuration unavailable"},503);
 let payload:unknown;
 try{
  const text=await req.text();
  if(text.length>2048)return response({error:"Payload too large"},413);
  payload=JSON.parse(text);
 }catch{return response({error:"Invalid JSON"},400);}
 const body=payload&&typeof payload==="object"&&!Array.isArray(payload)?
  payload as Record<string,unknown>:null;
 const tenantId=body?.tenantId;
 if(typeof tenantId!=="string"||!uuid.test(tenantId))return response({error:"Invalid tenant"},400);
 const sb=factory(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
 const {data:auth,error:ae}=await sb.auth.getUser(bearer.slice(7));
 if(ae||!auth.user)return response({error:"Authentication required"},401);
 const actor=auth.user.id;
 const {data:tenant,error:te}=await sb.from("tenants")
  .select("id,user_id").eq("id",tenantId).maybeSingle();
 if(te)return response({error:"Tenant lookup unavailable"},503);
 if(!tenant)return response({error:"Not authorized"},403);
 let isOwner=tenant.user_id===actor;
 if(!isOwner){
  const {data:membership,error:me}=await sb.from("tenant_staff_memberships")
   .select("role,status").eq("tenant_id",tenantId)
   .eq("user_id",actor).maybeSingle();
  if(me)return response({error:"Membership lookup unavailable"},503);
  if(!membership||membership.status!=="active"||
    !["agent","admin"].includes(membership.role))
   return response({error:"Not authorized"},403);
 }
 // Service role is PRIVATE to the Edge server. Always filter both keys.
 const {data:items,error:ie}=await sb.from("flow_staff_notifications")
  .select("outbox_id,conversation_id,body,status,created_at")
  .eq("tenant_id",tenantId).eq("recipient_user_id",actor)
  .order("created_at",{ascending:false}).limit(50);
 if(ie)return response({error:"Staff inbox unavailable"},503);
 return response({items:items??[],readOnly:true});
}
if(import.meta.main)Deno.serve((req)=>handleStaffInbox(req));
