import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {buildWhatsAppRequest,buildFacebookRequest,sendWhatsAppMessage,sendFacebookMessage,
 sendMultichannelMessage,multichannelPayloadProblem,classifyMultichannelFailure,
 MultichannelPayloadError,GRAPH_VERSION,WA_OUTSIDE_WINDOW_CODE}
 from "../supabase/functions/flow-outbox-worker/multichannelSend.ts";
import {sendProviderMessage,ProviderHttpError,deliveredText,type ProviderRequest}
 from "../supabase/functions/flow-outbox-worker/deliveryCore.ts";

const wa:ProviderRequest={platform:"whatsapp",token:"WA_TOKEN",externalId:"1234567890",
 recipient:"9647712345678",text:"مرحبا"};
const fb:ProviderRequest={platform:"facebook",token:"EAApage",externalId:"555000",
 recipient:"700001",text:"hello"};
const built=(r:ReturnType<typeof buildWhatsAppRequest>)=>{
 assert.equal(r.ok,true);
 return (r as Extract<typeof r,{ok:true}>).request;
};
const fail=(r:ReturnType<typeof buildWhatsAppRequest>)=>(r as {ok:false;code:string}).code;
function recorder(response:{status?:number;body?:unknown}={}){
 const calls:{url:string;init:RequestInit}[]=[];
 const perform=(async(url:string,init:RequestInit)=>{
  calls.push({url,init});
  return new Response(JSON.stringify(response.body??{}),{status:response.status??200});
 }) as unknown as typeof fetch;
 return {calls,perform};
}

