// Internal Flow effects executor (tag/untag/staff_notification/handoff):
// validation, per-run ordering, exactly-once, tenant isolation, gates and
// failure handling. In-memory PostgREST-like fake; no network, no Deno.
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInternalEffects,internalHeld,internalPayload,internalActionsReleased,
 INTERNAL_MAX_ATTEMPTS,INTERNAL_STALE_MINUTES,HANDOFF_EXPIRY_MINUTES}
 from "../supabase/functions/flow-internal-worker/internalEffects.ts";

type Row=Record<string,any>;
const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACC="11111111-1111-4111-8111-111111111111",ACCB="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONV="44444444-4444-4444-8444-444444444444",CONVB="55555555-5555-4555-8555-555555555555";
const RUN="77777777-7777-4777-8777-7777777777a4",RUNB="77777777-7777-4777-8777-7777777777b4";
const OWNER="99999999-9999-4999-8999-999999999999",AGENT="77777777-7777-4777-8777-777777777777";
const NOW=Date.parse("2026-11-05T10:00:00.000Z");
const T0="2026-11-05T09:59:00.000+00:00";

const PK:Record<string,string[]>={flow_conversation_tags:["tenant_id","conversation_id","tag"],
 flow_staff_notifications:["tenant_id","outbox_id"]};
type Op={table:string;op:string;eq:Record<string,unknown>};
function fakeDb(tables:Record<string,Row[]>,fail:(table:string,op:string,row?:Row)=>unknown=()=>null){
 const log:Op[]=[];
 const db={from(table:string){
  let op="select",patch:Row|null=null,ins:Row|null=null,limit=Infinity,single=false,returning=false;
  const preds:Array<(r:Row)=>boolean>=[];const eq:Record<string,unknown>={};
  const q:any={
   select(){if(op!=="select")returning=true;return q;},
   eq(k:string,v:unknown){eq[k]=v;preds.push(r=>r[k]===v);return q;},
   in(k:string,v:unknown[]){eq[k]=v;preds.push(r=>v.includes(r[k]));return q;},
   lte(k:string,v:string){preds.push(r=>typeof r[k]==="string"&&Date.parse(r[k])<=Date.parse(v));return q;},
   is(k:string,v:null){eq[k]=v;preds.push(r=>r[k]===v||r[k]===undefined);return q;},
   order(){return q;},limit(n:number){limit=n;return q;},
   maybeSingle(){single=true;return q;},
   update(p:Row){op="update";patch=p;return q;},
   insert(r:Row){op="insert";ins=r;return q;},
   delete(){op="delete";return q;},
   then(res:(v:unknown)=>void,rej:(e:unknown)=>void){
    try{
     log.push({table,op,eq:{...eq}});
     const rows=tables[table]??=[];
     const e=fail(table,op,ins??patch??undefined);
     if(e)return res({data:null,error:e});
     if(op==="insert"){
      const pk=PK[table];
      if(pk&&rows.some(r=>pk.every(k=>r[k]===ins![k])))
       return res({data:null,error:{code:"23505",message:"duplicate"}});
      rows.push({...ins});return res({data:null,error:null});
     }
     const hit=rows.filter(r=>preds.every(p=>p(r)));
     if(op==="delete"){tables[table]=rows.filter(r=>!hit.includes(r));return res({data:null,error:null});}
     if(op==="update"){for(const r of hit)Object.assign(r,patch);
      return res({data:returning?hit.map(r=>({id:r.id})):null,error:null});}
     const out=hit.slice(0,limit).map(r=>({...r}));
     return res({data:single?(out[0]??null):out,error:null});
    }catch(err){rej(err);}
   }
  };
  return q;
 }};
 return {db,log,tables};
}
const outbox=(id:string,kind:string,payload:Row,over:Row={})=>({tenant_id:A,id,run_id:RUN,
 delivery_status:"pending",effect_kind:kind,payload:{kind,...payload},created_at:T0,attempts:0,
 lease_token:null,lease_expires_at:null,...over});
