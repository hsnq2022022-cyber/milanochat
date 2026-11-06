import {test} from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {readFileSync} from "node:fs";
import {supportedDurableDocument,attemptDurableInstagram}
 from "../supabase/functions/milan-api/flowDurableIngress.ts";
import {multichannelCapabilityProblem,DOCUMENT_PLATFORM}
 from "../supabase/functions/milan-api/flowPlatformCapabilities.ts";
import {verifyMetaWebhookSignature} from "../supabase/functions/milan-api/metaSignature.ts";
import {normalizeMetaMessages} from "../supabase/functions/milan-api/normalizeMetaMessage.ts";

const ids={tenantId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",accountId:"11111111-1111-4111-8111-111111111111",
 conversationId:"44444444-4444-4444-8444-444444444444",inboundId:"77777777-7777-4777-8777-777777777771"};
const docFor=(platform:string,extra:Record<string,unknown>[]=[])=>({version:3,nodes:[
 {id:"start",data:{kind:"trigger",platform,triggerMode:"message"}},
 {id:"choose",data:{kind:"question",inputMode:"buttons",text:"اختر",image:"",contentBlocks:[],options:[
  {id:"prices",label:"الأسعار"},{id:"support",label:"المساعدة"}]}},
 {id:"yes",data:{kind:"message",text:"هذه الأسعار",image:"",options:[],contentBlocks:[]}},
 {id:"no",data:{kind:"message",text:"تواصل معنا",image:"",options:[],contentBlocks:[]}},...extra
],edges:[{source:"start",target:"choose",sourceHandle:"next"},
 {source:"choose",target:"yes",sourceHandle:"prices"},{source:"choose",target:"no",sourceHandle:"support"}]});

test("durable whitelist default (Instagram) is unchanged: WhatsApp/Messenger triggers fall back to V2",()=>{
 assert.equal(supportedDurableDocument(docFor("instagram")),true);
 for(const p of ["whatsapp","messenger","facebook"])assert.equal(supportedDurableDocument(docFor(p)),false);
});
const ENV=(over:Record<string,string|undefined>={})=>({env:{get:(k:string)=>({
 FLOW_DURABLE_INGRESS_ENABLED:"true",FLOW_DURABLE_CANARY_ACCOUNT_ID:ids.accountId,
 FLOW_MULTICHANNEL_ENABLED:"true",...over} as Record<string,string|undefined>)[k]}});
