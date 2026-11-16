// T6-S3: Meta status / error code / subcode / type are preserved for failed
// TEXT deliveries of the Outbox worker and classified for observability ONLY.
// A text failure still finishes 'uncertain' (never 'rejected'), is never
// resent and never billed; messages are byte-identical to the old plain Error.
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {executeOnce} from "../supabase/functions/flow-outbox-worker/executeOnce.ts";
import {sendProviderMessage,ProviderHttpError,ProviderTextHttpError,metaErrorInfo,
 classifyTextSendFailure,describeTextSendFailure,META_ERROR_BODY_MAX,META_THROTTLE_CODES,
 type ProviderRequest} from "../supabase/functions/flow-outbox-worker/deliveryCore.ts";
import {sendMultichannelMessage,classifyMultichannelFailure}
 from "../supabase/functions/flow-outbox-worker/multichannelSend.ts";
import {classifyMediaFailure,finishOutcome,type MediaFailure}
 from "../supabase/functions/flow-outbox-worker/mediaPolicy.ts";

const TOKEN="IGCANARYTOKEN_s3cr3t",EAA="EAACANARYTOKEN_s3cr3t",WA_TOKEN="WACANARYTOKEN_s3cr3t";
const TEXT="CANARY_CUSTOMER_TEXT مرحبا";
const CANARIES=[TOKEN,EAA,WA_TOKEN,"CANARY_CUSTOMER_TEXT","CANARY_META_MESSAGE","FBTRACE_CANARY",
 "graph.instagram.com","graph.facebook.com","authorization","Bearer","access_token"];

/** Fake fetch returning a raw body string (or null) with the given status. */
function fake(status:number,body:string|null|unknown){
 const calls:Array<{url:string;init:RequestInit}>=[];
 const perform=(async(url:string,init:RequestInit)=>{
  calls.push({url,init});
  const raw=body===null||typeof body==="string"?body as string|null:JSON.stringify(body);
  return new Response(raw,{status});
 }) as typeof fetch;
 return {calls,perform};
}
const metaBody=(error:unknown)=>({error});
const full=(code:unknown,subcode?:unknown)=>metaBody({message:"CANARY_META_MESSAGE "+TEXT,
 type:"OAuthException",code,...(subcode!==undefined?{error_subcode:subcode}:{}),fbtrace_id:"FBTRACE_CANARY"});

const PATHS:Array<[string,ProviderRequest]>=[
 ["instagram (IG login)",{platform:"instagram",token:TOKEN,externalId:"",recipient:"123456",text:TEXT}],
 ["instagram (page token)",{platform:"instagram",token:EAA,externalId:"1784000001",recipient:"123456",text:TEXT}],
 ["facebook",{platform:"facebook",token:EAA,externalId:"",recipient:"123456",text:TEXT}],
 ["whatsapp",{platform:"whatsapp",token:WA_TOKEN,externalId:"100001",recipient:"9647712345678",text:TEXT}],
 ["instagram buttons",{platform:"instagram",token:TOKEN,externalId:"",recipient:"123456",text:TEXT,
  websiteButtons:[{label:"site",url:"https://example.com/p"}]}],
 ["instagram private reply",{platform:"instagram",token:TOKEN,externalId:"",recipient:"123456",text:TEXT,
  recipientCommentId:"1801"}],
];
async function caught(p:Promise<unknown>):Promise<unknown>{
 try{await p;}catch(e){return e;}
 throw Error("expected a rejection");
}
function noLeak(value:unknown,label:string){
 const texts=[JSON.stringify(value)??"",String(value)];
 if(value instanceof Error)texts.push(value.message,String(value.stack),
  JSON.stringify(Object.fromEntries(Object.getOwnPropertyNames(value).map(k=>[k,(value as any)[k]]))));
 for(const t of texts)for(const c of CANARIES)assert.ok(!t.includes(c),label+" leaks "+c);
}

