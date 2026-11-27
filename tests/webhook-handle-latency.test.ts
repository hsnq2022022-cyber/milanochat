import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {stripTypeScriptTypes} from "node:module";

/**
 * R1 latency: the head of handleIncomingWebhookMessage (tenant read, conversation read/insert/touch, conversation-start
 * read) is executed from the REAL source of milan-api/index.ts against a fake database with per-call latency. The test
 * pins the concurrency that was added (tenant read + conversation read overlap; last_message_at update + conversation-
 * start read overlap) AND the guarantees it must not weaken (no write before the tenant checks, the touch completes
 * before the handler returns, error/early-return semantics unchanged).
 */
const SRC=readFileSync("supabase/functions/milan-api/index.ts","utf8");
const from=SRC.indexOf("async function handleIncomingWebhookMessage(");
const bodyStart=SRC.indexOf('  const endConversation = timer.start("conversation");',from);
const endMark="  endConversation();\n";
const bodyEnd=SRC.indexOf(endMark,bodyStart)+endMark.length;
assert.ok(from>0&&bodyStart>from&&bodyEnd>bodyStart,"head of handleIncomingWebhookMessage located");
const HEAD=SRC.slice(bodyStart,bodyEnd);

type Call={op:string;table:string;start:number;end:number};
function harness(o:{tenant?:any;tenantError?:any;conv?:any;convError?:any;convRejects?:boolean;latency?:number;convStartThrows?:boolean;updateRejects?:boolean}){
 const latency=o.latency??40,calls:Call[]=[];let inflight=0,maxInflight=0;const t0=Date.now();
 const rec=<T,>(op:string,table:string,value:()=>T)=>new Promise<T>((res,rej)=>{
  const c:Call={op,table,start:Date.now()-t0,end:0};calls.push(c);inflight++;maxInflight=Math.max(maxInflight,inflight);
  setTimeout(()=>{inflight--;c.end=Date.now()-t0;try{res(value());}catch(e){rej(e);}},latency);
 });
 const builder=(table:string)=>{
  let op="select";
  const b:any={
   select(){return b;},eq(){return b;},
   insert(){op="insert";return b;},update(){op="update";return b;},
   maybeSingle(){
    if(table==="tenants")return rec("select",table,()=>({data:o.tenant===undefined?{id:"t",is_active:true,credits_remaining:5}:o.tenant,error:o.tenantError??null}));
    return rec("select",table,()=>{if(o.convRejects)throw new Error("boom");return {data:o.conv===undefined?{id:"c1",transferred:false}:o.conv,error:o.convError??null};});
   },
   single(){return rec("insert",table,()=>({data:{id:"c-new"},error:null}));},
   then(res:any,rej:any){return rec(op,table,()=>{if(op==="update"&&o.updateRejects)throw new Error("net");return {data:null,error:null};}).then(res,rej);},
  };
  return b;
 };
 const sb={from:(t:string)=>builder(t)};
 const outcome:string[]=[];
 const run=async(redrive?:{conversationId:string;inboundId:string})=>{
  const AsyncFn=Object.getPrototypeOf(async function(){}).constructor;
  const js=stripTypeScriptTypes(`async function f(){\n${HEAD}\n return "done";\n}`,{mode:"strip"});
  const fn=new AsyncFn("sb","account","chatId","customerText","externalMsgId","channel","redrive","providerEventIdGenuine","timer",
   "encryptField","readConversationStart","multichannelEnabled","env","recordRoutingFailure","markRoutingResolved","markLiveNoReply","retryAttemptCap","console",
   js.replace(/^async function f\(\)\{/,"").replace(/\}\s*$/,""));
  const timer={start:()=>()=>{}};
  return await fn(sb,{id:"a1",tenant_id:"t",channel:"instagram"},"instagram:42","hi","mid-1","instagram",redrive,true,timer,
   async(x:string)=>"enc:"+x,
   async()=>{await rec("select","messages",()=>null);if(o.convStartThrows)throw new Error("x");return false;},
   ()=>false,()=>"",
   async()=>{outcome.push("failure");return "retry";},async()=>{outcome.push("resolved");},async()=>{},()=>3,
   {log(){},warn(){},error(){},info(){}});
 };
 return {calls,run,outcome,maxInflight:()=>maxInflight};
}
const find=(calls:Call[],op:string,table:string)=>calls.find(c=>c.op===op&&c.table===table);