function world(over:{outbox?:Row[];tables?:Record<string,Row[]>}={}){
 return {
  automation_flow_global_switch:[{singleton:true,enabled:true}],
  automation_flow_tenant_switches:[{tenant_id:A,enabled:true,test_only:false,production_approved:true},
   {tenant_id:B,enabled:true,test_only:false,production_approved:true}],
  tenants:[{id:A,is_active:true,user_id:OWNER},{id:B,is_active:true,user_id:AGENT}],
  automation_flow_runs:[{id:RUN,tenant_id:A,channel_account_id:ACC,platform:"instagram",conversation_id:CONV,
   flow_key:"lead",publication_revision:1,run_status:"handoff"},
   {id:RUNB,tenant_id:B,channel_account_id:ACCB,platform:"instagram",conversation_id:CONVB,
   flow_key:"lead",publication_revision:1,run_status:"completed"}],
  channel_accounts:[{id:ACC,tenant_id:A,platform:"instagram",is_active:true,agent_enabled:true,auto_reply:true},
   {id:ACCB,tenant_id:B,platform:"instagram",is_active:true,agent_enabled:true,auto_reply:true}],
  conversations:[{id:CONV,tenant_id:A,account_id:ACC,transferred:false,auto_paused_reason:null,human_agent_expires_at:null},
   {id:CONVB,tenant_id:B,account_id:ACCB,transferred:false,auto_paused_reason:null,human_agent_expires_at:null}],
  automation_flow_activations:[{tenant_id:A,channel_account_id:ACC,platform:"instagram",flow_key:"lead",revision:1,is_active:true},
   {tenant_id:B,channel_account_id:ACCB,platform:"instagram",flow_key:"lead",revision:1,is_active:true}],
  tenant_conversation_assignments:[],tenant_staff_memberships:[],
  flow_conversation_tags:[],flow_staff_notifications:[],
  automation_flow_outbox:over.outbox??[],
  ...(over.tables??{})
 } as Record<string,Row[]>;
}
let tok=0;
const deps={now:()=>NOW,canaryAccountId:ACC,newToken:()=>"00000000-0000-4000-8000-"+String(++tok).padStart(12,"0")};
const status=(t:Record<string,Row[]>,id:string)=>t.automation_flow_outbox.find(r=>r.id===id)!;
// welcome message (seq0) -> tag (1) -> notify (2) -> handoff message (3) -> handoff (4)
const chain=()=>[outbox("o-msg","message",{text:"أهلاً",seq:0}),
 outbox("o-tag","tag",{tag:"lead",seq:1}),outbox("o-not","staff_notification",{text:"عميل جديد",seq:2}),
 outbox("o-bye","message",{text:"سيتواصل معك موظف",seq:3}),outbox("o-hand","handoff",{seq:4})];

test("payload validation and operator flags",()=>{
 assert.deepEqual(internalPayload("tag",{kind:"tag",tag:"VIP lead"}),{kind:"tag",tag:"VIP lead"});
 for(const bad of [{kind:"tag",tag:"<b>"},{kind:"tag",tag:" x"},{kind:"tag",tag:"a".repeat(65)},{kind:"untag",tag:"x"},{kind:"tag"}])
  assert.equal(internalPayload("tag",bad),null,JSON.stringify(bad));
 assert.deepEqual(internalPayload("staff_notification",{kind:"staff_notification",text:"hi"}),{kind:"staff_notification",text:"hi"});
 for(const text of ["","  ","x".repeat(501),"a\u0000"])
  assert.equal(internalPayload("staff_notification",{kind:"staff_notification",text}),null);
 assert.deepEqual(internalPayload("handoff",{kind:"handoff"}),{kind:"handoff"});
 assert.equal(internalPayload("message",{kind:"message",text:"x"}),null,"never a provider effect");
 const env=(m:Record<string,string>)=>(k:string)=>m[k];
 assert.equal(internalActionsReleased(env({FLOW_INTERNAL_ACTIONS_ENABLED:"true",FLOW_WORKERS_OPERATOR_RELEASE:"production-canary-approved"})),true);
 assert.equal(internalActionsReleased(env({FLOW_INTERNAL_ACTIONS_ENABLED:"true"})),false);
 assert.equal(internalActionsReleased(env({FLOW_WORKERS_OPERATOR_RELEASE:"production-canary-approved"})),false);
 assert.equal(internalActionsReleased(env({FLOW_INTERNAL_ACTIONS_ENABLED:"1",FLOW_WORKERS_OPERATOR_RELEASE:"production-canary-approved"})),false);
});

