// T6-S2: recovery of abandoned message/question/message_image delivery leases
// (supabase/functions/flow-outbox-worker/leaseRecovery.ts). Pure fakes, no
// network, no database. The SQL semantics of flow_finish_outbox_delivery are
// proven separately in tests/flow-outbox-lease-recovery-sql.test.mjs.
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {recoverAbandonedLeases,recoverableLeases,leaseRecoveryFinishArgs,leaseRecoveryCutoffMs,
 LEASE_RECOVERY_GRACE_MS,LEASE_RECOVERY_LIMIT,LEASE_RECOVERY_KINDS,OUTBOX_DELIVERY_LEASE_SECONDS,
 EDGE_WALL_CLOCK_MAX_SECONDS} from "../supabase/functions/flow-outbox-worker/leaseRecovery.ts";
import {OUTBOX_DISPATCH_LIMIT,OUTBOX_STALE_MINUTES} from "../supabase/functions/flow-outbox-worker/skipPolicy.ts";

const NOW=Date.parse("2026-11-16T12:00:00.000Z");
const iso=(ms:number)=>new Date(ms).toISOString();
const CUT=NOW-LEASE_RECOVERY_GRACE_MS;
const TA="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",TB="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
type Row={id:string;tenant_id:string;delivery_status:string;effect_kind:string;lease_expires_at:string|null;
 attempt:string|null};
const row=(id:string,o:Partial<Row>={}):Row=>({id,tenant_id:TA,delivery_status:"leased",effect_kind:"message",
 lease_expires_at:iso(CUT-60_000),attempt:"attempting",...o});

/**
 * In-memory Supabase fake. The query builder evaluates the filters it is given
 * (so a missing/changed filter changes the result), records every call, and
 * the RPC emulates flow_finish_outbox_delivery (20261029210000): tenant-scoped,
 * attempt 'attempting' -> 'uncertain', outbox 'leased' -> 'uncertain'.
 */