// ---------------------------------------------------------------- message contract
test("text failure message is byte-identical to the old plain Error on every channel path",async()=>{
 for(const [label,req] of PATHS)for(const status of [400,401,403,404,408,429,500,502,503]){
  const f=fake(status,full(10,2018278));
  const e=await caught(sendProviderMessage(req,f.perform));
  assert.ok(e instanceof Error,label);
  // Old code: throw Error("Provider HTTP "+res.status)
  assert.equal((e as Error).message,"Provider HTTP "+status,label);
  assert.equal((e as Error).message,Error("Provider HTTP "+status).message);
  assert.equal((e as Error).name,"Error",label+" name unchanged");
  assert.equal(String(e),"Error: Provider HTTP "+status);
  assert.ok(e instanceof ProviderTextHttpError,label);
  assert.ok(!(e instanceof ProviderHttpError),label+" not the image error class");
  assert.equal(f.calls.length,1,label+" exactly one request");
  assert.equal((e as ProviderTextHttpError).meta.status,status);
  noLeak(e,label+" "+status);
 }
});

// ---------------------------------------------------------------- preservation + classification
test("Messenger/Instagram code 10: subcode 2018278 -> outside_window; without it -> permanent_other",async()=>{
 for(const [label,req] of PATHS.filter(([,r])=>r.platform!=="whatsapp")){
  const e=await caught(sendProviderMessage(req,fake(400,full(10,2018278)).perform)) as ProviderTextHttpError;
  assert.deepEqual({...e.meta},{status:400,code:10,subcode:2018278,type:"OAuthException"},label);
  assert.deepEqual(describeTextSendFailure(e),{class:"outside_window",status:400,code:10,subcode:2018278});
  const plain=await caught(sendProviderMessage(req,fake(400,full(10)).perform)) as ProviderTextHttpError;
  assert.deepEqual({...plain.meta},{status:400,code:10,type:"OAuthException"});
  assert.deepEqual(describeTextSendFailure(plain),{class:"permanent_other",status:400,code:10,subcode:null});
  // 5xx with the same code/subcode is never definite.
  const five=await caught(sendProviderMessage(req,fake(500,full(10,2018278)).perform));
  assert.deepEqual(describeTextSendFailure(five),{class:"ambiguous",status:500,code:10,subcode:2018278});
 }
});
test("WhatsApp 131047: 4xx -> outside_window with status kept; 5xx -> ambiguous (not definite)",async()=>{
 const wa=PATHS.find(([l])=>l==="whatsapp")![1];
 const e=await caught(sendProviderMessage(wa,fake(400,full(131047)).perform));
 assert.deepEqual(describeTextSendFailure(e),{class:"outside_window",status:400,code:131047,subcode:null});
 for(const s of [500,502,503,504]){
  const x=await caught(sendProviderMessage(wa,fake(s,full(131047)).perform));
  assert.deepEqual(describeTextSendFailure(x),{class:"ambiguous",status:s,code:131047,subcode:null},String(s));
 }
 // Multichannel WhatsApp text (ProviderHttpError): same coarse class, legacy classifier unchanged.
 const m=await caught(sendMultichannelMessage(wa,fake(400,full(131047)).perform));
 assert.ok(m instanceof ProviderHttpError);
 assert.equal(classifyMultichannelFailure(m),"wa_outside_service_window");
 assert.deepEqual(describeTextSendFailure(m),{class:"outside_window",status:400,code:131047,subcode:null});
 const m5=await caught(sendMultichannelMessage(wa,fake(500,full(131047)).perform));
 assert.equal(describeTextSendFailure(m5).class,"ambiguous");
});
test("Messenger multichannel text keeps the subcode; legacy classification outputs unchanged",async()=>{
 const fb=PATHS.find(([l])=>l==="facebook")![1];
 const e=await caught(sendMultichannelMessage(fb,fake(400,full(10,2018278)).perform)) as ProviderHttpError;
 assert.ok(e instanceof ProviderHttpError);
 assert.equal(e.message,"Provider HTTP 400");
 assert.equal(e.status,400);assert.equal(e.metaCode,10);assert.equal(e.metaSubcode,2018278);
 assert.equal(e.metaType,"OAuthException");
 assert.equal(classifyMultichannelFailure(e),"provider_rejected","existing output stable");
 assert.equal(describeTextSendFailure(e).class,"outside_window");
 noLeak(e,"multichannel fb");
 // Constructor defaults unchanged for existing callers.
 const legacy=new ProviderHttpError(400,100);
 assert.equal(legacy.metaSubcode,null);assert.equal(legacy.metaType,null);assert.equal(legacy.message,"Provider HTTP 400");
});
test("unknown Meta code -> ambiguous with the code preserved; documented codes map conservatively",async()=>{
 const ig=PATHS[0][1];
 const e=await caught(sendProviderMessage(ig,fake(400,full(99999)).perform));
 assert.deepEqual(describeTextSendFailure(e),{class:"ambiguous",status:400,code:99999,subcode:null});
 const C=classifyTextSendFailure;
 assert.equal(C(400,190),"auth");assert.equal(C(401,190),"auth");assert.equal(C(401),"auth");assert.equal(C(403),"auth");
 assert.equal(C(400,100),"rejected_invalid");assert.equal(C(400,100,2534014),"rejected_invalid");
 for(const code of [4,17,32,613,130429,131056]){
  assert.equal(C(400,code),"throttled",String(code));assert.equal(C(429,code),"throttled",String(code));
  assert.equal(C(500,code),"ambiguous",String(code));
 }
 assert.deepEqual([...META_THROTTLE_CODES].sort((a,b)=>a-b),[4,17,32,130429,131056,613].sort((a,b)=>a-b));
 for(const s of [200,201,204,301,408,429,500,503,599,0,-1,NaN,Infinity,400.5,"400",null,undefined,{}])
  assert.equal(C(s as any),"ambiguous",String(s));
 assert.equal(C(408,131047),"ambiguous","408 is a timeout");
 assert.equal(C(400),"ambiguous","4xx without a code is not definite");
 assert.equal(C(404),"ambiguous");
 assert.equal(C(400,1),"ambiguous");assert.equal(C(400,2),"ambiguous");
});
test("auth 190 and rate limits are classified on the real text path and NOT retried",async()=>{
 const ig=PATHS[0][1];
 const a=await caught(sendProviderMessage(ig,fake(400,full(190)).perform));
 assert.equal(describeTextSendFailure(a).class,"auth");
 for(const code of [4,17,32,613,130429,131056]){
  const f=fake(400,full(code));let sends=0;const events:string[]=[];
  let failure:ReturnType<typeof describeTextSendFailure>|null=null;
  const res=await executeOnce({reserve:async()=>true,
   send:()=>{sends++;return sendProviderMessage(ig,f.perform).catch(e=>{failure=describeTextSendFailure(e);throw e;});},
   confirm:async(s,id)=>{events.push(s+":"+id);return true;},
   persistAndBill:async()=>{events.push("UNEXPECTED_BILL");return true;}});
  assert.equal(res,"uncertain");assert.equal(sends,1);assert.equal(f.calls.length,1,"no retry");
  assert.deepEqual(events,["uncertain:null"]);
  assert.equal(failure!.class,"throttled",String(code));
 }
});

