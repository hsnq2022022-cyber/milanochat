// T6-S4: the Outbox worker carries the validated provider failure (class,
// HTTP status, Meta code/subcode/type) of a failed TEXT or IMAGE send to
// public.flow_fail_outbox_delivery (20261115150000). Only a text refused by
// Meta with 4xx + code 100 ('rejected_invalid') is finished 'rejected'
// (dead_letter); everything else stays 'uncertain'. Without the new function
// the unchanged flow_finish_outbox_delivery path runs (previous behaviour).
// No network (fake fetch), no database (fake rpc).
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {executeOnce} from "../supabase/functions/flow-outbox-worker/executeOnce.ts";
import {sendProviderMessage,ProviderHttpError,ProviderTextHttpError,describeTextSendFailure,
 type ProviderRequest} from "../supabase/functions/flow-outbox-worker/deliveryCore.ts";
import {sendMultichannelMessage,classifyMultichannelFailure,MultichannelPayloadError}
 from "../supabase/functions/flow-outbox-worker/multichannelSend.ts";
import {classifyMediaFailure,finishOutcome,type MediaFailure,type FinishOutcome}
 from "../supabase/functions/flow-outbox-worker/mediaPolicy.ts";
import {deliveryFailureRecord,definiteTextRejection,failureResult,failureRpcArgs,captureFailure,
 finishFailure,newFailureCapture,DELIVERY_FAILURE_CLASSES,type DeliveryFailureRecord}
 from "../supabase/functions/flow-outbox-worker/deliveryFailure.ts";
import {leaseRecoveryFinishArgs} from "../supabase/functions/flow-outbox-worker/leaseRecovery.ts";
import {loadFlowReview,mapProviderFailure,PROVIDER_FAILURE_CLASSES}
 from "../supabase/functions/flow-delivery-review/review.ts";

const TA="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",OB="0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
const TOKEN="IGCANARYTOKEN_s3cr3t",EAA="EAACANARYTOKEN_s3cr3t",WA_TOKEN="WACANARYTOKEN_s3cr3t";
const TEXT="CANARY_CUSTOMER_TEXT مرحبا";
const PROJECT="https://abcd1234.supabase.co";
const IMG=PROJECT+"/storage/v1/object/public/flow-media/u1/0f8c2b1e-1111-4222-8333-444455556666.png";
const CANARIES=[TOKEN,EAA,WA_TOKEN,"CANARY_CUSTOMER_TEXT","CANARY_META_MESSAGE","FBTRACE_CANARY",
 "graph.instagram.com","graph.facebook.com","authorization","Bearer","access_token","flow-media","https://"];
function fake(status:number,body:unknown){
 const calls:string[]=[];
 const perform=(async(url:string)=>{calls.push(url);
  return new Response(body===null||typeof body==="string"?body as string|null:JSON.stringify(body),{status});}) as typeof fetch;
 return {calls,perform};
}
const meta=(code:unknown,subcode?:unknown,type:unknown="OAuthException")=>({error:{message:"CANARY_META_MESSAGE "+TEXT+" "+TOKEN,
 type,code,...(subcode!==undefined?{error_subcode:subcode}:{}),fbtrace_id:"FBTRACE_CANARY"}});
const IG:ProviderRequest={platform:"instagram",token:TOKEN,externalId:"",recipient:"123456",text:TEXT};
const WA:ProviderRequest={platform:"whatsapp",token:WA_TOKEN,externalId:"100001",recipient:"9647712345678",text:TEXT};
const FB:ProviderRequest={platform:"facebook",token:EAA,externalId:"",recipient:"123456",text:TEXT};
const IG_IMG:ProviderRequest={platform:"instagram",token:TOKEN,externalId:"",recipient:"123456",text:"",imageUrl:IMG,imageHost:PROJECT};
async function caught(p:Promise<unknown>):Promise<unknown>{try{await p;}catch(e){return e;}throw Error("expected a rejection");}
function noLeak(value:unknown,label:string){
 const t=JSON.stringify(value)??"";
 for(const c of CANARIES)assert.ok(!t.includes(c),label+" leaks "+c);
}
const R=(failureClass:DeliveryFailureRecord["failureClass"],httpStatus:number|null,errorCode:number|null=null,
 errorSubcode:number|null=null,errorType:string|null=null):DeliveryFailureRecord=>({failureClass,httpStatus,errorCode,errorSubcode,errorType});