function fakeDb(rows:Row[],opt:{ignoreFilters?:boolean;listError?:boolean;listThrows?:boolean;
 rpcError?:(args:Record<string,unknown>)=>boolean;rpcThrows?:(args:Record<string,unknown>)=>boolean;
 beforeFinish?:(args:Record<string,unknown>)=>void}={}){
 const calls:{queries:string[][];rpcs:{fn:string;args:Record<string,unknown>}[];writes:string[]}=
  {queries:[],rpcs:[],writes:[]};
 const sb={
  from(table:string){
   const log=[`from:${table}`];calls.queries.push(log);
   let preds:((r:Row)=>boolean)[]=[];let order:string|null=null,asc=true,lim=Infinity;
   const q:any={
    select(c:string){log.push(`select:${c}`);return q;},
    eq(c:string,v:unknown){log.push(`eq:${c}=${v}`);preds.push(r=>(r as any)[c]===v);return q;},
    in(c:string,v:unknown[]){log.push(`in:${c}=${v.join("|")}`);preds.push(r=>v.includes((r as any)[c]));return q;},
    lt(c:string,v:string){log.push(`lt:${c}<${v}`);
     preds.push(r=>(r as any)[c]!=null&&Date.parse((r as any)[c])<Date.parse(v));return q;},
    order(c:string,o:{ascending:boolean}){log.push(`order:${c}:${o.ascending}`);order=c;asc=o.ascending;return q;},
    limit(n:number){log.push(`limit:${n}`);lim=n;return q;},
    update(){calls.writes.push("update");throw Error("recovery must never write directly");},
    insert(){calls.writes.push("insert");throw Error("recovery must never write directly");},
    upsert(){calls.writes.push("upsert");throw Error("recovery must never write directly");},
    delete(){calls.writes.push("delete");throw Error("recovery must never write directly");},
    then(res:(v:unknown)=>unknown,rej:(e:unknown)=>unknown){
     if(opt.listThrows)return Promise.reject(Error("network")).then(res,rej);
     if(opt.listError)return Promise.resolve({data:null,error:{code:"57014"}}).then(res,rej);
     let out=opt.ignoreFilters?[...rows]:rows.filter(r=>preds.every(p=>p(r)));
     if(order&&!opt.ignoreFilters)out.sort((a,b)=>String((a as any)[order!]).localeCompare(String((b as any)[order!]))*(asc?1:-1));
     if(!opt.ignoreFilters)out=out.slice(0,lim);
     return Promise.resolve({data:out.map(({attempt,...r})=>({...r})),error:null}).then(res,rej);
    }
   };
   return q;
  },
  async rpc(fn:string,args:Record<string,unknown>){
   calls.rpcs.push({fn,args});
   opt.beforeFinish?.(args);
   if(opt.rpcThrows?.(args))throw Error("socket hang up");
   if(opt.rpcError?.(args))return {data:null,error:{code:"XX000"}};
   if(fn!=="flow_finish_outbox_delivery")return {data:null,error:{code:"42883"}};
   if(args.p_result!=="uncertain"||args.p_provider_message_id!==null)return {data:false,error:null};
   const r=rows.find(x=>x.id===args.p_outbox&&x.tenant_id===args.p_tenant);
   if(!r||r.attempt!=="attempting")return {data:false,error:null};
   if(r.delivery_status!=="leased")return {data:null,error:{code:"P0001"}}; // RAISE, rolled back
   r.attempt="uncertain";r.delivery_status="uncertain";r.lease_expires_at=null;
   return {data:true,error:null};
  }
 };
 return {sb,calls,rows};
}
function guardFetch(){
 const g=globalThis as any;const prev=g.fetch;let called=0;
 g.fetch=()=>{called++;throw Error("recovery must never call fetch");};
 return {restore:()=>{g.fetch=prev;},called:()=>called};
}
async function quiet<T>(fn:()=>Promise<T>):Promise<{value:T;logs:unknown[][]}>{
 const logs:unknown[][]=[];const e=console.error,i=console.info,w=console.warn;
 console.error=(...a)=>{logs.push(a);};console.info=(...a)=>{logs.push(a);};console.warn=(...a)=>{logs.push(a);};
 try{return {value:await fn(),logs};}finally{console.error=e;console.info=i;console.warn=w;}
}

// ---------------------------------------------------------------- constants
test("grace derivation: exceeds wall clock minus lease, below the stale sweep, matches the 15 min review age",()=>{
 assert.equal(OUTBOX_DELIVERY_LEASE_SECONDS,120);
 const sql=readFileSync("supabase/migrations/20261029300000_comment_replies.sql","utf8");
 const reserve=sql.slice(sql.indexOf("FUNCTION public.flow_reserve_outbox_delivery"),sql.indexOf("$reserve$;"));
 assert.match(reserve,/lease_expires_at=now\(\)\+interval '2 minutes'/,"constant mirrors the latest reserve SQL");
 assert.ok(LEASE_RECOVERY_GRACE_MS>(EDGE_WALL_CLOCK_MAX_SECONDS-OUTBOX_DELIVERY_LEASE_SECONDS)*1000);
 assert.ok(LEASE_RECOVERY_GRACE_MS>0);
 assert.equal(OUTBOX_DELIVERY_LEASE_SECONDS*1000+LEASE_RECOVERY_GRACE_MS,15*60_000);
 assert.ok(OUTBOX_DELIVERY_LEASE_SECONDS*1000+LEASE_RECOVERY_GRACE_MS<OUTBOX_STALE_MINUTES*60_000/2);
 assert.equal(LEASE_RECOVERY_LIMIT,2*OUTBOX_DISPATCH_LIMIT);
 assert.deepEqual([...LEASE_RECOVERY_KINDS],["message","question","message_image"]);
 assert.equal(leaseRecoveryCutoffMs(NOW),NOW-LEASE_RECOVERY_GRACE_MS);
});

