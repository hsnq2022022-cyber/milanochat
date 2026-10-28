/**
 * Future authenticated Edge endpoint for Flow Builder.
 * NOT deployed. Requires owner-approved runtime+publication SQL and an
 * explicit per-function deployment GO. Legacy milan-api is untouched.
 */
import {createClient} from "npm:@supabase/supabase-js@2";
import {
 preparePublishedDocument,publicationCanActivate,testCanaryArmed,
 UUID_REGEX,VALID_FLOW_KEY,type ProviderPlatform
} from "../../../src/flow/serverPublicationValidation.ts";
import type {FlowCapability} from "../../../src/flow/publicationGate.ts";

const env=(k:string)=>Deno.env.get(k)??"";
// Only the existing production GitHub Pages origin. Never reflect Origin.
const APPROVED_ORIGIN="https://hsnq2022022-cyber.github.io";
const origins:Record<string,string>={
 "Access-Control-Allow-Origin":APPROVED_ORIGIN,
 "Vary":"Origin",
 "Access-Control-Allow-Headers":"authorization, apikey, content-type, x-client-info",
 "Access-Control-Allow-Methods":"OPTIONS, POST",
 "Content-Type":"application/json; charset=utf-8",
 "Cache-Control":"no-store",
};
const respond=(body:unknown,status=200)=>new Response(JSON.stringify(body),
 {status,headers:origins});
const error=(message:string,status:number)=>respond({ok:false,error:message},status);
const hasPlatform=(v:unknown):v is ProviderPlatform=>
 v==="facebook"||v==="instagram"||v==="whatsapp";

const MAX_BODY_BYTES=4*1024*1024+4096;
const MAX_BEARER_BYTES=8192;

