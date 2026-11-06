import {test} from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {readFileSync} from "node:fs";
import {supportedDurableDocument,attemptDurableInstagram}
 from "../supabase/functions/milan-api/flowDurableIngress.ts";
import {multichannelCapabilityProblem,DOCUMENT_PLATFORM}
 from "../supabase/functions/milan-api/flowPlatformCapabilities.ts";
import {verifyMetaWebhookSignature} from "../supabase/functions/milan-api/metaSignature.ts";

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

test("durable whitelist stays Instagram-only (WhatsApp/Messenger triggers fall back to V2)",()=>{
 assert.equal(supportedDurableDocument(docFor("instagram")),true);
 for(const p of ["whatsapp","messenger","facebook"])assert.equal(supportedDurableDocument(docFor(p)),false);
});
test("durable ingress never touches the DB for WhatsApp/Facebook events, flag ON or OFF",async()=>{
 const old=(globalThis as any).Deno;
 const db={from(){throw Error("db touched");},rpc(){throw Error("db touched");}} as any;
 try{
  for(const multichannel of ["true",undefined]){
   (globalThis as any).Deno={env:{get:(k:string)=>k==="FLOW_DURABLE_INGRESS_ENABLED"?"true":
    k==="FLOW_DURABLE_CANARY_ACCOUNT_ID"?ids.accountId:
    k==="FLOW_MULTICHANNEL_ENABLED"?multichannel:undefined}};
   for(const platform of ["whatsapp","facebook"])
    assert.equal(await attemptDurableInstagram(db,{...ids,eventId:"wamid.1",platform,
     providerEventIdGenuine:true}),"fallback");
  }
 }finally{(globalThis as any).Deno=old;}
 // index.ts only calls the durable path for Instagram.
 const src=readFileSync("supabase/functions/milan-api/index.ts","utf8");
 assert.match(src,/if\(channel==="instagram"\)\{\n\s+const durable=await attemptDurableInstagram\(/);
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