async function withEnv<T>(e:unknown,fn:()=>T|Promise<T>):Promise<T>{
 const old=(globalThis as any).Deno;(globalThis as any).Deno=e;
 try{return await fn();}finally{(globalThis as any).Deno=old;}
}
const noDb={from(){throw Error("db touched");},rpc(){throw Error("db touched");}} as any;
test("flag OFF (or not exactly true): WhatsApp/Facebook events never touch the DB",async()=>{
 for(const flag of [undefined,"false","1","TRUE"]){
  await withEnv(ENV({FLOW_MULTICHANNEL_ENABLED:flag}),async()=>{
   for(const platform of ["whatsapp","facebook"]){
    assert.equal(await attemptDurableInstagram(noDb,{...ids,eventId:"wamid.1",platform,
     providerEventIdGenuine:true}),"fallback",`${platform} flag=${flag}`);
    assert.equal(supportedDurableDocument(docFor(DOCUMENT_PLATFORM[platform as "whatsapp"]),platform),false);
   }
  });
 }
 // No Deno runtime: the flag reader itself is fail-closed.
 await withEnv(undefined,()=>{
  assert.equal(supportedDurableDocument(docFor("whatsapp"),"whatsapp"),false);
 });
});
test("flag ON: unknown platform, synthetic id, wrong canary account or ingress OFF never touch the DB",async()=>{
 await withEnv(ENV(),async()=>{
  for(const platform of ["telegram","messenger","Instagram",""])
   assert.equal(await attemptDurableInstagram(noDb,{...ids,eventId:"m.1",platform,providerEventIdGenuine:true}),"fallback",platform);
  assert.equal(await attemptDurableInstagram(noDb,{...ids,eventId:"wamid.1",platform:"whatsapp",
   providerEventIdGenuine:false}),"fallback");
 });
 for(const over of [{FLOW_DURABLE_CANARY_ACCOUNT_ID:"22222222-2222-4222-8222-222222222222"},
  {FLOW_DURABLE_CANARY_ACCOUNT_ID:undefined},{FLOW_DURABLE_INGRESS_ENABLED:undefined}])
  await withEnv(ENV(over),async()=>{
   for(const platform of ["whatsapp","facebook"])
    assert.equal(await attemptDurableInstagram(noDb,{...ids,eventId:"wamid.1",platform,
     providerEventIdGenuine:true}),"fallback",JSON.stringify(over));
  });
});
test("flag ON whitelist: own trigger platform (facebook <-> messenger), capabilities, no delay/internal actions",async()=>{
 await withEnv(ENV(),()=>{
  // Instagram rules are unchanged (default platform).
  assert.equal(supportedDurableDocument(docFor("instagram")),true);
  assert.equal(supportedDurableDocument(docFor("whatsapp")),false);
  assert.equal(supportedDurableDocument(docFor("whatsapp"),"whatsapp"),true);
  assert.equal(supportedDurableDocument(docFor("messenger"),"facebook"),true);
  for(const [doc,platform] of [["instagram","whatsapp"],["messenger","whatsapp"],["whatsapp","facebook"],
   ["facebook","facebook"],["instagram","facebook"],["whatsapp","instagram"],["whatsapp","telegram"]])
   assert.equal(supportedDurableDocument(docFor(doc),platform),false,`${doc} on ${platform}`);
  const four={id:"q4",data:{kind:"question",inputMode:"buttons",text:"x",image:"",contentBlocks:[],
   options:[1,2,3,4].map(i=>({id:"o"+i,label:"L"+i}))}};
  const withNode=(p:string,node:any)=>{const d=docFor(p);return {...d,nodes:[...d.nodes,node],
   edges:[...d.edges,{source:"yes",target:node.id,sourceHandle:"next"}]};};
  const end4=(p:string)=>{const d=withNode(p,four);return {...d,nodes:[...d.nodes,...[1,2,3,4].map(i=>
   ({id:"e"+i,data:{kind:"end"}}))],edges:[...d.edges,...[1,2,3,4].map(i=>({source:"q4",target:"e"+i,sourceHandle:"o"+i}))]};};
  assert.equal(supportedDurableDocument(end4("whatsapp"),"whatsapp"),false,"WhatsApp: at most 3 reply buttons");
  assert.equal(supportedDurableDocument(end4("messenger"),"facebook"),true,"Messenger: up to 13 quick replies");
  for(const [label,node] of [
   ["delay",{id:"d",data:{kind:"delay",delayValue:1,delayUnit:"minutes"}}],
   ["tag",{id:"d",data:{kind:"action",actionType:"tag",actionValue:"vip"}}],
   ["notify",{id:"d",data:{kind:"action",actionType:"notify",actionValue:"hi"}}],
   ["image",{id:"d",data:{kind:"message",text:"x",image:"https://x.example/a.png",options:[],contentBlocks:[]}}],
   ["typed",{id:"d",data:{kind:"question",inputMode:"email",inputField:"email",text:"x",image:"",contentBlocks:[],options:[]}}],
   ["website",{id:"d",data:{kind:"message",text:"x",image:"",contentBlocks:[],options:[
    {id:"w",label:"Open",action:"website",buttonType:"button",url:"https://a.example"}]}}]]){
   const wa=withNode("whatsapp",node),fb=withNode("messenger",node);
   assert.equal(supportedDurableDocument(wa,"whatsapp"),false,"whatsapp "+label);
   assert.equal(supportedDurableDocument(fb,"facebook"),false,"facebook "+label);
  }
  // set_field is internal to the run: allowed.
  const sf=withNode("whatsapp",{id:"d",data:{kind:"action",actionType:"set_field",actionValue:"plan=gold"}});
  assert.equal(supportedDurableDocument(sf,"whatsapp"),true);
  // V2 shape (lone trigger -> text) stays with V2 on every platform.
  const v2=(p:string)=>({version:3,nodes:[{id:"s",data:{kind:"trigger",platform:p,triggerMode:"message"}},
   {id:"t",data:{kind:"message",text:"hi",image:"",options:[],contentBlocks:[]}}],
   edges:[{source:"s",target:"t",sourceHandle:"next"}]});
  assert.equal(supportedDurableDocument(v2("whatsapp"),"whatsapp"),false);
  assert.equal(supportedDurableDocument(v2("messenger"),"facebook"),false);
 });
});