// ---------------------------------------------------------------- hostile / malformed bodies
test("missing / non-JSON / malformed / oversized bodies never throw out and classify ambiguous",async()=>{
 const ig=PATHS[0][1];
 const huge=JSON.stringify({error:{code:10,error_subcode:2018278,message:"x".repeat(META_ERROR_BODY_MAX)}});
 assert.ok(huge.length>META_ERROR_BODY_MAX);
 const bodies:Array<[string,string|null|unknown]>=[
  ["missing",null],["empty",""],["non-JSON","<html>502 CANARY_META_MESSAGE</html>"],["truncated",'{"error":{"code":10'],
  ["no error",{message:"CANARY_META_MESSAGE"}],["error string",{error:"CANARY_META_MESSAGE"}],["error null",{error:null}],
  ["error array",{error:[10]}],["array body",[{error:{code:10}}]],["number body",42],["string body",'"x"'],
  ["code string",full("10","2018278")],["code float",full(10.5)],["code negative",full(-10)],
  ["code huge",full(1e12)],["code 2^60",full(2**60)],["code bool",full(true)],["code object",full({v:10})],
  ["oversized",huge]];
 for(const [label,body] of bodies){
  const e=await caught(sendProviderMessage(ig,fake(400,body).perform));
  assert.ok(e instanceof ProviderTextHttpError,label);
  assert.equal((e as Error).message,"Provider HTTP 400",label);
  assert.equal((e as ProviderTextHttpError).meta.code,undefined,label);
  const d=describeTextSendFailure(e);
  assert.equal(d.code,null,label);assert.equal(d.class,"ambiguous",label);
  noLeak(e,label);
 }
 // Unreadable body stream (text() rejects): still the same error, ambiguous.
 const broken=(async()=>{const r=new Response("{}",{status:400});
  Object.defineProperty(r,"text",{value:()=>Promise.reject(Error("CANARY_META_MESSAGE"))});return r;}) as unknown as typeof fetch;
 const b=await caught(sendProviderMessage(ig,broken));
 assert.equal((b as Error).message,"Provider HTTP 400");assert.equal(describeTextSendFailure(b).class,"ambiguous");
 noLeak(b,"broken stream");
});
test("hostile objects (throwing getters, proxies) never throw out of the parser or classifier",()=>{
 const boom=()=>{throw Error("CANARY_META_MESSAGE");};
 const getterError=Object.defineProperty({},"code",{get:boom,enumerable:true});
 const getterBody=Object.defineProperty({},"error",{get:boom,enumerable:true});
 const proxy=new Proxy({},{get:boom,has:boom,ownKeys:boom,getPrototypeOf:boom,getOwnPropertyDescriptor:boom});
 for(const v of [getterBody,{error:getterError},proxy,{error:proxy},null,undefined,0,"x",Symbol("s")])
  assert.deepEqual(metaErrorInfo(v),{});
 for(const v of [proxy,getterError,null,undefined,"Provider HTTP 400",Error("Provider HTTP 400"),
  new TypeError("network"),{status:400,metaCode:10},{meta:{status:400,code:10}}]){
  assert.deepEqual(describeTextSendFailure(v),{class:"ambiguous",status:null,code:null,subcode:null});
 }
 assert.equal(classifyTextSendFailure(proxy as any,proxy,proxy),"ambiguous");
 assert.equal(classifyTextSendFailure(400,proxy,proxy),"ambiguous");
 // Constructors re-validate whatever info they get, and never throw.
 const t=new ProviderTextHttpError(400,proxy as any);
 assert.deepEqual({...t.meta},{status:400});assert.ok(Object.isFrozen(t.meta));
 const t2=new ProviderTextHttpError(400,{code:"10" as any,subcode:-1,type:"bad type <script>"});
 assert.deepEqual({...t2.meta},{status:400});
 const h=new ProviderHttpError(400,10,{subcode:getterError as any,type:proxy as any});
 assert.equal(h.metaSubcode,null);assert.equal(h.metaType,null);
});