// ---------------------------------------------------------------- record
test("record: text HTTP failures keep only validated status/code/subcode/type/class",async()=>{
 const cases:Array<[ProviderRequest,number,unknown,DeliveryFailureRecord]>=[
  [IG,400,meta(100,2018001),R("rejected_invalid",400,100,2018001,"OAuthException")],
  [IG,400,meta(10,2018278),R("outside_window",400,10,2018278,"OAuthException")],
  [WA,400,meta(131047),R("outside_window",400,131047,null,"OAuthException")],
  [FB,400,meta(190,undefined,"Bad Type <x>"),R("auth",400,190,null,null)],
  [IG,401,{},R("auth",401,null)],
  [IG,429,meta(613),R("throttled",429,613,null,"OAuthException")],
  [IG,403,meta(10),R("permanent_other",403,10,null,"OAuthException")],
  [IG,500,meta(100),R("ambiguous",500,100,null,"OAuthException")],
  [IG,408,meta(100),R("ambiguous",408,100,null,"OAuthException")],
  [IG,400,"<html>"+TEXT+"</html>",R("ambiguous",400,null)],
  [IG,400,meta(99999),R("ambiguous",400,99999,null,"OAuthException")],
 ];
 for(const [req,st,body,want] of cases){
  const e=await caught(sendProviderMessage(req,fake(st,body).perform));
  assert.ok(e instanceof ProviderTextHttpError);
  const r=deliveryFailureRecord(e,false);
  assert.deepEqual(r,want,`${req.platform} ${st} ${JSON.stringify(body).slice(0,40)}`);
  assert.deepEqual(Object.keys(r!),["failureClass","httpStatus","errorCode","errorSubcode","errorType"]);
  assert.ok(DELIVERY_FAILURE_CLASSES.includes(r!.failureClass));
  noLeak(r,"record");noLeak(failureRpcArgs(TA,OB,failureResult(r!,false),r!),"rpc args");
 }
 // Multichannel text (ProviderHttpError with metaErrorInfo): same classes.
 const mc=await caught(sendMultichannelMessage(WA,fake(400,meta(100,33)).perform));
 assert.ok(mc instanceof ProviderHttpError);
 assert.deepEqual(deliveryFailureRecord(mc,false),R("rejected_invalid",400,100,33,"OAuthException"));
});
test("record: images keep the unchanged media policy; non-HTTP errors carry NO record",async()=>{
 const e400=await caught(sendProviderMessage(IG_IMG,fake(400,meta(100)).perform));
 assert.deepEqual(deliveryFailureRecord(e400,true),R("media_rejected",400,100));
 assert.equal(classifyMediaFailure(e400),"media_rejected");
 assert.deepEqual(deliveryFailureRecord(await caught(sendProviderMessage(IG_IMG,fake(401,meta(190)).perform)),true),R("auth",401,190));
 assert.deepEqual(deliveryFailureRecord(await caught(sendProviderMessage(IG_IMG,fake(503,{}).perform)),true),R("ambiguous",503));
 assert.deepEqual(deliveryFailureRecord(await caught(sendProviderMessage(IG_IMG,fake(429,{}).perform)),true),R("ambiguous",429));
 const mcImg=await caught(sendMultichannelMessage({...WA,text:"",imageUrl:IMG,imageHost:PROJECT},fake(400,meta(131047,2018278)).perform));
 assert.deepEqual(deliveryFailureRecord(mcImg,true),R("media_rejected",400,131047,2018278,"OAuthException"));
 // A text error object can never become media_rejected, even if mislabelled as image.
 const t=await caught(sendProviderMessage(IG,fake(400,meta(100)).perform));
 assert.equal(deliveryFailureRecord(t,true)!.failureClass,"rejected_invalid");
 // No provider evidence -> no record (the old 4-argument finish runs).
 const network=(async()=>{throw new TypeError("fetch failed "+TOKEN);}) as typeof fetch;
 for(const err of [await caught(sendProviderMessage(IG,network)),await caught(sendProviderMessage({...IG,recipient:"x"},network)),
  new MultichannelPayloadError("mc_platform_invalid" as any),new Error("Provider HTTP 400"),null,undefined,"x",
  {status:400,metaCode:100},new Proxy({},{get(){throw Error("boom");}})])
  assert.equal(deliveryFailureRecord(err,false),null);
 // Bounded values only.
 assert.equal(deliveryFailureRecord(new ProviderHttpError(700,100),false),null);
 assert.deepEqual(deliveryFailureRecord(new ProviderHttpError(400,1e12 as any),false),R("ambiguous",400,null));
});
test("outcome: only rejected_invalid + 4xx (not 408/429) + code 100 is a definite text rejection",()=>{
 assert.equal(definiteTextRejection(R("rejected_invalid",400,100)),true);
 assert.equal(definiteTextRejection(R("rejected_invalid",404,100)),true);
 for(const r of [R("rejected_invalid",429,100),R("rejected_invalid",408,100),R("rejected_invalid",500,100),
  R("rejected_invalid",400,99),R("rejected_invalid",null,100),R("ambiguous",400,100),R("outside_window",400,131047),
  R("outside_window",400,10,2018278),R("auth",401),R("auth",400,190),R("throttled",400,4),R("permanent_other",400,10),
  R("media_rejected",400,100)])
  {assert.equal(definiteTextRejection(r),false,JSON.stringify(r));assert.equal(failureResult(r,false),"uncertain",JSON.stringify(r));}
 assert.equal(definiteTextRejection(null),false);
 assert.equal(failureResult(R("rejected_invalid",400,100),false),"rejected");
 assert.equal(failureResult(R("media_rejected",400,100),true),"rejected");
 assert.equal(failureResult(R("rejected_invalid",400,100),true),"uncertain","image needs media_rejected");
 assert.deepEqual(Object.keys(failureRpcArgs(TA,OB,"uncertain",R("auth",401))),
  ["p_tenant","p_outbox","p_result","p_failure_class","p_http_status","p_error_code","p_error_subcode","p_error_type"]);
});