test("ordering: an internal effect waits for every earlier message (sent or ended) and earlier internal effect of the same run",()=>{
 const rows=chain() as any[];
 const tag=rows[1],hand=rows[4];
 assert.equal(internalHeld(tag,rows),true,"welcome still pending");
 for(const s of ["leased","retry_wait","mystery"])
  assert.equal(internalHeld(tag,rows.map(r=>r.id==="o-msg"?{...r,delivery_status:s}:r)),true,s);
 for(const s of ["settled","charge_pending","uncertain","cancelled","dead_letter","billing_blocked"])
  assert.equal(internalHeld(tag,rows.map(r=>r.id==="o-msg"?{...r,delivery_status:s}:r)),false,s);
 const sent=rows.map(r=>r.id==="o-msg"?{...r,delivery_status:"settled"}:r);
 assert.equal(internalHeld(hand,sent),true,"handoff waits for tag/notify/handoff message");
 const allDone=sent.map(r=>r.id==="o-hand"?r:{...r,delivery_status:"settled"});
 assert.equal(internalHeld(hand,allDone),false);
 assert.equal(internalHeld(hand,allDone.map(r=>r.id==="o-not"?{...r,delivery_status:"leased"}:r)),true);
 // An older commit holds too; other runs/tenants and delay rows never hold.
 const older={...rows[0],id:"o-old",created_at:"2026-11-05T09:00:00.000+00:00",payload:{kind:"message",seq:4}};
 assert.equal(internalHeld(tag,[older,{...rows[0],delivery_status:"settled"}]),true);
 assert.equal(internalHeld(tag,[{...older,run_id:RUNB},{...older,tenant_id:B},
  {...older,effect_kind:"delay"},{...rows[0],delivery_status:"settled"}]),false);
 // Later effects never hold earlier ones.
 assert.equal(internalHeld(tag,[rows[3],rows[4],{...rows[0],delivery_status:"settled"}]),false);
});

test("welcome -> tag -> notify -> handoff message -> handoff: exact order, exactly once, existing takeover fields",async()=>{
 const t=world({outbox:chain()});
 const {db}=fakeDb(t);
 let r=await runInternalEffects(db,deps);
 assert.equal(r.held_order,3,JSON.stringify(r));
 assert.equal(t.flow_conversation_tags.length,0);assert.equal(t.conversations[0].transferred,false);
 status(t,"o-msg").delivery_status="settled"; // outbox worker sent the welcome
 r=await runInternalEffects(db,deps);
 assert.equal(r.tag_applied,1);assert.equal(r.staff_notification_applied,1);
 assert.equal(r.held_order,1,"handoff waits for the handoff message");
 assert.equal(t.conversations[0].transferred,false);
 assert.deepEqual(t.flow_conversation_tags.map(x=>[x.tenant_id,x.conversation_id,x.tag,x.created_by_outbox]),[[A,CONV,"lead","o-tag"]]);
 assert.deepEqual(t.flow_staff_notifications.map(x=>[x.tenant_id,x.outbox_id,x.conversation_id,x.recipient_user_id,x.body]),
  [[A,"o-not",CONV,OWNER,"عميل جديد"]],"no assignment: the tenant owner");
 status(t,"o-bye").delivery_status="settled";
 r=await runInternalEffects(db,deps);
 assert.equal(r.handoff_applied,1);
 const c=t.conversations[0];
 assert.equal(c.transferred,true);assert.equal(c.auto_paused_reason,"ai_handoff");
 assert.equal(c.human_agent_expires_at,new Date(NOW+HANDOFF_EXPIRY_MINUTES*60000).toISOString());
 for(const id of ["o-tag","o-not","o-hand"]){
  assert.equal(status(t,id).delivery_status,"settled",id);assert.equal(status(t,id).attempts,1,id);
  assert.equal(status(t,id).lease_token,null);
 }
 // Re-ticks: nothing executes twice.
 for(let i=0;i<3;i++)assert.deepEqual(await runInternalEffects(db,deps),{});
 assert.equal(t.flow_conversation_tags.length,1);assert.equal(t.flow_staff_notifications.length,1);
 // Tenant B's conversation is untouched.
 assert.equal(t.conversations[1].transferred,false);
});

test("same tick: tag then untag of the same tag in order; assigned active agent receives the notification",async()=>{
 const t=world({outbox:[outbox("t1","tag",{tag:"vip",seq:0}),outbox("t2","untag",{tag:"vip",seq:1}),
  outbox("t3","staff_notification",{text:"راجع",seq:2})],
  tables:{tenant_conversation_assignments:[{tenant_id:A,conversation_id:CONV,user_id:AGENT,status:"active",created_at:T0}],
   tenant_staff_memberships:[{tenant_id:A,user_id:AGENT,role:"agent",status:"active"}]}});
 const {db}=fakeDb(t);
 const r=await runInternalEffects(db,deps);
 assert.equal(r.tag_applied,1);assert.equal(r.untag_applied,1);assert.equal(r.staff_notification_applied,1);
 assert.equal(t.flow_conversation_tags.length,0,"untag after tag");
 assert.equal(t.flow_staff_notifications[0].recipient_user_id,AGENT);
 // Suspended agent -> owner.
 const t2=world({outbox:[outbox("n","staff_notification",{text:"x",seq:0})],
  tables:{tenant_conversation_assignments:[{tenant_id:A,conversation_id:CONV,user_id:AGENT,status:"active",created_at:T0}],
   tenant_staff_memberships:[{tenant_id:A,user_id:AGENT,role:"agent",status:"suspended"}]}});
 await runInternalEffects(fakeDb(t2).db,deps);
 assert.equal(t2.flow_staff_notifications[0].recipient_user_id,OWNER);
});