test("existing conversation: tenant read and conversation read start together; touch overlaps the conversation-start read",async()=>{
 const h=harness({latency:Number(process.env.WEBHOOK_LATENCY_MS??40)});
 const began=Date.now();
 assert.equal(await h.run(),"done");
 if(process.env.WEBHOOK_LATENCY_MS)console.log("handle head elapsed ms:",Date.now()-began,"for per-call latency",process.env.WEBHOOK_LATENCY_MS);
 const tenant=find(h.calls,"select","tenants")!,conv=find(h.calls,"select","conversations")!;
 assert.ok(Math.abs(tenant.start-conv.start)<25,"tenant and conversation reads overlap");
 const touch=find(h.calls,"update","conversations")!,start=find(h.calls,"select","messages")!;
 assert.ok(Math.abs(touch.start-start.start)<25,"touch and conversation-start read overlap");
 assert.ok(touch.start>=conv.end-2,"the touch needs the conversation row: it starts after the read completed");
 assert.ok(h.maxInflight()>=2);
});
test("the handler never returns before last_message_at has been written",async()=>{
 const h=harness({latency:30});
 await h.run();
 const touch=find(h.calls,"update","conversations")!;
 assert.ok(touch.end>0,"touch completed before the handler returned");
});
test("tenant inactive: nothing is written (no insert, no update) although the conversation read was started",async()=>{
 const h=harness({tenant:{id:"t",is_active:false}});
 await h.run();
 assert.ok(!h.calls.some(c=>c.op==="insert"||c.op==="update"),"no write");
 assert.deepEqual(h.outcome,[]);
});
test("tenant missing / unreadable keep their exits and never write",async()=>{
 const missing=harness({tenant:null});await missing.run();
 assert.ok(!missing.calls.some(c=>c.op==="insert"||c.op==="update"));
 const failed=harness({tenantError:{code:"x"}});
 assert.equal(await failed.run(),"retry");
 assert.ok(!failed.calls.some(c=>c.op==="insert"||c.op==="update"));
});
test("a rejecting conversation read after an early tenant exit is not an unhandled rejection or a failure",async()=>{
 let unhandled=0;const on=()=>{unhandled++;};process.on("unhandledRejection",on);
 try{
  const h=harness({tenant:{id:"t",is_active:false},convRejects:true});
  await h.run();await new Promise(r=>setTimeout(r,120));
  assert.equal(unhandled,0);
 }finally{process.off("unhandledRejection",on);}
});
test("conversation read error and a conversation-start failure keep the unknown-state exit",async()=>{
 const readError=harness({convError:{code:"x"}});
 assert.equal(await readError.run(),"retry");
 assert.ok(!readError.calls.some(c=>c.op==="update"||c.op==="insert"));
 const startFail=harness({convStartThrows:true});
 assert.equal(await startFail.run(),"retry");
});
test("new conversation: the insert happens only after the tenant checks; no touch update",async()=>{
 const h=harness({conv:null});
 await h.run();
 const tenant=find(h.calls,"select","tenants")!,insert=find(h.calls,"insert","conversations")!;
 assert.ok(insert.start>=tenant.end-2,"insert after the tenant read completed");
 assert.ok(!h.calls.some(c=>c.op==="update"));
});
test("re-drive keeps its own conversation lookup and never inserts",async()=>{
 const h=harness({});
 await h.run({conversationId:"c1",inboundId:"i1"});
 assert.ok(!h.calls.some(c=>c.op==="insert"));
 assert.match(HEAD,/\.eq\("id", redrive\.conversationId\)\n\s+\.eq\("wa_chat_id", chatId\)/);
});

test("a failing last_message_at update still aborts the handler before the inbound row is stored (as before)",async()=>{
 const h=harness({updateRejects:true});
 await assert.rejects(()=>h.run(),/net/);
});