// ---------------------------------------------------------------- worker wiring (same as index.ts)
type Db="new"|"missing"|"false"|"throws";
type Call={fn:string;args:Record<string,unknown>};
function fakeRpc(db:Db){
 const calls:Call[]=[];
 return {calls,sb:{rpc:async(fn:string,args:Record<string,unknown>)=>{
  calls.push({fn,args});
  if(fn==="flow_finish_outbox_delivery")return {data:true,error:null};
  if(db==="missing")return {data:null,error:{code:"PGRST202"}};
  if(db==="throws")throw Error("socket "+TOKEN);
  if(db==="false")return {data:false,error:null};
  return {data:true,error:null};
 }}};
}
/** Exactly the send/confirm/report wiring of flow-outbox-worker/index.ts (legacy + multichannel). */
async function runWorker(kind:"legacy"|"multichannel",req:ProviderRequest,f:ReturnType<typeof fake>,db:Db="new"){
 const {calls,sb}=fakeRpc(db);
 const media={failure:null as MediaFailure|null,rejected:false};
 const textSend={failure:null as ReturnType<typeof describeTextSendFailure>|null};
 const failure=newFailureCapture();
 const imageUrl=req.imageUrl;let sends=0,bills=0;const reports:string[]=[];
 const effect={tenant_id:TA,id:OB};
 const res=await executeOnce({
  reserve:async()=>true,
  send:()=>{sends++;
   if(kind==="multichannel")return sendMultichannelMessage(req,f.perform).catch(e=>{
    classifyMultichannelFailure(e);
    if(imageUrl!==undefined)media.failure=classifyMediaFailure(e);
    if(imageUrl===undefined)textSend.failure=describeTextSendFailure(e);
    failure.record=deliveryFailureRecord(e,imageUrl!==undefined);
    throw e;});
   return captureFailure(failure,imageUrl!==undefined,imageUrl===undefined?
    sendProviderMessage(req,f.perform).catch(e=>{textSend.failure=describeTextSendFailure(e);throw e;}):
    sendProviderMessage(req,f.perform).catch(e=>{media.failure=classifyMediaFailure(e);throw e;}));
  },
  confirm:async(status,providerId)=>{
   if(status==="uncertain"&&failure.record){
    const failed=await finishFailure(sb,effect.tenant_id,effect.id,failure.record,imageUrl!==undefined);
    if(failed==="rejected"){if(imageUrl!==undefined)media.rejected=true;else failure.rejected=true;return true;}
    if(failed==="uncertain")return true;
   }
   const finish=async(result:FinishOutcome):Promise<boolean|null>=>{
    const {data,error}=await sb.rpc("flow_finish_outbox_delivery",{
     p_tenant:effect.tenant_id,p_outbox:effect.id,p_result:result,p_provider_message_id:providerId});
    if(error)return null;return data===true;
   };
   if(finishOutcome(status,media.failure)==="rejected"){
    const rejected=await finish("rejected");
    if(rejected===true){media.rejected=true;return true;}
    if(rejected===null)return false;
   }
   return await finish(status)===true;
  },
  persistAndBill:async()=>{bills++;return true;}
 });
 reports.push(media.rejected?"dead_letter_media_rejected":res);
 if(failure.rejected)reports.push("dead_letter_text_rejected");
 return {res,reports,calls,sends,bills,requests:f.calls.length};
}
const failCall=(result:string,r:DeliveryFailureRecord)=>({fn:"flow_fail_outbox_delivery",args:failureRpcArgs(TA,OB,result as any,r)});
const oldCall=(result:string,mid:string|null=null)=>({fn:"flow_finish_outbox_delivery",
 args:{p_tenant:TA,p_outbox:OB,p_result:result,p_provider_message_id:mid}});