test("crash recovery: an expired lease is reclaimed and the idempotent write is not duplicated; a live lease is left alone",async()=>{
 const expired=new Date(NOW-1000).toISOString(),live=new Date(NOW+60000).toISOString();
 const t=world({outbox:[outbox("t1","tag",{tag:"vip",seq:0},{delivery_status:"leased",attempts:1,
   lease_token:"11111111-0000-4000-8000-000000000001",lease_expires_at:expired}),
  outbox("n1","staff_notification",{text:"x",seq:1},{delivery_status:"leased",attempts:1,
   lease_token:"11111111-0000-4000-8000-000000000002",lease_expires_at:expired}),
  outbox("h1","handoff",{seq:2},{delivery_status:"leased",attempts:1,
   lease_token:"11111111-0000-4000-8000-000000000003",lease_expires_at:live})],
  tables:{flow_conversation_tags:[{tenant_id:A,conversation_id:CONV,tag:"vip",created_by_outbox:"t1"}],
   flow_staff_notifications:[{tenant_id:A,outbox_id:"n1",conversation_id:CONV,recipient_user_id:OWNER,body:"x"}]}});
 const r=await runInternalEffects(fakeDb(t).db,deps);
 assert.equal(r.tag_noop,1);assert.equal(r.staff_notification_noop,1);
 assert.equal(t.flow_conversation_tags.length,1);assert.equal(t.flow_staff_notifications.length,1);
 assert.equal(status(t,"t1").delivery_status,"settled");assert.equal(status(t,"t1").attempts,2);
 assert.equal(status(t,"h1").delivery_status,"leased","live lease: another worker owns it");
 assert.equal(t.conversations[0].transferred,false);
});

test("a handoff never overwrites an existing takeover (staff took over first)",async()=>{
 const t=world({outbox:[outbox("h","handoff",{seq:0})]});
 Object.assign(t.conversations[0],{transferred:true,auto_paused_reason:"manual_takeover",human_agent_expires_at:"2026-11-05T10:05:00.000Z"});
 const r=await runInternalEffects(fakeDb(t).db,deps);
 assert.equal(r.handoff_noop,1);assert.equal(status(t,"h").delivery_status,"settled");
 assert.equal(t.conversations[0].auto_paused_reason,"manual_takeover");
 assert.equal(t.conversations[0].human_agent_expires_at,"2026-11-05T10:05:00.000Z");
});

test("tenant isolation: every statement is tenant-scoped; foreign or mismatched rows are cancelled, never written",async()=>{
 // Tenant B's outbox row pointing at tenant A's run id; tenant A row whose conversation belongs to another account.
 const t=world({outbox:[outbox("x1","tag",{tag:"vip",seq:0},{tenant_id:B,run_id:RUN}),
  outbox("x2","handoff",{seq:0},{run_id:"77777777-7777-4777-8777-7777777777c4"})]});
 t.automation_flow_runs.push({id:"77777777-7777-4777-8777-7777777777c4",tenant_id:A,channel_account_id:ACC,platform:"instagram",
  conversation_id:CONVB,flow_key:"lead",publication_revision:1,run_status:"handoff"});
 const {db,log}=fakeDb(t);
 const r=await runInternalEffects(db,deps);
 assert.equal(r.skipped_ineligible,2,JSON.stringify(r));
 assert.equal(status(t,"x1").cancel_reason,"ineligible");
 assert.equal(t.flow_conversation_tags.length,0);
 assert.equal(t.conversations[0].transferred,false);assert.equal(t.conversations[1].transferred,false);
 const scoped=["automation_flow_tenant_switches","automation_flow_runs","channel_accounts","conversations",
  "automation_flow_activations","flow_conversation_tags","flow_staff_notifications",
  "tenant_conversation_assignments","tenant_staff_memberships"];
 for(const op of log){
  if(scoped.includes(op.table))assert.ok(typeof op.eq.tenant_id==="string",op.table+" "+op.op+" unscoped");
  if(op.table==="automation_flow_outbox"&&op.op!=="select")assert.ok(op.eq.tenant_id&&op.eq.id,"outbox write by key");
 }
 // Run/account/conversation of tenant B are read with tenant B only.
 assert.ok(log.filter(o=>o.table==="automation_flow_runs").every(o=>
  (o.eq.tenant_id===B&&o.eq.id===RUN)||o.eq.tenant_id===A));
});