// ---------------------------------------------------------------- state machine unchanged
type Finish="confirmed"|"uncertain"|"rejected";
/** Same send/confirm wiring as flow-outbox-worker/index.ts (legacy + multichannel). */
async function runWorker(kind:"legacy"|"multichannel",req:ProviderRequest,f:ReturnType<typeof fake>,db:"new"|"old"="new"){
 const finishes:Finish[]=[];const media={failure:null as MediaFailure|null,rejected:false};
 const textSend={failure:null as ReturnType<typeof describeTextSendFailure>|null};
 let sends=0,bills=0;const image=req.imageUrl!==undefined;
 const res=await executeOnce({
  reserve:async()=>true,
  send:()=>{sends++;
   if(kind==="multichannel")return sendMultichannelMessage(req,f.perform).catch(e=>{
    classifyMultichannelFailure(e);
    if(image)media.failure=classifyMediaFailure(e);
    if(!image)textSend.failure=describeTextSendFailure(e);
    throw e;});
   return !image?sendProviderMessage(req,f.perform).catch(e=>{textSend.failure=describeTextSendFailure(e);throw e;}):
    sendProviderMessage(req,f.perform).catch(e=>{media.failure=classifyMediaFailure(e);throw e;});
  },
  confirm:async(status,providerId)=>{
   const finish=async(r:Finish)=>{finishes.push(r);assert.equal(providerId,r==="confirmed"?providerId:null);
    return db==="new"||r!=="rejected";};
   if(finishOutcome(status,media.failure)==="rejected"){
    if(await finish("rejected")){media.rejected=true;return true;}
   }
   return await finish(status);
  },
  persistAndBill:async()=>{bills++;return true;}
 });
 return {report:media.rejected?"dead_letter_media_rejected":res,finishes,sends,bills,requests:f.calls.length,
  text:textSend.failure};
}
test("executeOnce: every classified text failure still finishes 'uncertain' with null id, once, never 'rejected'",async()=>{
 const cases:Array<[number,unknown]>=[[400,full(10,2018278)],[400,full(10)],[400,full(131047)],[400,full(190)],
  [401,{}],[400,full(4)],[429,full(613)],[400,full(100)],[404,{}],[400,full(99999)],[500,full(131047)],[503,null],[400,"x"]];
 for(const [label,req] of PATHS)for(const kind of ["legacy","multichannel"] as const){
  if(kind==="multichannel"&&req.platform==="instagram")continue;
  for(const [status,body] of cases){
   const out=await runWorker(kind,req,fake(status,body));
   const tag=kind+" "+label+" "+status+" "+JSON.stringify(body);
   assert.equal(out.report,"uncertain",tag);
   assert.deepEqual(out.finishes,["uncertain"],tag+" no 'rejected' call");
   assert.equal(out.sends,1,tag);assert.equal(out.requests,1,tag+" no second provider call");
   assert.equal(out.bills,0,tag+" never billed");
   assert.ok(out.text&&out.text.status===status,tag+" status preserved");
   noLeak(out.text,tag);
   assert.deepEqual(Object.keys(out.text!),["class","status","code","subcode"]);
  }
 }
 // Even if a text error were (wrongly) given to the image classifier it could not become 'rejected'.
 const e=await caught(sendProviderMessage(PATHS[0][1],fake(400,full(100)).perform));
 assert.equal(classifyMediaFailure(e),"uncertain");
 assert.equal(classifyMultichannelFailure(e),"uncertain");
 assert.equal(finishOutcome("uncertain",classifyMediaFailure(e)),"uncertain");
});
test("success path unchanged: 2xx with id is confirmed + billed once; 2xx without id stays uncertain",async()=>{
 const ig=PATHS[0][1],wa=PATHS[3][1];
 const ok=await runWorker("legacy",ig,fake(200,{message_id:"mid-1"}));
 assert.deepEqual(ok,{report:"settled",finishes:["confirmed"],sends:1,bills:1,requests:1,text:null});
 const okWa=await runWorker("legacy",wa,fake(200,{messages:[{id:"wamid.1"}]}));
 assert.equal(okWa.report,"settled");
 const okMc=await runWorker("multichannel",wa,fake(200,{messages:[{id:"wamid.2"}]}));
 assert.equal(okMc.report,"settled");assert.equal(okMc.text,null);
 assert.equal(await sendProviderMessage(ig,fake(200,{message_id:"mid-2"}).perform),"mid-2");
 const noId=await runWorker("legacy",ig,fake(200,{}));
 assert.deepEqual(noId,{report:"uncertain",finishes:["uncertain"],sends:1,bills:0,requests:1,text:null});
 assert.equal(classifyTextSendFailure(200),"ambiguous","2xx without id is never definite");
});
test("image 4xx unchanged: Instagram/WhatsApp/Messenger image rejected -> 'rejected' (dead_letter), 5xx uncertain",async()=>{
 const PROJECT="https://abcd1234.supabase.co";
 const url=PROJECT+"/storage/v1/object/public/flow-media/u1/0f8c2b1e-1111-4222-8333-444455556666.png";
 const ig:ProviderRequest={platform:"instagram",token:TOKEN,externalId:"",recipient:"123456",text:"",imageUrl:url,imageHost:PROJECT};
 const img=await caught(sendProviderMessage(ig,fake(400,full(100)).perform));
 assert.ok(img instanceof ProviderHttpError);assert.equal((img as ProviderHttpError).metaCode,100);
 assert.deepEqual(await runWorker("legacy",ig,fake(400,full(100))),
  {report:"dead_letter_media_rejected",finishes:["rejected"],sends:1,bills:0,requests:1,text:null});
 assert.deepEqual((await runWorker("legacy",ig,fake(500,{}))).finishes,["uncertain"]);
 assert.deepEqual((await runWorker("legacy",ig,fake(400,full(100)),"old")).finishes,["rejected","uncertain"]);
 for(const req of [{...ig,platform:"whatsapp",token:WA_TOKEN,externalId:"100001",recipient:"9647712345678"},
  {...ig,platform:"facebook",token:EAA}] as ProviderRequest[]){
  const out=await runWorker("multichannel",req,fake(400,full(131047,2018278)));
  assert.deepEqual(out,{report:"dead_letter_media_rejected",finishes:["rejected"],sends:1,bills:0,requests:1,text:null},req.platform);
  assert.deepEqual((await runWorker("multichannel",req,fake(503,{}))).finishes,["uncertain"]);
 }
});