export async function handleFlowPublication(req:Request,
 clientFactory:typeof createClient=createClient):Promise<Response>{
 // Same-origin policy is explicit; anonymous clients and foreign browser
 // origins cannot use this privileged publishing endpoint.
 if(req.headers.get("origin")!==APPROVED_ORIGIN)
  return new Response(JSON.stringify({ok:false,error:"Origin not allowed"}),{
   status:403,headers:{"Content-Type":"application/json; charset=utf-8","Vary":"Origin"}});
 if(req.method==="OPTIONS")return new Response(null,{status:204,headers:origins});
 if(req.method!=="POST")return error("Method not allowed",405);

 const rawBearer=req.headers.get("authorization")??"";
 if(!rawBearer.startsWith("Bearer ")||
    rawBearer.length>MAX_BEARER_BYTES)return error("Not authenticated",401);

 const serviceKey=env("SUPABASE_SERVICE_ROLE_KEY");
 const supabaseUrl=env("SUPABASE_URL");
 if(!serviceKey||!supabaseUrl)return error("Service not configured",503);

 let request:Record<string,unknown>;
 try{
  const declared=Number(req.headers.get("content-length")??0);
  if(Number.isFinite(declared)&&declared>MAX_BODY_BYTES)
   return error("Request too large",413);
  if(!req.body)return error("Invalid JSON payload",400);
  const chunks:Uint8Array[]=[];
  let byteCount=0;
  const reader=req.body.getReader();
  try{
   while(true){
    const {value,done}=await reader.read();
    if(done)break;
    if(value){
     byteCount+=value.byteLength;
     if(byteCount>MAX_BODY_BYTES){
      await reader.cancel();
      return error("Request too large",413);
     }
     chunks.push(value);
    }
   }
  }finally{reader.releaseLock();}
  const data=new Uint8Array(byteCount);
  let offset=0;
  for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.byteLength;}
  const raw=new TextDecoder("utf-8",{fatal:true}).decode(data);
  const decoded:unknown=JSON.parse(raw);
  if(!decoded||typeof decoded!=="object"||Array.isArray(decoded))
   return error("Invalid JSON payload",400);
  request=decoded as Record<string,unknown>;
 }catch{return error("Invalid JSON payload",400);}

 const client=clientFactory(supabaseUrl,serviceKey,{
  auth:{persistSession:false,autoRefreshToken:false}
 });
 try{
  const {data:auth,error:authError}=await client.auth.getUser(rawBearer.slice(7));
  if(authError||!auth.user)return error("Not authenticated",401);
  const {data:tenant,error:tenantError}=await client
   .from("tenants").select("id,user_id,is_active")
   .eq("user_id",auth.user.id).maybeSingle();
  if(tenantError||!tenant||tenant.user_id!==auth.user.id||
     !UUID_REGEX.test(tenant.id))return error("Tenant not authorized",403);

  // Transactional, per-tenant UTC-minute limiter in PostgreSQL, never an
  // in-memory Deno map: one budget shared by all Edge instances.
  const {data:rateAllowed,error:rateError}=await client.rpc(
   "flow_publication_rate_allow",{p_tenant_id:tenant.id});
  if(rateError)return error("Rate limiter unavailable",503);
  if(rateAllowed!==true)
   return new Response(JSON.stringify({ok:false,error:"Rate limit exceeded"}),{
    status:429,headers:{...origins,
     "Retry-After":String(60-Math.floor(Date.now()/1000)%60)}});

  // Only the authenticated tenant's accounts are ever returned.
  if(request.action==="accounts"){
   const {data,error:accountsError}=await client
    .from("channel_accounts")
    .select("id,platform,is_active")
    .eq("tenant_id",tenant.id).limit(100);
   if(accountsError)return error("Account list unavailable",503);
   return respond({ok:true,accounts:(data??[]).filter((a:{platform:unknown})=>hasPlatform(a.platform))});
  }

  const accountId=request.accountId;
  const flowKey=request.flowKey;
  if(typeof accountId!=="string"||!UUID_REGEX.test(accountId)||
     typeof flowKey!=="string"||!VALID_FLOW_KEY.test(flowKey))
   return error("Invalid account or flow identifier",400);

  const {data:account,error:accountError}=await client
   .from("channel_accounts")
   .select("id,tenant_id,platform,is_active,agent_enabled,auto_reply")
   .eq("id",accountId).eq("tenant_id",tenant.id).maybeSingle();
  if(accountError||!account||account.tenant_id!==tenant.id||
     !hasPlatform(account.platform))return error("Account not authorized",403);

  const scope={tenantId:tenant.id,accountId,platform:account.platform,
    actorId:auth.user.id};
  const action=request.action;

  if(action==="publish"){
   if(tenant.is_active!==true||account.is_active!==true)
    return error("Account is disabled",403);
   const doc=preparePublishedDocument(request.document,scope.platform);
   if(!doc)return error("Flow document is invalid or targets another channel",422);
   const {data,error:dbError}=await client.rpc("flow_publish_revision",{
    p_tenant_id:scope.tenantId,p_account_id:scope.accountId,
    p_platform:scope.platform,p_flow_key:flowKey,p_actor_id:scope.actorId,
    p_document:doc
   });
   if(dbError){console.error("[flow-publication] publish database error",dbError.code);
    return error("Flow publish is unavailable",503);}
   if(!Number.isSafeInteger(data)||data<1)
    return error("Publishing was rejected",403);
   return respond({ok:true,revision:data,activationChanged:false});
  }

  if(action==="list"){
   const [pubs,act]=await Promise.all([
    client.from("automation_flow_publications")
      .select("revision,created_at,platform")
      .eq("tenant_id",scope.tenantId)
      .eq("channel_account_id",scope.accountId)
      .eq("flow_key",flowKey).order("revision",{ascending:false}).limit(100),
    client.from("automation_flow_activations")
      .select("revision,is_active")
      .eq("tenant_id",scope.tenantId)
      .eq("channel_account_id",scope.accountId)
      .eq("platform",scope.platform)
      .eq("flow_key",flowKey).maybeSingle()
   ]);
   if(pubs.error||act.error)return error("Publication list unavailable",503);
   return respond({ok:true,items:pubs.data??[],activation:act.data??null});
  }

  if(action==="deactivate"){
   const {data,error:dbError}=await client.rpc("flow_deactivate_revision",{
    p_tenant_id:scope.tenantId,p_account_id:scope.accountId,
    p_platform:scope.platform,p_flow_key:flowKey,p_actor_id:scope.actorId
   });
   if(dbError)return error("Deactivation unavailable",503);
   return data===true ? respond({ok:true,active:false}) :
    error("No active publication found",404);
  }

  if(action==="activate"||action==="rollback"){
   const rev=request.revision;
   if(typeof rev!=="number"||!Number.isSafeInteger(rev)||rev<1)
    return error("Invalid revision",400);
   if(tenant.is_active!==true||account.is_active!==true||
      account.agent_enabled!==true||account.auto_reply!==true)
    return error("Account is paused",403);

   // Three independent controls: exact server environment, server side
   // capability manifest, and database global/tenant test-only switches.
   if(!testCanaryArmed(env("FLOW_PUBLICATION_CANARY_READY"),
     env("FLOW_PUBLICATION_CANARY_TENANT_ID"),
     env("FLOW_PUBLICATION_CANARY_ACCOUNT_ID"),
     scope.tenantId,scope.accountId))
    return error("Publication activation is disabled",423);

   const {data:publication,error:publicationError}=await client
    .from("automation_flow_publications").select("document")
    .eq("tenant_id",scope.tenantId).eq("channel_account_id",scope.accountId)
    .eq("platform",scope.platform).eq("flow_key",flowKey)
    .eq("revision",rev).maybeSingle();
   if(publicationError)return error("Publication lookup unavailable",503);
   if(!publication)return error("Publication revision not found",404);
   const caps=new Set<FlowCapability>(env("FLOW_ACTIVATION_CAPABILITIES")
    .split(",").map(s=>s.trim()).filter(Boolean) as FlowCapability[]);
   if(!publicationCanActivate(publication.document,scope.platform,caps,true))
    return error("This flow uses unsupported runtime features",422);

   const {data:enabled,error:dbError}=await client.rpc("flow_activate_revision",{
    p_tenant_id:scope.tenantId,p_account_id:scope.accountId,
    p_platform:scope.platform,p_flow_key:flowKey,p_revision:rev,p_actor_id:scope.actorId
   });
   if(dbError)return error("Activation unavailable",503);
   if(enabled!==true)return error("Global/tenant switch is OFF",423);
   return respond({ok:true,active:true,revision:rev});
  }
  return error("Unknown action",400);
 }catch(e){
  console.error("[flow-publication] unexpected error",
    e instanceof Error?e.name:"unknown");
  return error("Service temporarily unavailable",503);
 }
}

if(import.meta.main)Deno.serve((req)=>handleFlowPublication(req));
