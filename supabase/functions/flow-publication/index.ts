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
const origins:Record<string,string>={
 "Access-Control-Allow-Origin":"*",
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

Deno.serve(async(req:Request):Promise<Response>=>{
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
  const raw=await req.text();
  if(new TextEncoder().encode(raw).byteLength>MAX_BODY_BYTES)
   return error("Request too large",413);
  const decoded:unknown=JSON.parse(raw);
  if(!decoded||typeof decoded!=="object"||Array.isArray(decoded))
   return error("Invalid JSON payload",400);
  request=decoded as Record<string,unknown>;
 }catch{return error("Invalid JSON payload",400);}

 const client=createClient(supabaseUrl,serviceKey,{
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

  // Only the authenticated tenant's accounts are ever returned.
  if(request.action==="accounts"){
   const {data,error:accountsError}=await client
    .from("channel_accounts")
    .select("id,platform,is_active")
    .eq("tenant_id",tenant.id).limit(100);
   if(accountsError)return error("Account list unavailable",503);
   return respond({ok:true,accounts:(accounts??[]).filter(a=>hasPlatform(a.platform))});
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
   const caps=new Set((env("FLOW_ACTIVATION_CAPABILITIES")
    .split(",").map(s=>s.trim()).filter(Boolean)) as Set<FlowCapability>);
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
});