// ---------------------------------------------------------------- worker wiring (static)
test("index.ts wiring: classification is logged only; finish, retry, billing and charge_pending untouched",()=>{
 const code=readFileSync("supabase/functions/flow-outbox-worker/index.ts","utf8");
 assert.equal((code.match(/textSend\.failure=describeTextSendFailure\(e\);/g)??[]).length,2);
 assert.equal((code.match(/textSend\./g)??[]).length,6,"2 assignments + 2 guarded logs (x2 refs)");
 assert.equal((code.match(/console\.warn\("\[outbox\] text send failed",textSend\.failure\);/g)??[]).length,2);
 assert.match(code,/\n\s+if\(imageUrl===undefined\)textSend\.failure=describeTextSendFailure\(e\);\n/);
 assert.match(code,/\}\)\.catch\(e=>\{textSend\.failure=describeTextSendFailure\(e\);throw e;\}\):sendProviderMessage\(\{/);
 // The classification never reaches confirm/finish, report() or a retry.
 for(const start of ["const sent=await executeOnce({","const res=await executeOnce({"]){
  const block=code.slice(code.indexOf(start),code.indexOf("persistAndBill\n",code.indexOf(start)));
  const confirm=block.slice(block.indexOf("confirm:async(status,providerId)=>{"));
  assert.ok(confirm.length>0&&!confirm.includes("textSend"),start);
 }
 assert.doesNotMatch(code,/report\([^)]*textSend/);
 assert.doesNotMatch(code,/textSend[^\n]*(rejected|retry|dead_letter)/);
 assert.equal((code.match(/media\.failure=(?!=)/g)??[]).length,2,"image classification sites unchanged");
 assert.equal((code.match(/sendProviderMessage\(/g)??[]).length,2,"no additional send");
 assert.equal((code.match(/sendMultichannelMessage\(/g)??[]).length,1,"no additional send");
 assert.equal((code.match(/executeOnce\(\{/g)??[]).length,2);
 assert.equal((code.match(/sb\.rpc\("consume_flow_reply"/g)??[]).length,1,"billing untouched");
 const eo=readFileSync("supabase/functions/flow-outbox-worker/executeOnce.ts","utf8");
 assert.match(eo,/catch\{\n\s+try\{await d\.confirm\("uncertain",null\);\}/,"executeOnce still finishes uncertain");
 // Logs carry fixed fields only (the TextSendFailure shape), never e / e.message.
 assert.doesNotMatch(code,/text send failed",\{[^}]*(id|tenant|e\.message)/);
 const core=readFileSync("supabase/functions/flow-outbox-worker/deliveryCore.ts","utf8");
 const parser=core.slice(core.indexOf("export function metaErrorInfo("),core.indexOf("/** Re-validates"));
 assert.ok(parser.length>100);
 assert.deepEqual([...new Set(parser.match(/\be\.\w+/g))].sort(),["e.code","e.error_subcode","e.type"],
  "only code/subcode/type are read (never message / fbtrace_id)");
});