test("gates: switch/approval, canary and pauses keep effects pending; inactive revision and stale cancel; nothing written",async()=>{
 const one=()=>world({outbox:[outbox("t","tag",{tag:"vip",seq:0})]});
 const cases:Array<[string,(t:Record<string,Row[]>)=>void,string,string]>=[
  ["tenant switch off",t=>{t.automation_flow_tenant_switches[0].enabled=false;},"blocked_switch","pending"],
  ["not production approved",t=>{t.automation_flow_tenant_switches[0].production_approved=false;},"blocked_switch","pending"],
  ["auto_reply off",t=>{t.channel_accounts[0].auto_reply=false;},"paused","pending"],
  ["tenant inactive",t=>{t.tenants[0].is_active=false;},"paused","pending"],
  ["revision inactive",t=>{t.automation_flow_activations[0].is_active=false;},"skipped_revision_inactive","cancelled"],
  ["facebook run",t=>{t.automation_flow_runs[0].platform="facebook";},"skipped_ineligible","cancelled"],
  ["stale",t=>{t.automation_flow_outbox[0].created_at=new Date(NOW-INTERNAL_STALE_MINUTES*60000-1).toISOString();},"skipped_stale","cancelled"],
 ];
 for(const [label,mutate,key,st] of cases){
  const t=one();mutate(t);
  const r=await runInternalEffects(fakeDb(t).db,deps);
  assert.equal(r[key],1,label+" "+JSON.stringify(r));
  assert.equal(status(t,"t").delivery_status,st,label);
  assert.equal(t.flow_conversation_tags.length,0,label);
 }
 const t=one();
 assert.deepEqual(await runInternalEffects(fakeDb(t).db,{...deps,canaryAccountId:ACCB}),{blocked_canary:1});
 assert.equal(status(t,"t").delivery_status,"pending");
 const g=one();g.automation_flow_global_switch[0].enabled=false;
 const {db,log}=fakeDb(g);
 assert.deepEqual(await runInternalEffects(db,deps),{blocked_global:1});
 assert.deepEqual(log.map(o=>o.table),["automation_flow_global_switch"]);
 assert.deepEqual(await runInternalEffects(fakeDb(one()).db,{...deps,canaryAccountId:""}),{blocked_config:1});
});

test("failures: transient retries are bounded then dead_letter; invalid payload and missing recipient are terminal; no text logged",async()=>{
 const logs:string[]=[];
 const orig={error:console.error,warn:console.warn,info:console.info};
 for(const k of ["error","warn","info"] as const)(console as any)[k]=(...a:unknown[])=>logs.push(JSON.stringify(a));
 try{
  const t=world({outbox:[outbox("t","tag",{tag:"secret-tag-name",seq:0})]});
  const {db}=fakeDb(t,(table,op)=>table==="flow_conversation_tags"&&op==="insert"?{code:"57014",message:"timeout"}:null);
  for(let i=1;i<INTERNAL_MAX_ATTEMPTS;i++){
   const r=await runInternalEffects(db,deps);
   assert.equal(r.retry_transient,1,JSON.stringify(r));
   assert.equal(status(t,"t").delivery_status,"pending");assert.equal(status(t,"t").attempts,i);
  }
  const r=await runInternalEffects(db,deps);
  assert.equal(r.failed_transient,1);
  assert.equal(status(t,"t").delivery_status,"dead_letter");assert.equal(status(t,"t").attempts,INTERNAL_MAX_ATTEMPTS);
  assert.deepEqual(await runInternalEffects(db,deps),{},"terminal: never retried again");
  // Invalid payload (kind mismatch / bad tag) -> dead_letter without a write.
  const bad=world({outbox:[outbox("b","tag",{tag:"<script>",seq:0}),
   {...outbox("k","untag",{tag:"x",seq:1}),payload:{kind:"tag",tag:"x",seq:1}}]});
  const rb=await runInternalEffects(fakeDb(bad).db,deps);
  assert.equal(rb.failed_invalid,2,JSON.stringify(rb));
  // No recipient at all (no owner) -> dead_letter.
  const nr=world({outbox:[outbox("n","staff_notification",{text:"customer phone +9647700000000",seq:0})]});
  nr.tenants[0].user_id=null;
  const rn=await runInternalEffects(fakeDb(nr).db,deps);
  assert.equal(rn.failed_permanent,1);assert.equal(status(nr,"n").delivery_status,"dead_letter");
  // A dead-lettered handoff no longer holds anything; FK violation is permanent.
  const fk=world({outbox:[outbox("f","tag",{tag:"vip",seq:0})]});
  await runInternalEffects(fakeDb(fk,(tb,op)=>tb==="flow_conversation_tags"&&op==="insert"?{code:"23503",message:"fk"}:null).db,deps);
  assert.equal(status(fk,"f").delivery_status,"dead_letter");
 }finally{Object.assign(console,orig);}
 const all=logs.join("\n");
 assert.ok(logs.length>0);
 for(const secret of ["secret-tag-name","+9647700000000","customer phone","<script>"])
  assert.ok(!all.includes(secret),"logged "+secret);
});