// Recording database double: every read filter and RPC argument is kept.
function mcDb(platform:string,o:{switches?:any;waiting?:any;document?:unknown}={}){
 const calls:Array<{name:string;args:any}>=[];
 const reads:Array<{table:string;filters:Record<string,unknown>}>=[];
 let waiting=o.waiting??null;
 const db={
  from:(table:string)=>{
   const filters:Record<string,unknown>={};
   const q:any={select:()=>q,eq:(k:string,v:unknown)=>{filters[k]=v;return q;},
    in:(k:string,v:unknown)=>{filters[k]=v;return q;},gt:()=>q,
    maybeSingle:async()=>{reads.push({table,filters});return {data:
     table==="automation_flow_global_switch"?{enabled:true}:
     table==="automation_flow_tenant_switches"?(o.switches??{enabled:true,test_only:false,production_approved:true}):
     table==="automation_flow_publications"?{document:o.document??docFor(DOCUMENT_PLATFORM[platform as "whatsapp"])}:null,
     error:null};},
    limit:async()=>{reads.push({table,filters});
     if(table==="automation_flow_runs")return {data:waiting&&!Array.isArray(filters.id)?[waiting]:[],error:null};
     if(table==="automation_flow_activations")return {data:[{flow_key:"flow",revision:1,is_active:true}],error:null};
     return {data:[],error:null};}};
   return q;
  },
  rpc:async(name:string,args:any)=>{
   calls.push({name,args});
   if(name==="flow_claim_inbound_durable"||name==="flow_claim_inbound")
    return {data:[{acquired:true,route:"flow"}],error:null};
   if(name==="flow_begin_durable_run_superseding"){
    waiting={id:"99999999-9999-4999-8999-999999999999",tenant_id:ids.tenantId,channel_account_id:ids.accountId,
     platform,conversation_id:ids.conversationId,provider_event_id:args.p_event,flow_key:"flow",
     publication_revision:1,current_node_id:args.p_next,run_status:"awaiting_input",
     step_count:args.p_next_step,variables:args.p_variables,wake_at:null};
    return {data:waiting.id,error:null};
   }
   if(name==="flow_resume_button_run"){waiting=null;return {data:true,error:null};}
   if(name==="flow_cancel_run")return {data:true,error:null};
   throw Error("Unexpected RPC "+name);
  }
 } as any;
 return {db,calls,reads};
}
for(const platform of ["whatsapp","facebook"]){
 test(`flag ON ${platform}: start + tap resume the SAME run with platform ${platform} everywhere`,async()=>{
  await withEnv(ENV(),async()=>{
   const {db,calls,reads}=mcDb(platform);
   const ev={...ids,platform,providerEventIdGenuine:true};
   assert.equal(await attemptDurableInstagram(db,{...ev,eventId:"mid.start"}),"handled");
   assert.deepEqual(calls.map(c=>c.name),["flow_claim_inbound_durable","flow_begin_durable_run_superseding"]);
   assert.deepEqual(calls[0].args,{p_tenant_id:ids.tenantId,p_account_id:ids.accountId,p_platform:platform,
    p_provider_event_id:"mid.start",p_conversation_id:ids.conversationId,p_inbound_message_id:ids.inboundId});
   const begin=calls[1].args;
   assert.equal(begin.p_tenant,ids.tenantId);assert.equal(begin.p_account,ids.accountId);
   assert.equal(begin.p_status,"awaiting_input");
   assert.equal(begin.p_effects[0].payload.kind,"question");
   // Tap: WhatsApp button_reply id / Facebook quick_reply or postback payload "flow-choice:prices".
   const tap={...ev,eventId:"mid.tap",inboundId:"77777777-7777-4777-8777-777777777772",selectedChoiceId:"prices"};
   assert.equal(await attemptDurableInstagram(db,tap),"handled");
   assert.deepEqual(calls.map(c=>c.name),["flow_claim_inbound_durable","flow_begin_durable_run_superseding",
    "flow_claim_inbound_durable","flow_resume_button_run"]);
   assert.equal(calls[2].args.p_platform,platform);
   const resume=calls[3].args;
   assert.equal(resume.p_run,"99999999-9999-4999-8999-999999999999");
   assert.equal(resume.p_tenant,ids.tenantId);assert.equal(resume.p_status,"completed");
   assert.equal(resume.p_effects[0].payload.text,"هذه الأسعار");
   // Every platform-scoped read uses the event's own platform and tenant.
   const scoped=reads.filter(r=>"platform" in r.filters);
   assert.ok(scoped.length>=4);
   for(const r of scoped)assert.equal(r.filters.platform,platform,r.table);
   for(const r of reads.filter(r=>"tenant_id" in r.filters))assert.equal(r.filters.tenant_id,ids.tenantId,r.table);
  });
 });
}
test("flag ON isolation: a waiting run of another platform/account/tenant is never resumed or cancelled",async()=>{
 await withEnv(ENV(),async()=>{
  const base={id:"99999999-9999-4999-8999-999999999999",tenant_id:ids.tenantId,channel_account_id:ids.accountId,
   platform:"whatsapp",conversation_id:ids.conversationId,provider_event_id:"mid.old",flow_key:"flow",
   publication_revision:1,current_node_id:"choose",run_status:"awaiting_input",step_count:2,variables:{},wake_at:null};
  for(const over of [{platform:"instagram"},{platform:"facebook"},{tenant_id:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"},
   {channel_account_id:"22222222-2222-4222-8222-222222222222"},{conversation_id:"55555555-5555-4555-8555-555555555555"}]){
   const {db,calls}=mcDb("whatsapp",{waiting:{...base,...over}});
   assert.equal(await attemptDurableInstagram(db,{...ids,platform:"whatsapp",eventId:"mid.tap",
    providerEventIdGenuine:true,selectedChoiceId:"prices"}),"handled",JSON.stringify(over));
   assert.deepEqual(calls,[],JSON.stringify(over));
  }
  // A document of another platform (or one the platform cannot show) never starts a run.
  for(const document of [docFor("instagram"),docFor("messenger")]){
   const {db,calls}=mcDb("whatsapp",{document});
   assert.equal(await attemptDurableInstagram(db,{...ids,platform:"whatsapp",eventId:"mid.x",
    providerEventIdGenuine:true}),"fallback");
   assert.deepEqual(calls,[]);
  }
  // Not production approved (and not test_only): nothing is claimed.
  const {db,calls}=mcDb("facebook",{switches:{enabled:true,test_only:false,production_approved:false}});
  assert.equal(await attemptDurableInstagram(db,{...ids,platform:"facebook",eventId:"mid.y",
   providerEventIdGenuine:true}),"fallback");
  assert.deepEqual(calls,[]);
 });
});
test("statuses, receipts and echoes are never customer events (normalizer), so they never reach the durable path",()=>{
 assert.deepEqual(normalizeMetaMessages({object:"whatsapp_business_account",entry:[{changes:[{field:"messages",
  value:{metadata:{phone_number_id:"123"},statuses:[{id:"wamid.s",status:"read",recipient_id:"9"}]}}]}]}),[]);
 assert.deepEqual(normalizeMetaMessages({object:"page",entry:[{id:"555",messaging:[
  {sender:{id:"555"},recipient:{id:"7"},message:{mid:"m.echo",text:"x",is_echo:true}},
  {sender:{id:"7"},recipient:{id:"555"},delivery:{mids:["m.1"]}},
  {sender:{id:"7"},recipient:{id:"555"},read:{watermark:1}}]}]}),[]);
 const tap=normalizeMetaMessages({object:"whatsapp_business_account",entry:[{changes:[{field:"messages",value:{
  metadata:{phone_number_id:"123"},messages:[{from:"9647",id:"wamid.t",type:"interactive",
   interactive:{type:"button_reply",button_reply:{id:"flow-choice:prices",title:"الأسعار"}}}]}}]}]});
 assert.equal(tap[0].choiceId,"prices");assert.equal(tap[0].providerMessageId,"wamid.t");
 const pb=normalizeMetaMessages({object:"page",entry:[{id:"555",messaging:[{sender:{id:"7"},recipient:{id:"555"},
  postback:{mid:"m.pb",title:"الأسعار",payload:"flow-choice:prices"}}]}]});
 assert.equal(pb[0].choiceId,"prices");assert.equal(pb[0].kind,"postback");
});
test("index.ts wiring: every multichannel path is behind multichannelEnabled(); Instagram call unchanged",()=>{
 const src=readFileSync("supabase/functions/milan-api/index.ts","utf8");
 assert.match(src,/if\(channel==="instagram"\|\|\n\s+\(\(channel==="whatsapp"\|\|channel==="facebook"\)&&multichannelEnabled\(\)\)\)\{\n\s+const durable=await attemptDurableInstagram\(/);
 const wa=src.slice(src.indexOf('case "whatsapp_webhook": {'),src.indexOf('case "instagram_webhook": {'));
 // Interactive replies only for the canary account and only with the flag; after the signature.
 assert.match(wa,/const durableReplies =\n\s+multichannelEnabled\(\) &&\n\s+typeof account\.id === "string" &&\n\s+account\.id === env\("FLOW_DURABLE_CANARY_ACCOUNT_ID"\)/);
 assert.ok(wa.indexOf("verifyMetaWebhookSignature(")<wa.indexOf("normalizeMetaMessages("));
 assert.match(wa,/\.filter\(\(m\) => m\.choiceId !== null && m\.providerMessageId !== null\)/);
 assert.match(wa,/if \(!text && !durableReply\) \{/);
 assert.match(wa,/durableReplies \? durableReply\?\.choiceId \?\? null : undefined,\n\s+durableReplies \? typeof msgId === "string" && msgId\.length > 0 : undefined\n/);
 const ig=src.slice(src.indexOf('case "instagram_webhook": {'),src.indexOf("default:",src.indexOf('case "instagram_webhook": {')));
 assert.match(ig,/const pagePostbacks =\n\s+body\.object === "page" && multichannelEnabled\(\)/);
 assert.ok(ig.indexOf("verifyMetaSignature(")<ig.indexOf("normalizeMetaMessages("));
 assert.match(ig,/if \("postback" in msg &&\n\s+String\(account\.id\) !== env\("FLOW_DURABLE_CANARY_ACCOUNT_ID"\)\) \{\n\s+continue;/);
 assert.match(ig,/for \(const msg of \[\.\.\.msgs, \.\.\.pagePostbacks\]\) \{/);
});
test("capabilities: WhatsApp accepts text, <=3 reply buttons, ONE cta_url",()=>{
 assert.equal(multichannelCapabilityProblem(docFor("whatsapp"),"whatsapp"),null);
 const four={id:"q4",data:{kind:"question",inputMode:"buttons",text:"x",options:
  [1,2,3,4].map(i=>({id:"o"+i,label:"L"+i}))}};
 assert.equal(multichannelCapabilityProblem(docFor("whatsapp",[four]),"whatsapp"),"too_many_buttons");
 assert.equal(multichannelCapabilityProblem(docFor("messenger",[four]),"facebook"),null);
 const web=(n:number,text="Visit")=>({id:"w",data:{kind:"message",text,image:"",contentBlocks:[],
  options:Array.from({length:n},(_,i)=>({id:"u"+i,label:"Open"+i,action:"website",url:"https://a.example"}))}});
 assert.equal(multichannelCapabilityProblem(docFor("whatsapp",[web(1)]),"whatsapp"),null);
 assert.equal(multichannelCapabilityProblem(docFor("whatsapp",[web(2)]),"whatsapp"),"website_buttons_invalid");
 assert.equal(multichannelCapabilityProblem(docFor("messenger",[web(3)]),"facebook"),null);
 assert.equal(multichannelCapabilityProblem(docFor("messenger",[web(1,"x".repeat(81))]),"facebook"),"text_too_long");
 const mixed={id:"m",data:{kind:"message",text:"x",image:"",contentBlocks:[],options:[
  {id:"a",label:"A"},{id:"b",label:"B",action:"website",url:"https://a.example"}]}};
 assert.equal(multichannelCapabilityProblem(docFor("whatsapp",[mixed]),"whatsapp"),"mixed_buttons");
 const longTitle={id:"t",data:{kind:"message",text:"x",image:"",contentBlocks:[],options:[{id:"a",label:"x".repeat(21)}]}};
 assert.equal(multichannelCapabilityProblem(docFor("whatsapp",[longTitle]),"whatsapp"),"button_title_invalid");
 const image={id:"i",data:{kind:"message",text:"x",image:"https://x",contentBlocks:[],options:[]}};
 assert.equal(multichannelCapabilityProblem(docFor("whatsapp",[image]),"whatsapp"),"media_unsupported");
 const typed={id:"y",data:{kind:"question",inputMode:"email",inputField:"email",text:"x"}};
 assert.equal(multichannelCapabilityProblem(docFor("messenger",[typed]),"facebook"),"typed_question_unsupported");
});
test("capabilities: cross-platform documents are refused (no platform confusion)",()=>{
 assert.deepEqual(DOCUMENT_PLATFORM,{whatsapp:"whatsapp",facebook:"messenger"});
 assert.equal(multichannelCapabilityProblem(docFor("instagram"),"whatsapp"),"trigger_platform_mismatch");
 assert.equal(multichannelCapabilityProblem(docFor("messenger"),"whatsapp"),"trigger_platform_mismatch");
 assert.equal(multichannelCapabilityProblem(docFor("whatsapp"),"facebook"),"trigger_platform_mismatch");
 assert.equal(multichannelCapabilityProblem(docFor("whatsapp"),"instagram" as any),"document_invalid");
 for(const bad of [null,{},{nodes:"x"},{nodes:[null]}])
  assert.equal(multichannelCapabilityProblem(bad,"whatsapp"),"document_invalid");
});

const sign=(raw:string,secret:string)=>"sha256="+createHmac("sha256",secret).update(raw,"utf8").digest("hex");
test("HMAC per object: WhatsApp (WHATSAPP_APP_SECRET/META_APP_SECRET) and page (INSTAGRAM/META secret)",async()=>{
 const bodies={
  whatsapp:'{"object":"whatsapp_business_account","entry":[{"changes":[{"field":"messages","value":{"metadata":{"phone_number_id":"123"},"messages":[{"from":"1","id":"w","type":"text","text":{"body":"x"}}]}}]}]}',
  page:'{"object":"page","entry":[{"id":"555","messaging":[{"sender":{"id":"7"},"recipient":{"id":"555"},"message":{"mid":"m","text":"x"}}]}]}'
 };
 for(const [name,raw] of Object.entries(bodies)){
  const secret=name+"-secret";
  assert.equal(await verifyMetaWebhookSignature(raw,sign(raw,secret),["",secret]),true,name+" valid");
  assert.equal(await verifyMetaWebhookSignature(raw.replace('"x"','"y"'),sign(raw,secret),[secret]),false,name+" tampered");
  assert.equal(await verifyMetaWebhookSignature(raw,"",[secret]),false,name+" missing signature");
  assert.equal(await verifyMetaWebhookSignature(raw,sign(raw,secret),["",""]),false,name+" missing secret");
  assert.equal(await verifyMetaWebhookSignature(raw,sign(raw,"other"),[secret]),false,name+" wrong secret");
 }
});
test("routes: both objects verify the signature before any parsing side effect or DB write",()=>{
 const src=readFileSync("supabase/functions/milan-api/index.ts","utf8");
 const wa=src.slice(src.indexOf('case "whatsapp_webhook": {'),src.indexOf('case "instagram_webhook": {'));
 const waSig=wa.indexOf("verifyMetaWebhookSignature(");
 assert.ok(waSig>0&&waSig<wa.indexOf('.from("wa_bindings")')&&waSig<wa.indexOf('.from("channel_accounts")'));
 assert.match(wa,/env\("WHATSAPP_VERIFY_TOKEN"\)/);
 const ig=src.slice(src.indexOf('case "instagram_webhook": {'),src.indexOf("default:",src.indexOf('case "instagram_webhook": {')));
 assert.match(ig,/body\.object !== "instagram" &&\n\s+body\.object !== "page"/);
 assert.ok(ig.indexOf("verifyMetaSignature(")>0&&ig.indexOf("verifyMetaSignature(")<ig.indexOf("recordVerifiedMetaReceipts(")&&
  ig.indexOf("verifyMetaSignature(")<ig.indexOf('.from("channel_accounts")'));
 assert.match(ig,/Webhook signing secret unavailable" \}, 503/);
});

// ---- Images and URL buttons on WhatsApp / Facebook: FLOW_MULTICHANNEL_ENABLED AND
// FLOW_MEDIA_SEND_ENABLED (images) / FLOW_RICH_BUTTONS_ENABLED (website buttons).
import {safePlan} from "../supabase/functions/milan-api/flowDurableIngress.ts";
import {planUntilWait,seedFromEventKey} from "../src/flow/runtimeChain.ts";
import {createRuntimeState} from "../src/flow/runtimePlan.ts";
const PROJECT="https://abcd1234.supabase.co";
const MIMG=PROJECT+"/storage/v1/object/public/flow-media/u1/0f8c2b1e-1111-4222-8333-444455556666.png";
const MWEBP=MIMG.replace(".png",".webp");
type DocPlatform="whatsapp"|"messenger"|"instagram";
const imgDoc=(p:DocPlatform,blocks:unknown[]=[{id:"b1",type:"image",url:MIMG},{id:"b2",type:"text",text:"السعر 10"}],
 over:Record<string,unknown>={})=>({version:3,nodes:[
 {id:"start",data:{kind:"trigger",platform:p,triggerMode:"message"}},
 {id:"pic",data:{kind:"message",platform:p,text:"صورة المنتج",image:"",options:[],contentBlocks:blocks,...over}},
 {id:"after",data:{kind:"message",platform:p,text:"شكرا",image:"",options:[],contentBlocks:[]}}],
 edges:[{source:"start",target:"pic",sourceHandle:"next"},{source:"pic",target:"after",sourceHandle:"next"}]});
const webOpt=(i:number,over:Record<string,unknown>={})=>({id:"w"+i,label:"زر "+i,buttonType:"button",
 action:"website",url:"https://example.com/p"+i,targetFlowId:"",...over});
const webDoc=(p:DocPlatform,opts:unknown[],text="زوروا متجرنا",over:Record<string,unknown>={})=>({version:3,nodes:[
 {id:"start",data:{kind:"trigger",platform:p,triggerMode:"message"}},
 {id:"card",data:{kind:"message",platform:p,text,image:"",contentBlocks:[],options:opts,...over}},
 {id:"after",data:{kind:"message",platform:p,text:"شكرا",image:"",options:[],contentBlocks:[]}}],
 edges:[{source:"start",target:"card",sourceHandle:"next"},{source:"card",target:"after",sourceHandle:"next"}]});
const MEDIA={FLOW_MEDIA_SEND_ENABLED:"true",SUPABASE_URL:PROJECT};
const RICH={FLOW_RICH_BUTTONS_ENABLED:"true"};
const ACCOUNT_OF={whatsapp:"whatsapp",messenger:"facebook"} as const;
const plain=(e:Record<string,string|undefined>)=>({env:{get:(k:string)=>e[k]}});

test("ingress flag matrix: images / URL buttons on WhatsApp and Facebook need multichannel AND the feature flag",async()=>{
 const cases:Array<[string,unknown,Record<string,string>]>=[
  ["wa image",imgDoc("whatsapp"),MEDIA],["fb image",imgDoc("messenger"),MEDIA],
  ["wa url",webDoc("whatsapp",[webOpt(0)]),RICH],["fb url",webDoc("messenger",[webOpt(0),webOpt(1),webOpt(2)]),RICH]];
 for(const [why,doc,feature] of cases){
  const docPlatform=(doc as any).nodes[0].data.platform as "whatsapp"|"messenger";
  const platform=ACCOUNT_OF[docPlatform];
  const check=(e:Record<string,string|undefined>)=>withEnv(plain(e),()=>supportedDurableDocument(doc,platform));
  // Multichannel OFF (feature ON or OFF): refused exactly as today (V2 fallback).
  for(const mc of [undefined,"false","1"]){
   assert.equal(await check({...feature,FLOW_MULTICHANNEL_ENABLED:mc}),false,why+" multichannel="+mc);
   assert.equal(await check({FLOW_MULTICHANNEL_ENABLED:mc}),false,why);
  }
  // Multichannel ON, feature flag OFF / not exactly "true": refused.
  for(const off of [undefined,"false","TRUE"]){
   const e:Record<string,string|undefined>={...feature,FLOW_MULTICHANNEL_ENABLED:"true"};
   for(const k of Object.keys(feature))if(k!=="SUPABASE_URL")e[k]=off;
   assert.equal(await check(e),false,why+" feature="+off);
  }
  // Both ON: accepted.
  assert.equal(await check({...feature,FLOW_MULTICHANNEL_ENABLED:"true"}),true,why+" ON+ON");
  // Never on the wrong account platform.
  const other=platform==="whatsapp"?"facebook":"whatsapp";
  assert.equal(await withEnv(plain({...MEDIA,...RICH,FLOW_MULTICHANNEL_ENABLED:"true"}),
   ()=>supportedDurableDocument(doc,other)),false,why+" on "+other);
  assert.equal(await withEnv(plain({...MEDIA,...RICH,FLOW_MULTICHANNEL_ENABLED:"true"}),
   ()=>supportedDurableDocument(doc)),false,why+" on instagram");
 }
 // No Deno runtime: fail closed.
 await withEnv(undefined,()=>assert.equal(supportedDurableDocument(imgDoc("whatsapp"),"whatsapp"),false));
});
test("ingress: Instagram image / URL-button documents are identical with the multichannel flag on or off",async()=>{
 const docs=[imgDoc("instagram"),webDoc("instagram",[webOpt(0)]),webDoc("instagram",[webOpt(0),webOpt(1),webOpt(2)]),
  webDoc("instagram",[webOpt(0)],"a".repeat(641)),imgDoc("instagram",[{id:"b",type:"image",url:MWEBP}]),
  webDoc("instagram",[webOpt(0)],undefined,{platform:"whatsapp"})];
 for(const feature of [{},MEDIA,RICH,{...MEDIA,...RICH}] as Record<string,string>[]){
  const run=(mc:string|undefined)=>withEnv(plain({...feature,FLOW_MULTICHANNEL_ENABLED:mc}),
   ()=>docs.map(d=>[supportedDurableDocument(d),supportedDurableDocument(d,"instagram")]));
  assert.deepEqual(await run("true"),await run(undefined),JSON.stringify(feature));
 }
 assert.deepEqual(await withEnv(plain({...MEDIA,...RICH}),()=>docs.map(d=>supportedDurableDocument(d))),
  [true,true,true,false,true,false],"Instagram rules unchanged");
});
test("ingress limits (all flags ON): WhatsApp one cta_url, Facebook 1..3 / text <= 80, flow-media images only",async()=>{
 await withEnv(plain({...MEDIA,...RICH,FLOW_MULTICHANNEL_ENABLED:"true"}),()=>{
  const bad:Array<[string,unknown,string]>=[
   ["wa 2 buttons",webDoc("whatsapp",[webOpt(0),webOpt(1)]),"whatsapp"],
   ["wa label 21",webDoc("whatsapp",[webOpt(0,{label:"a".repeat(21)})]),"whatsapp"],
   ["wa http",webDoc("whatsapp",[webOpt(0,{url:"http://example.com"})]),"whatsapp"],
   ["wa credentials",webDoc("whatsapp",[webOpt(0,{url:"https://u:p@example.com"})]),"whatsapp"],
   ["wa empty body",webDoc("whatsapp",[webOpt(0)],"  "),"whatsapp"],
   ["wa url + step",webDoc("whatsapp",[webOpt(0),{id:"s",label:"step"}]),"whatsapp"],
   ["wa quick_reply type",webDoc("whatsapp",[webOpt(0,{buttonType:"quick_reply"})]),"whatsapp"],
   ["wa node platform instagram",webDoc("whatsapp",[webOpt(0)],undefined,{platform:"instagram"}),"whatsapp"],
   ["fb 4 buttons",webDoc("messenger",[0,1,2,3].map(i=>webOpt(i))),"facebook"],
   ["fb text 81",webDoc("messenger",[webOpt(0)],"a".repeat(81)),"facebook"],
   ["fb title 21",webDoc("messenger",[webOpt(0,{label:"a".repeat(21)})]),"facebook"],
   ["fb http",webDoc("messenger",[webOpt(0,{url:"http://example.com"})]),"facebook"],
   ["fb duplicate ids",webDoc("messenger",[webOpt(0),webOpt(0)]),"facebook"],
   ["fb node platform whatsapp",webDoc("messenger",[webOpt(0)],undefined,{platform:"whatsapp"}),"facebook"],
   ["wa image other host",imgDoc("whatsapp",[{id:"b",type:"image",url:MIMG.replace("abcd1234.supabase.co","evil.example.com")}]),"whatsapp"],
   ["fb image other bucket",imgDoc("messenger",[{id:"b",type:"image",url:PROJECT+"/storage/v1/object/public/avatars/a.png"}]),"facebook"],
   ["wa image http",imgDoc("whatsapp",[{id:"b",type:"image",url:MIMG.replace("https:","http:")}]),"whatsapp"],
   ["wa image + buttons",imgDoc("whatsapp",undefined,{options:[{id:"o",label:"x"}]}),"whatsapp"],
   ["fb pdf block",imgDoc("messenger",[{id:"b",type:"pdf",url:MIMG},{id:"c",type:"image",url:MIMG}]),"facebook"],
   ["wa text blocks only",imgDoc("whatsapp",[{id:"b",type:"text",text:"x"}]),"whatsapp"],
   ["wa legacy d.image",imgDoc("whatsapp",[],{image:MIMG}),"whatsapp"],
  ];
  for(const [why,doc,platform] of bad)assert.equal(supportedDurableDocument(doc,platform),false,why);
  assert.equal(supportedDurableDocument(webDoc("whatsapp",[webOpt(0,{label:"😀".repeat(20)})]),"whatsapp"),true);
  assert.equal(supportedDurableDocument(webDoc("messenger",[webOpt(0)],"a".repeat(80)),"facebook"),true);
  // WebP passes the ingress allowlist; the WhatsApp worker refuses it (wa_image_format_unsupported, no request).
  assert.equal(supportedDurableDocument(imgDoc("whatsapp",[{id:"b",type:"image",url:MWEBP}]),"whatsapp"),true);
 });
 // Capabilities (pure): images / website buttons representable, limits kept.
 assert.equal(multichannelCapabilityProblem(imgDoc("whatsapp"),"whatsapp"),null);
 assert.equal(multichannelCapabilityProblem(imgDoc("messenger"),"facebook"),null);
 assert.equal(multichannelCapabilityProblem(imgDoc("whatsapp",[{id:"b",type:"pdf",url:MIMG}]),"whatsapp"),"media_unsupported");
 assert.equal(multichannelCapabilityProblem(imgDoc("whatsapp",undefined,{options:[{id:"o",label:"x"}]}),"whatsapp"),"media_unsupported");
 assert.equal(multichannelCapabilityProblem(imgDoc("messenger",[{id:"b",type:"image",url:MIMG},{id:"t",type:"text",text:"x".repeat(2001)}]),"facebook"),"text_too_long");
 assert.equal(multichannelCapabilityProblem(webDoc("whatsapp",[webOpt(0)]),"whatsapp"),null);
 assert.equal(multichannelCapabilityProblem(webDoc("whatsapp",[webOpt(0),webOpt(1)]),"whatsapp"),"website_buttons_invalid");
 assert.equal(multichannelCapabilityProblem(webDoc("messenger",[0,1,2,3].map(i=>webOpt(i))),"facebook"),"website_buttons_invalid");
});
const planOf=(doc:any,key="mid.start")=>planUntilWait(doc,createRuntimeState(doc,"flow",1),
 {eventKey:key,nowMs:1750000000000,seed:seedFromEventKey(key)});
test("planner + safePlan per platform: same effects as Instagram, committed only behind the flags",async()=>{
 const wa=planOf(webDoc("whatsapp",[webOpt(0)])),fb=planOf(webDoc("messenger",[webOpt(0),webOpt(1),webOpt(2)]));
 assert.deepEqual(wa.effects.map(e=>e.kind),["message","message"]);
 assert.deepEqual((wa.effects[0] as any).websiteButtons,[{label:"زر 0",url:"https://example.com/p0"}]);
 assert.equal((fb.effects[0] as any).websiteButtons.length,3);
 const img=planOf(imgDoc("whatsapp")),fbImg=planOf(imgDoc("messenger"));
 assert.deepEqual(img.effects.map(e=>[e.kind,e.seq]),[["message",0],["message_image",1],["message",2],["message",3]]);
 assert.equal((img.effects[1] as any).url,MIMG);
 assert.deepEqual(fbImg.effects.map(e=>e.kind),img.effects.map(e=>e.kind));
 const ALL={...MEDIA,...RICH,FLOW_MULTICHANNEL_ENABLED:"true"};
 const sp=(e:Record<string,string|undefined>,plan:any,platform:string)=>withEnv(plain(e),()=>safePlan(plan,platform));
 for(const [plan,platform,feature] of [[wa,"whatsapp","FLOW_RICH_BUTTONS_ENABLED"],[fb,"facebook","FLOW_RICH_BUTTONS_ENABLED"],
  [img,"whatsapp","FLOW_MEDIA_SEND_ENABLED"],[fbImg,"facebook","FLOW_MEDIA_SEND_ENABLED"]] as const){
  assert.equal(await sp(ALL,plan,platform),true,platform+" ON");
  assert.equal(await sp({...ALL,FLOW_MULTICHANNEL_ENABLED:undefined},plan,platform),false,platform+" multichannel OFF");
  assert.equal(await sp({...ALL,[feature]:undefined},plan,platform),false,platform+" "+feature+" OFF");
  assert.equal(await sp(ALL,plan,"telegram"),false);
 }
 // Re-validated at commit time (tampered / out-of-limit effects are never committed).
 const tamper=(plan:any,over:Record<string,unknown>)=>({...plan,effects:plan.effects.map((e:any,i:number)=>i===0?{...e,...over}:e)});
 assert.equal(await sp(ALL,tamper(wa,{websiteButtons:[{label:"a",url:"https://a.example"},{label:"b",url:"https://b.example"}]}),"whatsapp"),false);
 assert.equal(await sp(ALL,tamper(wa,{websiteButtons:[{label:"a",url:"http://a.example"}]}),"whatsapp"),false);
 assert.equal(await sp(ALL,tamper(wa,{text:"x".repeat(1025)}),"whatsapp"),false);
 assert.equal(await sp(ALL,tamper(fb,{websiteButtons:[0,1,2,3].map(i=>({label:"b",url:"https://a.example/"+i}))}),"facebook"),false);
 assert.equal(await sp(ALL,tamper(fb,{text:"x".repeat(641)}),"facebook"),false);
 const badImg={...img,effects:img.effects.map((e:any)=>e.kind==="message_image"?{...e,url:MIMG.replace("abcd1234.supabase.co","evil.example.com")}:e)};
 assert.equal(await sp(ALL,badImg,"whatsapp"),false);
 assert.equal(await sp({...ALL,SUPABASE_URL:"https://other9999.supabase.co"},img,"whatsapp"),false,"other project");
 // Default platform (Instagram) keeps its rule: a 1-button plan is valid there, a 4-button one is not.
 assert.equal(await sp({...RICH},wa,"instagram"),true);
 assert.equal(await sp({...ALL},wa),await sp({...RICH},wa));
});
for(const [platform,docPlatform] of [["whatsapp","whatsapp"],["facebook","messenger"]] as const){
 test(`end-to-end ${platform}: image and URL-button runs commit their effects only with every flag ON`,async()=>{
  const ALL={...MEDIA,...RICH,FLOW_MULTICHANNEL_ENABLED:"true",FLOW_DURABLE_INGRESS_ENABLED:"true",
   FLOW_DURABLE_CANARY_ACCOUNT_ID:ids.accountId};
  const ev={...ids,platform,providerEventIdGenuine:true,eventId:"mid.start"};
  for(const [doc,feature,kinds] of [
   [imgDoc(docPlatform),"FLOW_MEDIA_SEND_ENABLED",["message","message_image","message","message"]],
   [webDoc(docPlatform,[webOpt(0)]),"FLOW_RICH_BUTTONS_ENABLED",["message","message"]]] as const){
   const on=mcDb(platform,{document:doc});
   assert.equal(await withEnv(plain(ALL),()=>attemptDurableInstagram(on.db,ev)),"handled");
   assert.deepEqual(on.calls.map(c=>c.name),["flow_claim_inbound_durable","flow_begin_durable_run_superseding"]);
   const effects=on.calls[1].args.p_effects;
   assert.deepEqual(effects.map((e:any)=>e.kind),kinds);
   assert.equal(on.calls[0].args.p_platform,platform);
   if(feature==="FLOW_MEDIA_SEND_ENABLED")assert.equal(effects[1].payload.url,MIMG);
   else assert.deepEqual(effects[0].payload.websiteButtons,[{label:"زر 0",url:"https://example.com/p0"}]);
   for(const off of [{FLOW_MULTICHANNEL_ENABLED:undefined},{[feature]:undefined}]){
    const h=mcDb(platform,{document:doc});
    assert.equal(await withEnv(plain({...ALL,...off}),()=>attemptDurableInstagram(h.db,ev)),"fallback",JSON.stringify(off));
    assert.deepEqual(h.calls,[],"nothing claimed or committed");
   }
  }
 });
}