// ---------------------------------------------------------------- selection
test("boundary: exactly at now-GRACE not recovered, 1 ms past it is; unexpired and within-grace untouched",async()=>{
 const rows=[row("at",{lease_expires_at:iso(CUT)}),row("past",{lease_expires_at:iso(CUT-1)}),
  row("live",{lease_expires_at:iso(NOW+60_000)}),row("grace",{lease_expires_at:iso(NOW-60_000)}),
  row("graceEnd",{lease_expires_at:iso(CUT+1)})];
 for(const ignoreFilters of [false,true]){
  const db=fakeDb(rows.map(r=>({...r})),{ignoreFilters});
  const {value}=await quiet(()=>recoverAbandonedLeases(db.sb,NOW));
  assert.deepEqual(db.calls.rpcs.map(c=>c.args.p_outbox),["past"],`ignoreFilters=${ignoreFilters}`);
  assert.deepEqual(value,{lookupFailed:false,eligible:1,recovered:1,unchanged:0,failed:0});
  assert.deepEqual(db.rows.map(r=>[r.id,r.delivery_status]),
   [["at","leased"],["past","uncertain"],["live","leased"],["grace","leased"],["graceEnd","leased"]]);
 }
 // Pure helper agrees (DB-side lt filter + JS strict <).
 assert.deepEqual(recoverableLeases(rows,NOW).map(c=>c.id),["past"]);
});
test("query: leased + provider kinds + lt(cutoff) + oldest first + bounded, read-only columns",async()=>{
 const db=fakeDb([]);
 await quiet(()=>recoverAbandonedLeases(db.sb,NOW));
 assert.deepEqual(db.calls.queries,[["from:automation_flow_outbox",
  "select:id,tenant_id,delivery_status,effect_kind,lease_expires_at",
  "eq:delivery_status=leased","in:effect_kind=message|question|message_image",
  `lt:lease_expires_at<${iso(CUT)}`,"order:lease_expires_at:true",`limit:${LEASE_RECOVERY_LIMIT}`]]);
 assert.deepEqual(db.calls.rpcs,[]);
});
test("kinds and statuses: message/question/message_image recovered; reply_comment, internal, ai and non-leased never touched",async()=>{
 const rows=[row("m",{effect_kind:"message"}),row("q",{effect_kind:"question"}),row("i",{effect_kind:"message_image"}),
  ...["reply_comment","tag","untag","staff_notification","handoff","delay","knowledge_ai","ai","internal"]
   .map(k=>row("k_"+k,{effect_kind:k})),
  ...["pending","retry_wait","charge_pending","settled","uncertain","cancelled","dead_letter","billing_blocked"]
   .map(s=>row("s_"+s,{delivery_status:s}))];
 for(const ignoreFilters of [false,true]){
  const db=fakeDb(rows.map(r=>({...r})),{ignoreFilters});
  await quiet(()=>recoverAbandonedLeases(db.sb,NOW));
  assert.deepEqual(db.calls.rpcs.map(c=>c.args.p_outbox).sort(),["i","m","q"],`ignoreFilters=${ignoreFilters}`);
  for(const r of db.rows.filter(r=>!["i","m","q"].includes(r.id))){
   const orig=rows.find(o=>o.id===r.id)!;
   assert.equal(r.delivery_status,orig.delivery_status,r.id);assert.equal(r.attempt,"attempting",r.id);
  }
 }
 // Malformed rows are ignored by the pure filter.
 assert.deepEqual(recoverableLeases([null,1,{...row("x"),tenant_id:""},{...row("y"),id:7},
  {...row("z"),lease_expires_at:"not a date"},{...row("w"),lease_expires_at:null}],NOW),[]);
 assert.deepEqual(recoverableLeases(null,NOW),[]);
});