test("wiring: outbox worker runs the executor after its message pass behind both flags; standalone worker uses the same gate",()=>{
 const ob=readFileSync("supabase/functions/flow-outbox-worker/index.ts","utf8");
 const loopEnd=ob.indexOf("return json({processed:");
 const call=ob.indexOf("runInternalEffects(sb,");
 assert.ok(call>ob.indexOf("for(const effect of items??[])")&&call<loopEnd,"after the message loop");
 assert.match(ob,/internalActionsReleased\(k=>Deno\.env\.get\(k\)\)\?/);
 // The billing path is unchanged: the executor never reserves, sends or debits.
 const ex=readFileSync("supabase/functions/flow-internal-worker/internalEffects.ts","utf8");
 assert.doesNotMatch(ex,/consume_flow_reply|flow_reserve_outbox_delivery|sendProviderMessage|credits_remaining|fetch\(/);
 const iw=readFileSync("supabase/functions/flow-internal-worker/index.ts","utf8");
 assert.match(iw,/if\(!internalActionsReleased\(k=>Deno\.env\.get\(k\)\)\)return reply\(423/);
 assert.match(iw,/req\.headers\.get\("authorization"\)!=="Bearer "\+key/);
 assert.ok(iw.indexOf("internalActionsReleased(")<iw.indexOf("createClient("),"flags before any client");
});

// ---------------------------------------------------------------- reliability
const later=(ms:number)=>({...deps,now:()=>NOW+ms});
const four=()=>[outbox("r-tag","tag",{tag:"vip",seq:0}),outbox("r-untag","untag",{tag:"old",seq:1}),
 outbox("r-not","staff_notification",{text:"راجع",seq:2}),outbox("r-hand","handoff",{seq:3})];
const writes=(log:Op[])=>log.filter(o=>o.op!=="select"&&o.table!=="automation_flow_outbox");

test("crash between the write and the settle (all four kinds): the row stays leased, is reclaimed only after expiry, re-run is a no-op",async()=>{
 const t=world({outbox:four(),tables:{flow_conversation_tags:[{tenant_id:A,conversation_id:CONV,tag:"old",created_by_outbox:"x"}]}});
 // The settle of every effect is lost (process killed after the write).
 let crash=true;
 const {db}=fakeDb(t,(table,op,row)=>crash&&table==="automation_flow_outbox"&&op==="update"&&
  row?.delivery_status==="settled"?{code:"08006",message:"connection lost"}:null);
 let r=await runInternalEffects(db,deps);
 // Only the first is applied: the later ones are held by the unsettled earlier effect.
 assert.equal(r.finish_failed,1,JSON.stringify(r));assert.equal(r.held_order,3);
 assert.equal(status(t,"r-tag").delivery_status,"leased");
 assert.deepEqual(t.flow_conversation_tags.map(x=>x.tag).sort(),["old","vip"]);
 // Live lease: another tick (another worker) leaves it alone and does not write.
 crash=false;
 r=await runInternalEffects(db,later(60000));
 assert.equal(r.tag_noop??0,0,JSON.stringify(r));assert.equal(status(t,"r-tag").attempts,1);
 // After expiry it is reclaimed (attempts 2), the write is a duplicate -> noop, then the rest run in order.
 r=await runInternalEffects(db,later(121000));
 assert.equal(r.tag_noop,1,JSON.stringify(r));assert.equal(r.untag_applied,1);
 assert.equal(r.staff_notification_applied,1);assert.equal(r.handoff_applied,1);
 assert.equal(status(t,"r-tag").attempts,2);
 assert.deepEqual(t.flow_conversation_tags.map(x=>x.tag),["vip"]);
 // Each other kind alone: lost settle -> lease expiry -> reclaim (attempts 2) -> noop, exactly one result.
 for(const [kind,p] of [["untag",{tag:"x"}],["staff_notification",{text:"x"}],["handoff",{}]] as Array<[string,Row]>){
  const t2=world({outbox:[outbox("e",kind,{...p,seq:0})]});
  let lost=false;
  const {db:d2}=fakeDb(t2,(table,op,row)=>{
   if(!lost&&table==="automation_flow_outbox"&&op==="update"&&row?.delivery_status==="settled"){lost=true;return {code:"08006",message:"lost"};}
   return null;});
  assert.equal((await runInternalEffects(d2,deps)).finish_failed,1,kind);
  assert.equal(status(t2,"e").delivery_status,"leased",kind);
  const after=await runInternalEffects(d2,later(121000));
  assert.equal(after[kind+"_noop"]??after[kind+"_applied"],1,kind+" "+JSON.stringify(after));
  assert.equal(status(t2,"e").delivery_status,"settled",kind);assert.equal(status(t2,"e").attempts,2,kind);
  assert.equal(t2.flow_staff_notifications.length,kind==="staff_notification"?1:0);
  if(kind==="handoff"){
   assert.equal(after.handoff_noop,1,"already transferred by the crashed attempt");
   assert.equal(t2.conversations[0].human_agent_expires_at,new Date(NOW+HANDOFF_EXPIRY_MINUTES*60000).toISOString(),
    "the reclaimed handoff did not move the takeover expiry");
  }
 }
});

test("final attempt crashed after its write (attempts=3, expired lease): verified read-only and settled, never a false dead_letter",async()=>{
 const expired=new Date(NOW-1000).toISOString();
 const leased=(id:string,kind:string,p:Row,seq:number)=>outbox(id,kind,{...p,seq},{delivery_status:"leased",
  attempts:INTERNAL_MAX_ATTEMPTS,lease_token:"22222222-0000-4000-8000-00000000000"+seq,lease_expires_at:expired});
 const t=world({outbox:[leased("a","tag",{tag:"vip"},0),leased("b","untag",{tag:"gone"},1),
  leased("c","staff_notification",{text:"x"},2),leased("d","handoff",{},3)],
  tables:{flow_conversation_tags:[{tenant_id:A,conversation_id:CONV,tag:"vip",created_by_outbox:"a"}],
   flow_staff_notifications:[{tenant_id:A,outbox_id:"c",conversation_id:CONV,recipient_user_id:OWNER,body:"x"}]}});
 Object.assign(t.conversations[0],{transferred:true,auto_paused_reason:"ai_handoff",human_agent_expires_at:"2026-11-05T10:14:00.000Z"});
 const {db,log}=fakeDb(t);
 const r=await runInternalEffects(db,deps);
 assert.deepEqual(r,{tag_recovered:1,untag_recovered:1,staff_notification_recovered:1,handoff_recovered:1});
 for(const id of ["a","b","c","d"]){
  assert.equal(status(t,id).delivery_status,"settled",id);assert.equal(status(t,id).attempts,INTERNAL_MAX_ATTEMPTS,id);
  assert.equal(status(t,id).lease_token,null,id);
 }
 assert.deepEqual(writes(log),[],"verification never writes");
 for(const op of log.filter(o=>["flow_conversation_tags","flow_staff_notifications","conversations"].includes(o.table)))
  assert.equal(op.eq.tenant_id,A,"verification is tenant-scoped: "+op.table);
 assert.equal(t.conversations[0].human_agent_expires_at,"2026-11-05T10:14:00.000Z");
 // Not applied -> dead_letter (bounded); lookup error -> stays leased for the next tick.
 const n=world({outbox:[leased("a","tag",{tag:"vip"},0),{...leased("h","handoff",{},1),run_id:RUNB,tenant_id:B}]});
 const rn=await runInternalEffects(fakeDb(n).db,{...deps,canaryAccountId:ACC});
 assert.equal(rn.failed_exhausted,1,JSON.stringify(rn));assert.equal(status(n,"a").delivery_status,"dead_letter");
 const e=world({outbox:[leased("a","tag",{tag:"vip"},0)]});
 const re=await runInternalEffects(fakeDb(e,(tb,op)=>tb==="flow_conversation_tags"&&op==="select"?{code:"57014"}:null).db,deps);
 assert.equal(re.blocked,1,JSON.stringify(re));assert.equal(status(e,"a").delivery_status,"leased");
 // A LIVE final lease is never touched.
 const l=world({outbox:[{...leased("a","tag",{tag:"vip"},0),lease_expires_at:new Date(NOW+60000).toISOString()}]});
 assert.deepEqual(await runInternalEffects(fakeDb(l).db,deps),{});
 assert.equal(status(l,"a").delivery_status,"leased");
});

test("concurrent executors: one claimant per effect; a stale lease token can never settle a reclaimed effect",async()=>{
 const t=world({outbox:four()});
 const {db}=fakeDb(t);
 const [x,y]=await Promise.all([runInternalEffects(db,deps),runInternalEffects(db,deps)]);
 const sum=(k:string)=>(x[k]??0)+(y[k]??0);
 assert.equal(sum("tag_applied"),1,JSON.stringify([x,y]));
 assert.equal(t.flow_conversation_tags.length,1);
 // Drain the rest; every effect claimed exactly once.
 await runInternalEffects(db,deps);await runInternalEffects(db,deps);
 for(const o of t.automation_flow_outbox){assert.equal(o.delivery_status,"settled",o.id);assert.equal(o.attempts,1,o.id);}
 assert.equal(t.flow_staff_notifications.length,1);
 // Worker 1 is slow: while it writes, its lease expires and worker 2 reclaims (new token).
 const s=world({outbox:[outbox("s","tag",{tag:"vip",seq:0})]});
 const W2="33333333-0000-4000-8000-000000000002";
 const {db:sd}=fakeDb(s,(table,op)=>{
  if(table==="flow_conversation_tags"&&op==="insert")
   Object.assign(status(s,"s"),{lease_token:W2,attempts:2,lease_expires_at:new Date(NOW+999999).toISOString()});
  return null;});
 const r=await runInternalEffects(sd,deps);
 assert.equal(r.finish_failed,1,JSON.stringify(r));
 assert.equal(status(s,"s").delivery_status,"leased");assert.equal(status(s,"s").lease_token,W2,"worker 2 keeps its lease");
});

test("scan: older held / paused / live-leased rows of other runs never hold a newer eligible effect (no head-of-line blocking)",async()=>{
 const RUN2="77777777-7777-4777-8777-7777777777d4",CONV2="44444444-4444-4444-8444-4444444444d4";
 const older="2026-11-05T09:00:00.000+00:00";
 const t=world({outbox:[
  outbox("m2","message",{text:"x",seq:0},{run_id:RUN2,created_at:older}),
  ...Array.from({length:20},(_,i)=>outbox("held"+i,"tag",{tag:"t"+i,seq:1},{run_id:RUN2,created_at:older})),
  ...Array.from({length:20},(_,i)=>outbox("live"+i,"tag",{tag:"l"+i,seq:0},{run_id:RUN2,created_at:older,
   delivery_status:"leased",attempts:1,lease_token:"44444444-0000-4000-8000-0000000000"+String(i).padStart(2,"0"),
   lease_expires_at:new Date(NOW+60000).toISOString()})),
  outbox("new","tag",{tag:"vip",seq:0})]});
 t.automation_flow_runs.push({id:RUN2,tenant_id:A,channel_account_id:ACC,platform:"instagram",conversation_id:CONV2,
  flow_key:"lead",publication_revision:1,run_status:"completed"});
 t.conversations.push({id:CONV2,tenant_id:A,account_id:ACC,transferred:false});
 const r=await runInternalEffects(fakeDb(t).db,deps);
 assert.equal(r.tag_applied,1,JSON.stringify(r));assert.equal(r.held_order,20);
 assert.equal(status(t,"new").delivery_status,"settled");
 assert.ok(t.automation_flow_outbox.filter(o=>o.id.startsWith("live")).every(o=>o.delivery_status==="leased"));
});

test("handoff failures: transient -> bounded retries -> dead_letter, conversation untouched, run state unchanged, nothing logged but ids/codes",async()=>{
 const logs:string[]=[];const orig={error:console.error,warn:console.warn,info:console.info};
 for(const k of ["error","warn","info"] as const)(console as any)[k]=(...a:unknown[])=>logs.push(JSON.stringify(a));
 try{
  const t=world({outbox:[outbox("h","handoff",{seq:0})]});
  const {db}=fakeDb(t,(table,op)=>table==="conversations"&&op==="update"?{code:"40001",message:"serialization"}:null);
  for(let i=1;i<=INTERNAL_MAX_ATTEMPTS;i++)await runInternalEffects(db,deps);
  assert.equal(status(t,"h").delivery_status,"dead_letter");assert.equal(status(t,"h").attempts,INTERNAL_MAX_ATTEMPTS);
  assert.equal(t.conversations[0].transferred,false);assert.equal(t.conversations[0].auto_paused_reason,null);
  assert.equal(t.automation_flow_runs[0].run_status,"handoff","the run keeps its committed status");
  assert.deepEqual(await runInternalEffects(db,deps),{},"a dead_letter is never retried");
  // Permanent: the conversation vanished between the scope check and the switch -> dead_letter at once.
  const p=world({outbox:[outbox("h","handoff",{seq:0})]});
  const {db:pd}=fakeDb(p,(table,op)=>{if(table==="conversations"&&op==="update")p.conversations[0].account_id=ACCB;return null;});
  assert.equal((await runInternalEffects(pd,deps)).failed_permanent,1);
  assert.equal(status(p,"h").delivery_status,"dead_letter");assert.equal(status(p,"h").attempts,1);
 }finally{Object.assign(console,orig);}
 const all=logs.join("\n");
 assert.match(all,/effect failed terminally/);assert.match(all,/"code":"40001"/);
 assert.doesNotMatch(all,/serialization|ai_handoff/);
});