async function quiet<T>(fn:()=>Promise<T>):Promise<{value:T;logs:unknown[][]}>{
 const logs:unknown[][]=[];const e=console.error,w=console.warn;
 console.error=(...a:unknown[])=>{logs.push(a);};console.warn=(...a:unknown[])=>{logs.push(a);};
 try{return {value:await fn(),logs};}finally{console.error=e;console.warn=w;}
}

test("text 4xx + code 100 -> one fail('rejected') call with the record; dead_letter; no retry, no bill",async()=>{
 for(const [kind,req] of [["legacy",IG],["legacy",FB],["multichannel",WA],["multichannel",FB]] as const){
  const r=R("rejected_invalid",400,100,null,"OAuthException");
  const out=await runWorker(kind,req,fake(400,meta(100)));
  assert.deepEqual(out.calls,[failCall("rejected",r)],kind+req.platform);
  assert.deepEqual(out.reports,["uncertain","dead_letter_text_rejected"]);
  assert.equal(out.sends,1);assert.equal(out.requests,1,"no second provider call");assert.equal(out.bills,0);
  noLeak(out.calls,"rpc args");
 }
});
test("every other text failure -> fail('uncertain') with its class; never dead_letter",async()=>{
 const cases:Array<[number,unknown,DeliveryFailureRecord]>=[
  [400,meta(10,2018278),R("outside_window",400,10,2018278,"OAuthException")],
  [400,meta(131047),R("outside_window",400,131047,null,"OAuthException")],
  [401,{},R("auth",401)],[400,meta(190),R("auth",400,190,null,"OAuthException")],
  [429,meta(4),R("throttled",429,4,null,"OAuthException")],[400,meta(613),R("throttled",400,613,null,"OAuthException")],
  [403,meta(10),R("permanent_other",403,10,null,"OAuthException")],
  [429,meta(100),R("rejected_invalid",429,100,null,"OAuthException")],
  [408,meta(100),R("ambiguous",408,100,null,"OAuthException")],[500,meta(100),R("ambiguous",500,100,null,"OAuthException")],
  [503,null,R("ambiguous",503)],[400,"garbage",R("ambiguous",400)],[404,{},R("ambiguous",404)],
 ];
 for(const [st,body,r] of cases){
  const out=await runWorker("legacy",IG,fake(st,body));
  const tag=`${st} ${JSON.stringify(body)}`;
  assert.deepEqual(out.calls,[failCall("uncertain",r)],tag);
  assert.deepEqual(out.reports,["uncertain"],tag);
  assert.equal(out.requests,1,tag);assert.equal(out.bills,0,tag);
 }
});
test("no provider evidence (network/timeout/invalid/2xx without id): the unchanged 4-argument finish only",async()=>{
 const net=(async()=>{throw new TypeError("network");}) as typeof fetch;
 const out=await runWorker("legacy",IG,{calls:[],perform:net});
 assert.deepEqual(out.calls,[oldCall("uncertain")]);assert.equal(out.res,"uncertain");
 const noId=await runWorker("legacy",IG,fake(200,{}));
 assert.deepEqual(noId.calls,[oldCall("uncertain")]);
 const payload=await runWorker("multichannel",{...WA,quickReplies:[{label:"a",value:"a"}] as any},fake(200,{}));
 assert.ok(payload.calls.every(c=>c.fn==="flow_finish_outbox_delivery"));
 // Success path unchanged: confirmed + billed once, no failure RPC.
 const ok=await runWorker("legacy",IG,fake(200,{message_id:"mid-1"}));
 assert.deepEqual(ok.calls,[oldCall("confirmed","mid-1")]);assert.equal(ok.res,"settled");assert.equal(ok.bills,1);
 assert.deepEqual(ok.reports,["settled"]);
 // S2 lease recovery still sends exactly the 4-argument shape.
 assert.deepEqual(leaseRecoveryFinishArgs(TA,OB),oldCall("uncertain").args);
});
test("images: media_rejected -> fail('rejected') (dead_letter as before) + record; auth/5xx uncertain",async()=>{
 const out=await runWorker("legacy",IG_IMG,fake(400,meta(100)));
 assert.deepEqual(out.calls,[failCall("rejected",R("media_rejected",400,100))]);
 assert.deepEqual(out.reports,["dead_letter_media_rejected"]);assert.equal(out.bills,0);assert.equal(out.requests,1);
 const auth=await runWorker("legacy",IG_IMG,fake(401,meta(190)));
 assert.deepEqual(auth.calls,[failCall("uncertain",R("auth",401,190))]);assert.deepEqual(auth.reports,["uncertain"]);
 const mc=await runWorker("multichannel",{...FB,text:"",imageUrl:IMG,imageHost:PROJECT},fake(400,meta(131047,2018278)));
 assert.deepEqual(mc.calls,[failCall("rejected",R("media_rejected",400,131047,2018278,"OAuthException"))]);
 assert.deepEqual(mc.reports,["dead_letter_media_rejected"]);
});
test("database without 20261115150000 (or error/false/throw): exactly the previous finish calls follow",async()=>{
 for(const db of ["missing","throws","false"] as const){
  const {value:t,logs}=await quiet(()=>runWorker("legacy",IG,fake(400,meta(100)),db));
  const r=R("rejected_invalid",400,100,null,"OAuthException");
  assert.deepEqual(t.calls,[failCall("rejected",r),failCall("uncertain",r),oldCall("uncertain")],db);
  assert.deepEqual(t.reports,["uncertain"],db+": text never dead_lettered without the function");
  assert.equal(t.requests,1);assert.equal(t.bills,0);
  noLeak(logs,"logs "+db);
  const {value:i}=await quiet(()=>runWorker("legacy",IG_IMG,fake(400,meta(100)),db));
  const ri=R("media_rejected",400,100);
  assert.deepEqual(i.calls,[failCall("rejected",ri),failCall("uncertain",ri),oldCall("rejected")],db);
  assert.deepEqual(i.reports,["dead_letter_media_rejected"],db+": image path as before");
  const {value:u}=await quiet(()=>runWorker("legacy",IG,fake(503,{}),db));
  assert.deepEqual(u.calls,[failCall("uncertain",R("ambiguous",503)),oldCall("uncertain")],db);
 }
 // 'rejected' refused (false) but 'uncertain' accepted -> stays uncertain with the record.
 const sb={rpc:async(fn:string,a:Record<string,unknown>)=>({data:a.p_result==="uncertain",error:null})};
 assert.equal(await finishFailure(sb,TA,OB,R("rejected_invalid",400,100),false),"uncertain");
});