test("Graph version is the single worker-wide constant (v21.0, same as deliveryCore)",()=>{
 assert.equal(GRAPH_VERSION,"v21.0");
 const core=readFileSync("supabase/functions/flow-outbox-worker/deliveryCore.ts","utf8");
 assert.ok(core.includes("graph.facebook.com/v21.0/"));
});
test("WhatsApp text: exact body, URL and Bearer header",()=>{
 const r=built(buildWhatsAppRequest(wa));
 assert.equal(r.url,"https://graph.facebook.com/v21.0/1234567890/messages");
 assert.deepEqual(r.headers,{"content-type":"application/json",authorization:"Bearer WA_TOKEN"});
 assert.equal(JSON.stringify(r.payload),
  '{"messaging_product":"whatsapp","recipient_type":"individual","to":"9647712345678","type":"text","text":{"body":"مرحبا"}}');
});
test("WhatsApp reply buttons: exact interactive button body",()=>{
 const r=built(buildWhatsAppRequest({...wa,text:"اختر",quickReplies:[
  {id:"prices",label:"الأسعار"},{id:"support",label:"الدعم"},{id:"x_1",label:"Other"}]}));
 assert.deepEqual(r.payload,{messaging_product:"whatsapp",recipient_type:"individual",
  to:"9647712345678",type:"interactive",interactive:{type:"button",body:{text:"اختر"},
  action:{buttons:[
   {type:"reply",reply:{id:"flow-choice:prices",title:"الأسعار"}},
   {type:"reply",reply:{id:"flow-choice:support",title:"الدعم"}},
   {type:"reply",reply:{id:"flow-choice:x_1",title:"Other"}}]}}});
});
test("WhatsApp single website button: exact cta_url body",()=>{
 const r=built(buildWhatsAppRequest({...wa,text:"Visit",
  websiteButtons:[{label:"Open shop",url:"https://shop.example.com/a?b=1"}]}));
 assert.deepEqual(r.payload,{messaging_product:"whatsapp",recipient_type:"individual",
  to:"9647712345678",type:"interactive",interactive:{type:"cta_url",body:{text:"Visit"},
  action:{name:"cta_url",parameters:{display_text:"Open shop",url:"https://shop.example.com/a?b=1"}}}});
});
test("WhatsApp limits fail permanently with a clear code and NO request",async()=>{
 const four=[1,2,3,4].map(i=>({id:"b"+i,label:"B"+i}));
 const cases:[ProviderRequest,string][]=[
  [{...wa,quickReplies:four},"wa_too_many_buttons"],
  [{...wa,quickReplies:[{id:"a",label:"A"}],websiteButtons:[{label:"x",url:"https://a.example"}]},"wa_mixed_buttons"],
  [{...wa,websiteButtons:[{label:"a",url:"https://a.example"},{label:"b",url:"https://b.example"}]},"wa_cta_url_single_only"],
  [{...wa,websiteButtons:[]},"wa_cta_url_single_only"],
  [{...wa,websiteButtons:[{label:"x".repeat(21),url:"https://a.example"}]},"wa_cta_display_text_invalid"],
  [{...wa,websiteButtons:[{label:"ok",url:"http://a.example"}]},"wa_cta_url_invalid"],
  [{...wa,websiteButtons:[{label:"ok",url:"https://u:p@a.example"}]},"wa_cta_url_invalid"],
  [{...wa,quickReplies:[{id:"a",label:"x".repeat(21)}]},"wa_button_title_invalid"],
  [{...wa,quickReplies:[{id:"a b",label:"A"}]},"wa_button_id_invalid"],
  [{...wa,quickReplies:[]},"wa_button_id_invalid"],
  [{...wa,quickReplies:[{id:"a",label:"A"},{id:"a",label:"B"}]},"wa_button_duplicate"],
  [{...wa,quickReplies:[{id:"a",label:"A"},{id:"b",label:"A"}]},"wa_button_duplicate"],
  [{...wa,text:"x".repeat(1025),quickReplies:[{id:"a",label:"A"}]},"wa_body_too_long"],
  [{...wa,text:"x".repeat(1025),websiteButtons:[{label:"ok",url:"https://a.example"}]},"wa_body_too_long"],
  [{...wa,text:"x".repeat(4097)},"wa_text_too_long"],
  [{...wa,text:"  "},"wa_text_invalid"],
  [{...wa,externalId:""},"wa_phone_id_invalid"],
  [{...wa,recipient:"+9647"},"mc_request_invalid"],
  [{...wa,token:""},"mc_request_invalid"],
  [{...wa,text:"",imageUrl:"https://x"},"mc_image_unsupported"],
  [{...wa,platform:"instagram"},"mc_platform_invalid"]
 ];
 for(const [req,code] of cases){
  assert.equal(fail(buildWhatsAppRequest(req)),code,code);
  if(req.platform==="whatsapp")assert.equal(multichannelPayloadProblem(req),code);
  const r=recorder();
  await assert.rejects(()=>sendWhatsAppMessage(req,r.perform),
   (e:unknown)=>e instanceof MultichannelPayloadError&&e.code===code);
  assert.equal(r.calls.length,0,"no request for "+code);
 }
 // Boundaries are accepted.
 assert.equal(multichannelPayloadProblem({...wa,text:"x".repeat(4096)}),null);
 assert.equal(multichannelPayloadProblem({...wa,text:"x".repeat(1024),
  quickReplies:[{id:"a",label:"x".repeat(20)}]}),null);
});
test("Facebook text and quick replies: exact Send API body, Bearer token, never in URL/body",()=>{
 const t=built(buildFacebookRequest(fb));
 assert.equal(t.url,"https://graph.facebook.com/v21.0/me/messages");
 assert.deepEqual(t.headers,{"content-type":"application/json",authorization:"Bearer EAApage"});
 assert.equal(JSON.stringify(t.payload),
  '{"recipient":{"id":"700001"},"messaging_type":"RESPONSE","message":{"text":"hello"}}');
 const q=built(buildFacebookRequest({...fb,text:"اختر",quickReplies:[{id:"a",label:"A"},{id:"b",label:"B"}]}));
 assert.deepEqual(q.payload,{recipient:{id:"700001"},messaging_type:"RESPONSE",message:{text:"اختر",
  quick_replies:[{content_type:"text",title:"A",payload:"flow-choice:a"},
   {content_type:"text",title:"B",payload:"flow-choice:b"}]}});
 assert.ok(!JSON.stringify(q.payload).includes("EAApage")&&!q.url.includes("EAApage"));
});
test("Facebook website buttons reuse the existing Messenger generic template",()=>{
 const w=built(buildFacebookRequest({...fb,text:"Shop",websiteButtons:[{label:"Open",url:"https://a.example/x"}]}));
 assert.deepEqual(w.payload,{recipient:{id:"700001"},messaging_type:"RESPONSE",message:{attachment:{
  type:"template",payload:{template_type:"generic",elements:[{title:"Shop",
   buttons:[{type:"web_url",title:"Open",url:"https://a.example/x"}]}]}}}});
});
test("Facebook limits fail permanently with NO request",async()=>{
 const many=Array.from({length:14},(_,i)=>({id:"o"+i,label:"L"+i}));
 const cases:[ProviderRequest,string][]=[
  [{...fb,quickReplies:many},"fb_quick_replies_invalid"],
  [{...fb,quickReplies:[{id:"a",label:"x".repeat(21)}]},"fb_quick_replies_invalid"],
  [{...fb,quickReplies:[{id:"a",label:"A"}],websiteButtons:[{label:"x",url:"https://a.example"}]},"fb_mixed_buttons"],
  [{...fb,text:"x".repeat(81),websiteButtons:[{label:"x",url:"https://a.example"}]},"fb_website_buttons_invalid"],
  [{...fb,websiteButtons:[1,2,3,4].map(i=>({label:"b"+i,url:"https://a.example"}))},"fb_website_buttons_invalid"],
  [{...fb,text:"x".repeat(2001)},"fb_text_too_long"],
  [{...fb,text:""},"fb_text_invalid"],
  [{...fb,recipient:"abc"},"mc_request_invalid"]
 ];
 for(const [req,code] of cases){
  assert.equal(fail(buildFacebookRequest(req)),code,code);
  const r=recorder();
  await assert.rejects(()=>sendFacebookMessage(req,r.perform),
   (e:unknown)=>e instanceof MultichannelPayloadError&&e.code===code);
  assert.equal(r.calls.length,0);
 }
 assert.equal(multichannelPayloadProblem({...fb,quickReplies:many.slice(0,13)}),null);
});
test("send returns the provider id (WhatsApp messages[0].id, Facebook message_id)",async()=>{
 const a=recorder({body:{messaging_product:"whatsapp",messages:[{id:"wamid.OUT"}]}});
 assert.equal(await sendMultichannelMessage(wa,a.perform),"wamid.OUT");
 assert.equal(a.calls.length,1);
 assert.equal(a.calls[0].init.body,JSON.stringify(built(buildWhatsAppRequest(wa)).payload));
 const b=recorder({body:{recipient_id:"700001",message_id:"m_OUT"}});
 assert.equal(await sendMultichannelMessage(fb,b.perform),"m_OUT");
 const c=recorder({body:{}});
 assert.equal(await sendFacebookMessage(fb,c.perform),null,"2xx without id -> uncertain upstream");
});
test("placeholders are scrubbed once; stored body (deliveredText) equals the sent text",async()=>{
 for(const req of [{...wa,text:"Hi {{first_name}}"},{...fb,text:"Hi {{first_name}}"},
  {...wa,text:"Hi {{x}}",websiteButtons:[{label:"Go {{y}}",url:"https://a.example"}]}] as ProviderRequest[]){
  const r=recorder({body:{messages:[{id:"w"}],message_id:"m"}});
  await sendMultichannelMessage(req,r.perform);
  const body=JSON.parse(String(r.calls[0].init.body));
  const sent=body.text?.body??body.message?.text??body.interactive?.body?.text;
  assert.equal(sent,deliveredText(req));
  assert.doesNotMatch(JSON.stringify(body),/\{\{/);
 }
});
test("error classification: 131047 permanent, 4xx permanent, auth, 5xx/429/network uncertain",async()=>{
 const r=recorder({status:400,body:{error:{code:WA_OUTSIDE_WINDOW_CODE,message:"Re-engagement message"}}});
 let caught:unknown;
 try{await sendWhatsAppMessage(wa,r.perform);}catch(e){caught=e;}
 assert.ok(caught instanceof ProviderHttpError);
 assert.equal(r.calls.length,1,"exactly one request, never retried");
 assert.equal(classifyMultichannelFailure(caught),"wa_outside_service_window");
 assert.equal(classifyMultichannelFailure(new ProviderHttpError(400,100)),"provider_rejected");
 assert.equal(classifyMultichannelFailure(new ProviderHttpError(401,190)),"auth");
 assert.equal(classifyMultichannelFailure(new ProviderHttpError(400,190)),"auth");
 for(const s of [408,429,500,503])assert.equal(classifyMultichannelFailure(new ProviderHttpError(s,null)),"uncertain");
 assert.equal(classifyMultichannelFailure(new TypeError("network")),"uncertain");
 assert.equal(classifyMultichannelFailure(new MultichannelPayloadError("wa_mixed_buttons")),"payload_refused");
});
test("Instagram request bodies through sendProviderMessage are byte-identical (untouched)",async()=>{
 const calls:{url:string;body:string}[]=[];
 const perform=(async(url:string,init:RequestInit)=>{calls.push({url,body:String(init.body)});
  return new Response('{"message_id":"m"}',{status:200});}) as unknown as typeof fetch;
 await sendProviderMessage({platform:"instagram",token:"IGtoken",externalId:"1784000001",recipient:"123456",
  text:"hi",quickReplies:[{id:"a",label:"A"}]},perform);
 await sendProviderMessage({platform:"instagram",token:"EAAtoken",externalId:"1784000001",recipient:"123456",text:"hi"},perform);
 assert.deepEqual(calls,[
  {url:"https://graph.instagram.com/v21.0/me/messages",
   body:'{"recipient":{"id":"123456"},"message":{"text":"hi","quick_replies":[{"content_type":"text","title":"A","payload":"flow-choice:a"}]}}'},
  {url:"https://graph.facebook.com/v21.0/1784000001/messages",
   body:'{"recipient":{"id":"123456"},"message":{"text":"hi"},"access_token":"EAAtoken"}'}]);
 const src=readFileSync("supabase/functions/flow-outbox-worker/multichannelSend.ts","utf8");
 assert.doesNotMatch(src,/Deno\./,"builders read no env");
});
test("worker: multichannel path is flag-gated, pre-validated before reserve, Instagram block unchanged",()=>{
 const code=readFileSync("supabase/functions/flow-outbox-worker/index.ts","utf8");
 assert.match(code,/const multichannel=env\("FLOW_MULTICHANNEL_ENABLED"\)==="true"&&/);
 const check=code.indexOf("const problem=multichannelPayloadProblem(");
 const mcReserve=code.indexOf("const sent=await executeOnce({");
 const igSend=code.indexOf("const res=await executeOnce({");
 assert.ok(check>0&&mcReserve>check&&igSend>mcReserve);
 assert.ok(code.indexOf("!canDispatchOutbox({")<check,"production gate first");
 assert.match(code,/if\(multichannel && imageUrl===undefined\)\{\n\s+let multichannelFailure/);
 // The Instagram/legacy executeOnce still calls sendProviderMessage unchanged.
 assert.match(code,/send:\(\)=>imageUrl===undefined\?sendProviderMessage\(\{\n\s+platform:account\.platform,externalId:String\(account\.external_id\?\?""\),\n\s+token,recipient,text:messageText,quickReplies,websiteButtons\n\s+\}\)/);
 assert.equal((code.match(/sb\.rpc\("consume_flow_reply"/g)??[]).length,1,"billing path shared, not duplicated");
});