// ---------------------------------------------------------------- finish call
test("finish: outcome 'uncertain', NULL provider id, exactly the executeOnce uncertain argument shape",async()=>{
 const db=fakeDb([row("m1",{lease_expires_at:iso(CUT-2000)}),
  row("i1",{effect_kind:"message_image",tenant_id:TB,lease_expires_at:iso(CUT-1000)})]);
 const {value}=await quiet(()=>recoverAbandonedLeases(db.sb,NOW));
 assert.deepEqual(db.calls.rpcs,[
  {fn:"flow_finish_outbox_delivery",args:{p_tenant:TA,p_outbox:"m1",p_result:"uncertain",p_provider_message_id:null}},
  {fn:"flow_finish_outbox_delivery",args:{p_tenant:TB,p_outbox:"i1",p_result:"uncertain",p_provider_message_id:null}}]);
 assert.equal(value.recovered,2);
 // Same keys, same order and same values index.ts sends for executeOnce's
 // confirm("uncertain",null) -> finish(status) (p_provider_message_id:providerId).
 const idx=readFileSync("supabase/functions/flow-outbox-worker/index.ts","utf8");
 assert.equal((idx.match(/sb\.rpc\("flow_finish_outbox_delivery",\{\n\s+p_tenant:effect\.tenant_id,p_outbox:effect\.id,p_result:result,\n\s+p_provider_message_id:providerId\n\s+\}\)/g)??[]).length,2);
 const ex=readFileSync("supabase/functions/flow-outbox-worker/executeOnce.ts","utf8");
 assert.match(ex,/catch\{\n\s+try\{await d\.confirm\("uncertain",null\);\}/);
 assert.deepEqual(Object.keys(leaseRecoveryFinishArgs(TA,"x")),["p_tenant","p_outbox","p_result","p_provider_message_id"]);
 assert.deepEqual(leaseRecoveryFinishArgs(TA,"x"),{p_tenant:TA,p_outbox:"x",p_result:"uncertain",p_provider_message_id:null});
});
test("bounded batch: more eligible rows than the limit -> only the limit, oldest lease first",async()=>{
 const n=LEASE_RECOVERY_LIMIT+7;
 // Inserted newest-first so the order must come from the query/helper.
 const rows=Array.from({length:n},(_,i)=>row(`r${String(n-i).padStart(3,"0")}`,{lease_expires_at:iso(CUT-1000*(n-i))}));
 const oldest=[...rows].sort((a,b)=>Date.parse(a.lease_expires_at!)-Date.parse(b.lease_expires_at!))
  .slice(0,LEASE_RECOVERY_LIMIT).map(r=>r.id);
 for(const ignoreFilters of [false,true]){
  const db=fakeDb(rows.map(r=>({...r})),{ignoreFilters});
  const {value}=await quiet(()=>recoverAbandonedLeases(db.sb,NOW));
  assert.equal(db.calls.rpcs.length,LEASE_RECOVERY_LIMIT,`ignoreFilters=${ignoreFilters}`);
  assert.deepEqual(db.calls.rpcs.map(c=>c.args.p_outbox),oldest);
  assert.equal(value.eligible,LEASE_RECOVERY_LIMIT);
  assert.equal(db.rows.filter(r=>r.delivery_status==="leased").length,7);
 }
});
test("tenant isolation: each finish carries the row's own tenant; two tenants, no cross-tenant finish",async()=>{
 // Same outbox id under two tenants (ids are only unique per tenant in the fake).
 const rows=[row("shared",{tenant_id:TA,lease_expires_at:iso(CUT-5000)}),
  row("shared",{tenant_id:TB,effect_kind:"question",lease_expires_at:iso(CUT-4000)}),
  row("onlyB",{tenant_id:TB,effect_kind:"message_image",lease_expires_at:iso(CUT-3000)})];
 const db=fakeDb(rows);
 const {value}=await quiet(()=>recoverAbandonedLeases(db.sb,NOW));
 assert.deepEqual(db.calls.rpcs.map(c=>[c.args.p_tenant,c.args.p_outbox]),[[TA,"shared"],[TB,"shared"],[TB,"onlyB"]]);
 assert.deepEqual(value,{lookupFailed:false,eligible:3,recovered:3,unchanged:0,failed:0});
 assert.ok(db.rows.every(r=>r.delivery_status==="uncertain"&&r.attempt==="uncertain"));
 // A row of tenant A is never finished with tenant B's id (fake RPC is tenant-scoped).
 const db2=fakeDb([row("a1",{tenant_id:TA})]);
 await quiet(()=>recoverAbandonedLeases(db2.sb,NOW));
 assert.equal(db2.calls.rpcs[0].args.p_tenant,TA);
});

// ---------------------------------------------------------------- never sends
test("recovery never calls fetch/provider and never writes rows directly",async()=>{
 const g=guardFetch();
 try{
  const db=fakeDb([row("m"),row("q",{effect_kind:"question"}),row("i",{effect_kind:"message_image"})]);
  await quiet(()=>recoverAbandonedLeases(db.sb,NOW));
  assert.equal(g.called(),0);
  assert.deepEqual(db.calls.writes,[]);
  assert.ok(db.calls.rpcs.every(c=>c.fn==="flow_finish_outbox_delivery"));
  assert.ok(db.rows.every(r=>r.delivery_status!=="pending"),"never reset to pending");
 }finally{g.restore();}
});
test("static: recovery module imports nothing and has no send/fetch/write/pending path",()=>{
 const s=readFileSync("supabase/functions/flow-outbox-worker/leaseRecovery.ts","utf8");
 const code=s.replace(/\/\*[\s\S]*?\*\//g,"").replace(/\/\/[^\n]*/g,"");
 assert.doesNotMatch(code,/^\s*import\s/m,"no imports at all");
 assert.doesNotMatch(code,/\bimport\(|\brequire\(/);
 assert.doesNotMatch(code,/\bfetch\b|sendProviderMessage|sendMultichannelMessage|deliveryCore|multichannelSend|executeOnce|commentReply/);
 assert.doesNotMatch(code,/\.(update|insert|upsert|delete)\(/);
 assert.doesNotMatch(code,/"pending"|'pending'|charge_pending|consume_|flow_reserve|reply_comment|retry_wait/);
 assert.equal((code.match(/\.rpc\(/g)??[]).length,1);
 assert.match(code,/\.rpc\("flow_finish_outbox_delivery",leaseRecoveryFinishArgs\(c\.tenantId,c\.id\)\)/);
});

// ---------------------------------------------------------------- failures / races
test("one RPC error or throw does not stop the rest and never throws out; logs carry no ids",async()=>{
 const rows=[row("a",{lease_expires_at:iso(CUT-4000)}),row("b",{lease_expires_at:iso(CUT-3000)}),
  row("c",{lease_expires_at:iso(CUT-2000)}),row("d",{lease_expires_at:iso(CUT-1000)})];
 const db=fakeDb(rows,{rpcError:a=>a.p_outbox==="a",rpcThrows:a=>a.p_outbox==="c"});
 const {value,logs}=await quiet(()=>recoverAbandonedLeases(db.sb,NOW));
 assert.deepEqual(db.calls.rpcs.map(c=>c.args.p_outbox),["a","b","c","d"]);
 assert.deepEqual(value,{lookupFailed:false,eligible:4,recovered:2,unchanged:0,failed:2});
 assert.deepEqual(db.rows.map(r=>r.delivery_status),["leased","uncertain","leased","uncertain"]);
 const text=JSON.stringify(logs);
 for(const leak of [TA,"\"a\"","\"c\"","XX000","socket"])assert.ok(!text.includes(leak),leak);
 assert.deepEqual(logs.map(l=>l[0]),["[outbox] lease recovery finish failed","[outbox] lease recovery"]);
});
test("lookup error or throw: no RPC, no throw, reported",async()=>{
 for(const o of [{listError:true},{listThrows:true}]){
  const db=fakeDb([row("m")],o);
  const {value,logs}=await quiet(()=>recoverAbandonedLeases(db.sb,NOW));
  assert.deepEqual(value,{lookupFailed:true,eligible:0,recovered:0,unchanged:0,failed:0});
  assert.deepEqual(db.calls.rpcs,[]);assert.deepEqual(logs,[["[outbox] lease recovery lookup failed"]]);
 }
});
test("race: a row that advanced between select and finish is a no-op (charge_pending / settled / uncertain)",async()=>{
 for(const [status,attempt] of [["charge_pending","confirmed"],["settled","confirmed"],["uncertain","uncertain"]]){
  const rows=[row("m")];
  const db=fakeDb(rows,{beforeFinish:()=>{rows[0].delivery_status=status;rows[0].attempt=attempt;}});
  const {value}=await quiet(()=>recoverAbandonedLeases(db.sb,NOW));
  assert.deepEqual(value,{lookupFailed:false,eligible:1,recovered:0,unchanged:1,failed:0},status);
  assert.equal(rows[0].delivery_status,status);assert.equal(rows[0].attempt,attempt);
 }
 // Second pass over an already recovered row: nothing selected, nothing called.
 const db=fakeDb([row("m")]);
 await quiet(()=>recoverAbandonedLeases(db.sb,NOW));
 const again=await quiet(()=>recoverAbandonedLeases(db.sb,NOW));
 assert.equal(db.calls.rpcs.length,1);assert.equal(again.value.eligible,0);
});
test("no eligible rows: silent, nothing called",async()=>{
 const db=fakeDb([row("live",{lease_expires_at:iso(NOW+1)})]);
 const {value,logs}=await quiet(()=>recoverAbandonedLeases(db.sb,NOW));
 assert.deepEqual(value,{lookupFailed:false,eligible:0,recovered:0,unchanged:0,failed:0});
 assert.deepEqual(logs,[]);assert.deepEqual(db.calls.rpcs,[]);
});

// ---------------------------------------------------------------- tick wiring
test("index.ts: recovery after the stale sweep, before listing; charge_pending path untouched",()=>{
 const s=readFileSync("supabase/functions/flow-outbox-worker/index.ts","utf8");
 assert.match(s,/^import \{recoverAbandonedLeases\} from "\.\/leaseRecovery\.ts";$/m);
 const sweep=s.indexOf('sb.rpc("flow_skip_blocked_outbox"');
 const sweepFail=s.indexOf('return json({error:"Outbox lifecycle unavailable",sends:0},503);');
 const call=s.indexOf("await recoverAbandonedLeases(sb,Date.now());");
 const list=s.indexOf('.in("delivery_status",["pending","charge_pending"])');
 const loop=s.indexOf("for(const effect of items??[]){");
 assert.ok(sweep>0&&sweepFail>sweep&&call>sweepFail&&list>call&&loop>list,"sweep < recovery < listing < loop");
 assert.equal((s.match(/recoverAbandonedLeases\(/g)??[]).length,1,"called once per tick");
 // Not inside the per-effect loop and not awaited conditionally.
 assert.ok(s.lastIndexOf("recoverAbandonedLeases(")<loop);
 // charge_pending recovery block byte-identical (persist + bill only, never sendProviderMessage).
 assert.ok(s.includes(` if(effect.delivery_status==="charge_pending"){
    const {data:attempt,error:attemptError}=await sb
     .from("automation_flow_delivery_attempts")
     .select("status,provider_message_id")
     .eq("tenant_id",effect.tenant_id).eq("outbox_id",effect.id).maybeSingle();
    const mid=confirmedOutboxMid(effect,attempt);
    if(attemptError||!mid){report("blocked");continue;}
    report(await persistAndBill(mid)?"settled":"billing_pending");
    continue;
   }`));
 // Listing unchanged: leased rows are still not listed for dispatch.
 assert.ok(s.includes(`.in("delivery_status",["pending","charge_pending"]).in("effect_kind",["message","question","message_image"])`));
});