// ---------------------------------------------------------------- static wiring
test("index.ts wiring: capture wraps both sends; confirm uses the record first; old finish, billing, executeOnce unchanged",()=>{
 const code=readFileSync("supabase/functions/flow-outbox-worker/index.ts","utf8");
 assert.match(code,/^import \{captureFailure,deliveryFailureRecord,finishFailure,newFailureCapture\} from "\.\/deliveryFailure\.ts";$/m);
 assert.equal((code.match(/const failure=newFailureCapture\(\);/g)??[]).length,1);
 // Legacy/Instagram send wrapped once; the multichannel catch records the failure before rethrowing.
 assert.equal((code.match(/send:\(\)=>captureFailure\(failure,imageUrl!==undefined,imageUrl===undefined\?sendProviderMessage\(\{/g)??[]).length,1);
 assert.match(code,/\n\s+if\(imageUrl===undefined\)textSend\.failure=describeTextSendFailure\(e\);\n\s+failure\.record=deliveryFailureRecord\(e,imageUrl!==undefined\);\n\s+throw e;\n/);
 assert.equal((code.match(/failure\.record=/g)??[]).length,1);
 const block=`if(status==="uncertain"&&failure.record){
 const failed=await finishFailure(sb,effect.tenant_id,effect.id,failure.record,imageUrl!==undefined);
 if(failed==="rejected"){if(imageUrl!==undefined)media.rejected=true;else failure.rejected=true;return true;}
 if(failed==="uncertain")return true;
 }`;
 const flat=code.replace(/\n\s+/g,"\n ");
 assert.equal(flat.split(block).length-1,2,"T6-S4 block in both confirms");
 for(const start of ["const sent=await executeOnce({","const res=await executeOnce({"]){
  const b=code.slice(code.indexOf(start),code.indexOf("persistAndBill\n",code.indexOf(start)));
  const c=b.slice(b.indexOf("confirm:async(status,providerId)=>{"));
  assert.ok(c.indexOf("finishFailure(")<c.indexOf('sb.rpc("flow_finish_outbox_delivery"'),"record first, old finish after");
 }
 assert.equal((code.match(/sb\.rpc\("flow_finish_outbox_delivery",\{\n\s+p_tenant:effect\.tenant_id,p_outbox:effect\.id,p_result:result,\n\s+p_provider_message_id:providerId\n\s+\}\)/g)??[]).length,2);
 assert.equal((code.match(/flow_fail_outbox_delivery/g)??[]).length,1,"only mentioned in a comment; called via deliveryFailure.ts");
 assert.equal((code.match(/report\("dead_letter_text_rejected"\)/g)??[]).length,2);
 assert.equal((code.match(/sendProviderMessage\(/g)??[]).length,2,"no additional send");
 assert.equal((code.match(/sendMultichannelMessage\(/g)??[]).length,1,"no additional send");
 // persistAndBill + charge_pending recovery block byte-identical to before T6-S4.
 const a=code.indexOf("   const persistAndBill=async(providerId:string):Promise<boolean>=>{");
 const z=code.indexOf('   const token=account.platform==="whatsapp"?');
 assert.equal(createHash("sha256").update(code.slice(a,z)).digest("hex"),
  "c8e56127aa8c8a8ce1c32af84e15503b54b519a640e4aab970b1648493e0a34e");
 assert.equal(createHash("sha256").update(readFileSync("supabase/functions/flow-outbox-worker/executeOnce.ts","utf8")).digest("hex"),
  "da7a731f55e75231a137f31ce8b7aaf903186751799d44c636b09d77368be184","executeOnce.ts unchanged");
 const mod=readFileSync("supabase/functions/flow-outbox-worker/deliveryFailure.ts","utf8").replace(/\/\*[\s\S]*?\*\//g,"").replace(/\/\/[^\n]*/g,"");
 assert.doesNotMatch(mod,/\bfetch\(|sendProviderMessage\(|sendMultichannelMessage\(|consume_|\.from\(|\.update\(|\.insert\(|setTimeout|retry/i);
 assert.equal((mod.match(/\.rpc\(/g)??[]).length,1);
 assert.match(mod,/sb\.rpc\("flow_fail_outbox_delivery",failureRpcArgs\(tenantId,outboxId,result,r\)\)/);
 // Logs: fixed message + short error code only.
 assert.deepEqual([...mod.matchAll(/console\.(\w+)\(([^,)]+)/g)].map(m=>m[1]+" "+m[2]),
  ['error "[outbox] failure finish error"','error "[outbox] failure finish error"']);
 const leaseRecovery=readFileSync("supabase/functions/flow-outbox-worker/leaseRecovery.ts","utf8");
 assert.doesNotMatch(leaseRecovery,/flow_fail_outbox_delivery|deliveryFailure/);
});

// ---------------------------------------------------------------- delivery review
test("delivery review: additive provider-failure list, tenant-scoped, whitelisted fields only",async()=>{
 const calls:Array<{table:string;ops:[string,unknown[]][]}>=[];
 const rowsFor=(sel:string)=>sel.includes("failure_class")?[
  {outbox_id:"o1",status:"rejected",attempted_at:"2026-11-10T00:00:00Z",failure_class:"rejected_invalid",provider_http_status:400,
   provider_error_code:100,provider_error_subcode:2018001,provider_error_type:"OAuthException",tenant_id:TA,
   provider_message_id:"mid-secret",body:TEXT,payload:{t:TEXT}},
  {outbox_id:"o2",status:"uncertain",failure_class:"ambiguous",provider_http_status:503,provider_error_code:null,
   provider_error_subcode:null,provider_error_type:"https://evil/"+TOKEN},
  {outbox_id:"o3",status:"uncertain",failure_class:"hacked"},{outbox_id:"o4",status:"confirmed",failure_class:"auth"},
  {outbox_id:"o5",status:"uncertain",failure_class:"auth",provider_http_status:9999,provider_error_code:-1}]:[];
 const client={from(table:string){
  const call={table,ops:[] as [string,unknown[]][]};calls.push(call);const b:any={};
  for(const op of ["select","eq","in","or","order","limit"])b[op]=(...a:unknown[])=>{call.ops.push([op,a]);return b;};
  b.then=(ok:(v:unknown)=>unknown,bad:(e:unknown)=>unknown)=>Promise.resolve({
   data:rowsFor(String(call.ops.find(([o])=>o==="select")?.[1][0])),count:0}).then(ok,bad);
  return b;}};
 const out=await loadFlowReview(client,TA);
 assert.equal(out.flowProviderFailuresAvailable,true);
 assert.deepEqual(out.flowProviderFailures,[
  {outbox_id:"o1",status:"rejected",attempted_at:"2026-11-10T00:00:00Z",failure_class:"rejected_invalid",
   provider_http_status:400,provider_error_code:100,provider_error_subcode:2018001,provider_error_type:"OAuthException"},
  {outbox_id:"o2",status:"uncertain",attempted_at:null,failure_class:"ambiguous",provider_http_status:503,
   provider_error_code:null,provider_error_subcode:null,provider_error_type:null},
  {outbox_id:"o5",status:"uncertain",attempted_at:null,failure_class:"auth",provider_http_status:null,
   provider_error_code:null,provider_error_subcode:null,provider_error_type:null}]);
 noLeak(out,"review output");assert.ok(!JSON.stringify(out).includes("mid-secret"));
 const fq=calls.find(c=>String(c.ops.find(([o])=>o==="select")?.[1][0]).includes("failure_class"))!;
 assert.equal(fq.table,"automation_flow_delivery_attempts");
 assert.deepEqual(fq.ops.filter(([o])=>o==="eq").map(([,a])=>a),[["tenant_id",TA]]);
 assert.deepEqual(fq.ops.find(([o])=>o==="in")?.[1],["status",["uncertain","rejected"]]);
 assert.doesNotMatch(String(fq.ops[0][1][0]),/message|body|payload|token|text|url|provider_message_id|\*/);
 assert.deepEqual([...PROVIDER_FAILURE_CLASSES],[...DELIVERY_FAILURE_CLASSES]);
 assert.equal(mapProviderFailure({outbox_id:"x",status:"attempting",failure_class:"auth"}),null);
 // Missing columns (migration not applied): only this list degrades; the existing views stay available.
 const deg={from(table:string){const ops:[string,unknown[]][]=[];const b:any={};
  for(const op of ["select","eq","in","or","order","limit"])b[op]=(...a:unknown[])=>{ops.push([op,a]);return b;};
  b.then=(ok:(v:unknown)=>unknown,bad:(e:unknown)=>unknown)=>Promise.resolve(
   String(ops.find(([o])=>o==="select")?.[1][0]).includes("failure_class")?{error:{message:"column does not exist"}}:{data:[],count:0}).then(ok,bad);
  return b;}};
 const d=await loadFlowReview(deg,TA);
 assert.deepEqual(d.flowProviderFailures,[]);assert.equal(d.flowProviderFailuresAvailable,false);
 assert.equal(d.flowAvailable,true);assert.equal(d.flowInternalAvailable,true);
 const idx=readFileSync("supabase/functions/flow-delivery-review/index.ts","utf8");
 assert.match(idx,/flowInternal:\[\],flowInternalAvailable:false,flowProviderFailures:\[\],flowProviderFailuresAvailable:false\}/);
});
