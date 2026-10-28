/**
 * REVIEW-ONLY source. NOT deployed or scheduled.
 * Effect dispatcher: text messages only. Rich questions, tags and staff actions
 * remain separate permission-reviewed executors. Never resend uncertain effects.
 *
 * Necessary server-side gates (ALL default OFF):
 * FLOW_OUTBOX_SEND_ENABLED, FLOW_ATOMIC_CONSUME_READY, global and tenant test_only,
 * activated publication, account permission, no human takeover, positive credit.
 */
import {createClient} from "npm:@supabase/supabase-js@2";
import {sendProviderMessage,decryptAccountToken,encryptMessageBody} from "./deliveryCore.ts";
import {answerWithVerifiedKnowledge,openAIKnowledgeDependencies} from "./flowKnowledge.ts";
import {executeOnce} from "./executeOnce.ts";

const env=(name:string)=>Deno.env.get(name)??"";
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),
 {status,headers:{"content-type":"application/json","cache-control":"no-store"}});
const blocked=()=>json({status:"disabled",sends:0},423);
const allowedChannel=(p:string):p is "instagram"|"facebook"|"whatsapp"=>
 ["instagram","facebook","whatsapp"].includes(p);
Deno.serve(async req=>{
 if(req.method!=="POST")return json({error:"Method not allowed"},405);
 // Do not rely on a public Bearer supplied by a browser.
 const secret=env("SUPABASE_SERVICE_ROLE_KEY");
 if(!secret||req.headers.get("authorization")!=="Bearer "+secret)
  return json({error:"Unauthorized"},401);
 if(env("FLOW_OUTBOX_SEND_ENABLED")!=="true"||
    env("FLOW_ATOMIC_CONSUME_READY")!=="true")return blocked();
 const base=env("SUPABASE_URL"),fieldKey=env("FIELD_ENCRYPTION_KEY");
 if(!base||!fieldKey)return json({error:"Service configuration unavailable"},503);
 let input:unknown;
 try{input=await req.json();}catch{return json({error:"Bad JSON"},400);}
 if(!input||typeof input!=="object"||
    (input as Record<string,unknown>).mode!=="tick")return json({error:"Invalid mode"},400);
 const sb=createClient(base,secret,{auth:{persistSession:false,autoRefreshToken:false}});
 const {data:g,error:ge}=await sb.from("automation_flow_global_switch")
  .select("enabled").eq("singleton",true).single();
 if(ge||g?.enabled!==true)return blocked();
 const {data:items,error:listError}=await sb.from("automation_flow_outbox")
  .select("id,tenant_id,run_id,delivery_status,effect_kind,payload,outgoing_message_id")
  .eq("delivery_status","pending").in("effect_kind",["message","question"])
  .order("created_at",{ascending:true}).limit(10);
 if(listError)return json({error:"Outbox lookup failed"},503);
 const outcomes:Record<string,number>={};
 for(const effect of items??[]){
  const report=(key:string)=>outcomes[key]=(outcomes[key]??0)+1;
  try{
   const {data:tenant}=await sb.from("tenants")
    .select("id,business_name,is_active,credits_remaining")
    .eq("id",effect.tenant_id).maybeSingle();
   const {data:sw}=await sb.from("automation_flow_tenant_switches")
    .select("enabled,test_only").eq("tenant_id",effect.tenant_id).maybeSingle();
   const {data:run}=await sb.from("automation_flow_runs").select("*")
    .eq("id",effect.run_id).eq("tenant_id",effect.tenant_id).maybeSingle();
   if(!tenant?.is_active||!(tenant.credits_remaining>0)||
      !sw?.enabled||!sw.test_only||!run){report("blocked");continue;}
   const [accountResult,conversationResult]=await Promise.all([
    sb.from("channel_accounts").select("id,tenant_id,platform,is_active,agent_enabled,auto_reply,external_id,access_token_encrypted")
      .eq("tenant_id",effect.tenant_id).eq("id",run.channel_account_id).maybeSingle(),
    sb.from("conversations").select("id,tenant_id,account_id,wa_chat_id,transferred,human_agent_until")
      .eq("tenant_id",effect.tenant_id).eq("id",run.conversation_id).maybeSingle()
   ]);
   const account=accountResult.data,conversation=conversationResult.data;
   if(accountResult.error||conversationResult.error||!account||!conversation||
      account.tenant_id!==tenant.id||conversation.tenant_id!==tenant.id||
      conversation.account_id!==account.id||account.is_active!==true||
      account.agent_enabled!==true||account.auto_reply!==true||
      !allowedChannel(String(account.platform))||
      conversation.transferred===true||
      (conversation.human_agent_until&&Date.parse(conversation.human_agent_until)>Date.now())){
    report("blocked");continue;
   }
   const recipientRaw=String(conversation.wa_chat_id??"");
   const expectedPrefix=account.platform==="facebook"?"facebook":account.platform;
   if(!recipientRaw.startsWith(expectedPrefix+":")){report("blocked");continue;}
   const recipient=recipientRaw.slice(expectedPrefix.length+1);
   // Do not allow the AI prompt to dictate recipient, account, URL or tenant.
   const payload=effect.payload;
   if(!payload||typeof payload!=="object"||payload.kind!==effect.effect_kind){
    report("invalid");continue;
   }
   if(effect.effect_kind==="question" &&
      (env("FLOW_RICH_BUTTONS_ENABLED")!=="true" ||
       !["instagram","facebook"].includes(account.platform) ||
       payload.inputMode!=="buttons")){
    report("blocked");continue;
   }
   let messageText=typeof payload.text==="string"?payload.text.trim():"";
   if(payload.source==="knowledge_ai"){
    if(env("FLOW_RAG_ENABLED")!=="true"){report("blocked");continue;}
    const question=typeof run.variables?.message==="string"?run.variables.message:"";
    messageText=await answerWithVerifiedKnowledge(sb,{
      tenantId:tenant.id,publishedTenantId:run.tenant_id,
      conversationTenantId:conversation.tenant_id,agentEnabled:account.agent_enabled,
      humanTakeover:conversation.transferred===true,credits:tenant.credits_remaining,
      businessName:tenant.business_name
    },question,openAIKnowledgeDependencies())??"";
   }
   if(!messageText||messageText.length>4000){report("invalid");continue;}
   const quickReplies=effect.effect_kind==="question" &&
     Array.isArray(payload.choices)&&Array.isArray(payload.choiceIds)&&
     payload.choiceIds.length===payload.choices.length?
     payload.choices.map((label:unknown,i:number)=>({id:payload.choiceIds[i],label})):undefined;
   if(effect.effect_kind==="question" && !quickReplies){report("invalid");continue;}
   const websiteButtons=effect.effect_kind==="message" &&
     Array.isArray(payload.websiteButtons)?payload.websiteButtons:undefined;
   if(websiteButtons && (env("FLOW_RICH_BUTTONS_ENABLED")!=="true" || account.platform!=="facebook")){
     report("blocked");continue;
   }
   const token=account.platform==="whatsapp"?
    (env("WA_ACCESS_TOKEN")||env("WHATSAPP_ACCESS_TOKEN")):
    await decryptAccountToken(String(account.access_token_encrypted??""),fieldKey);
   if(!token){report("blocked");continue;}
   const res=await executeOnce({
    reserve:async()=>{
     const {data,error}=await sb.rpc("flow_reserve_outbox_delivery",{
      p_tenant:effect.tenant_id,p_outbox:effect.id
     });
     if(error){console.error("[outbox] reserve error",{code:error.code});return false;}
     return data===true;
    },
    send:()=>sendProviderMessage({
     platform:account.platform,externalId:String(account.external_id??""),
     token,recipient,text:messageText,quickReplies,websiteButtons
    }),
    confirm:async(status,providerId)=>{
     const {data,error}=await sb.rpc("flow_finish_outbox_delivery",{
      p_tenant:effect.tenant_id,p_outbox:effect.id,p_result:status,
      p_provider_message_id:providerId
     });
     if(error){console.error("[outbox] finish error",{code:error.code});return false;}
     return data===true;
    },
    persistAndBill:async(providerId)=>{
     const encrypted=await encryptMessageBody(messageText,fieldKey);
     const {error:insertError}=await sb.from("messages").insert({
      id:effect.outgoing_message_id,tenant_id:tenant.id,
      conversation_id:conversation.id,direction:"out",body_encrypted:encrypted,
      kind:"answer",is_auto:true,wa_message_id:providerId
     });
     if(insertError&&insertError.code!=="23505"){
      console.error("[outbox] outgoing persisted failed",{code:insertError.code});
      return false;
     }
     const {data:charge,error:chargeError}=await sb.rpc("consume_reply",{
      p_tenant_id:tenant.id,p_message_id:effect.outgoing_message_id
     });
     if(chargeError||typeof charge!=="number"||!(charge>=0||charge===-2)){
      console.error("[outbox] charge pending",{
       code:chargeError?.code??"credit_status",
       tenantId:tenant.id,outboxId:effect.id,result:charge
      });
      return false;
     }
     const {data:settled,error:finalizeError}=await sb.from("automation_flow_outbox")
      .update({delivery_status:"settled"}).eq("tenant_id",tenant.id)
      .eq("id",effect.id).eq("delivery_status","charge_pending")
      .select("id").maybeSingle();
     if(finalizeError||!settled){
      console.error("[outbox] settlement failed",{code:finalizeError?.code??"missing_transition"});
      return false;
     }
     return true;
    }
   });
   report(res);
  }catch(err){
   // No automatic retry of any reserved provider call, even on timeout.
   console.error("[outbox] effect blocked/uncertain",{id:effect.id,
    type:err instanceof Error?err.name:"unknown"});
   report("error");
  }
 }
 return json({processed:(items??[]).length,status:outcomes});
});
