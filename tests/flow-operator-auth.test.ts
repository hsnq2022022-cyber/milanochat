/**
 * flow-publication server-side operator allowlist (FLOW_OPERATOR_USER_IDS):
 * the pure parser (operatorAuth.ts) and the real handler through the shared
 * offline double. Dummy test-only UUIDs; no network, no secrets.
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {parseOperatorAllowlist,isOperator,isCustomerAction,CUSTOMER_ACTIONS}
 from "../supabase/functions/flow-publication/operatorAuth.ts";
import {v2Doc,T,A,USER,STAFF_USER,KEY,pub,act,server,prodState,PROD_ENV,type Env}
 from "./flowPublicationDouble.ts";

// ------------------------------------------------------------ parser
const U1="0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",U2="ffffffff-ffff-4fff-bfff-ffffffffffff";
const ids=(r:ReturnType<typeof parseOperatorAllowlist>)=>r.ok?[...r.ids].sort():null;

test("parser: valid single and multiple entries",()=>{
 assert.deepEqual(ids(parseOperatorAllowlist(U1)),[U1]);
 assert.deepEqual(ids(parseOperatorAllowlist(U1+","+U2)),[U1,U2].sort());
 // Versionless strict 8-4-4-4-12 hex (no version/variant requirement).
 assert.deepEqual(ids(parseOperatorAllowlist("12345678-1234-1234-1234-123456789abc")),["12345678-1234-1234-1234-123456789abc"]);
});
test("parser: uppercase and whitespace are normalized, duplicates removed",()=>{
 assert.deepEqual(ids(parseOperatorAllowlist("  "+U1.toUpperCase()+" ,\t"+U2+"\n")),[U1,U2].sort());
 assert.deepEqual(ids(parseOperatorAllowlist(U1+","+U1.toUpperCase()+", "+U1)),[U1]);
});
test("parser: the WHOLE list is rejected on any bad entry (no partial acceptance)",()=>{
 const bad:unknown[]=[undefined,null,"","   ",",",U1+",",","+U1,U1+",,"+U2,U1+", ,"+U2,
  "00000000-0000-0000-0000-000000000000",U1+",00000000-0000-0000-0000-000000000000",
  "not-a-uuid",U1+",not-a-uuid","{"+U1+"}",U1.replace(/-/g,""),U1+"0",U1.slice(1),
  "g"+U1.slice(1),U1+";"+U2,U1+" "+U2,42,{},[U1],true];
 for(const raw of bad)assert.deepEqual(parseOperatorAllowlist(raw as any),{ok:false},JSON.stringify(raw));
});
test("parser: limits (<= 50 entries, <= 4096 chars)",()=>{
 const uuid=(i:number)=>i.toString(16).padStart(8,"0")+"-1111-4111-8111-111111111111";
 const fifty=Array.from({length:50},(_,i)=>uuid(i+1));
 assert.equal(ids(parseOperatorAllowlist(fifty.join(",")))?.length,50);
 assert.deepEqual(parseOperatorAllowlist([...fifty,uuid(51)].join(",")),{ok:false});
 // 50 duplicates are still 50 entries; 51 duplicates breach the entry limit.
 assert.ok(parseOperatorAllowlist(Array(50).fill(U1).join(",")).ok);
 assert.deepEqual(parseOperatorAllowlist(Array(51).fill(U1).join(",")),{ok:false});
 const padded=U1+" ".repeat(4096-U1.length);
 assert.ok(parseOperatorAllowlist(padded).ok);
 assert.deepEqual(parseOperatorAllowlist(padded+" "),{ok:false});
});
test("isOperator: verified string id, case-insensitive, invalid list => false",()=>{
 const list=parseOperatorAllowlist(U1);
 assert.equal(isOperator(U1,list),true);
 assert.equal(isOperator(U1.toUpperCase(),list),true);
 assert.equal(isOperator(U2,list),false);
 for(const v of [undefined,null,42,{id:U1},[U1],""])assert.equal(isOperator(v,list),false);
 assert.equal(isOperator(U1,{ok:false}),false);
 assert.equal(isOperator(U1,parseOperatorAllowlist("")),false);
 assert.equal(isOperator(U1,undefined as any),false);
});
test("customer actions: exact set, everything else (incl. non-strings) is operator-gated",()=>{
 assert.deepEqual([...CUSTOMER_ACTIONS].sort(),["accounts","capabilities","deactivate","operator_status","publish_live"]);
 for(const a of ["accounts","capabilities","publish_live","deactivate","operator_status"])assert.equal(isCustomerAction(a),true);
 for(const a of ["readiness","catalog","read","list","publish","activate","rollback","frobnicate","ACCOUNTS",
  " accounts","",undefined,null,42,["accounts"],{}])assert.equal(isCustomerAction(a),false,String(a));
});

// ------------------------------------------------------------ handler
const DENIED={ok:false,error:"Operator access required"};
/** Only USER.a is an operator; USER.b is an ordinary tenant owner. */
const ONLY_A:Env={...PROD_ENV,FLOW_OPERATOR_USER_IDS:USER.a};
const PROTECTED=(account:string)=>[
 {action:"readiness",accountId:account,flowKey:KEY},
 {action:"catalog",accountId:account,flowKey:KEY},
 {action:"read",accountId:account,flowKey:KEY,revision:2},
 {action:"list",accountId:account,flowKey:KEY},
 {action:"publish",accountId:account,flowKey:KEY,document:v2Doc("NEW")},
 {action:"activate",accountId:account,flowKey:KEY,revision:2},
 {action:"rollback",accountId:account,flowKey:KEY,revision:3}];
const INVALID_LISTS:Record<string,string|undefined>={missing:undefined,empty:"",blank:"   ",
 malformed:"not-a-uuid",trailingComma:USER.a+",",nil:"00000000-0000-0000-0000-000000000000",
 partlyBad:USER.a+",x",tooMany:Array.from({length:51},()=>USER.a).join(","),
 tooLong:USER.a+" ".repeat(4096)};
/** Only the common steps ran: tenant lookup + rate limiter; no account lookup, no write. */
const commonOnly=(log:Array<{table?:string;rpc?:string}>)=>
 log.map(l=>l.table??"rpc:"+l.rpc);
async function captureConsole<T>(fn:()=>Promise<T>):Promise<{value:T;out:string[]}>{
 const out:string[]=[];const keys=["error","log","warn","info","debug"] as const;
 const old=keys.map(k=>console[k]);
 for(const k of keys)(console as any)[k]=(...a:unknown[])=>{out.push(a.map(x=>typeof x==="string"?x:JSON.stringify(x)).join(" "));};
 try{return {value:await fn(),out};}finally{keys.forEach((k,i)=>{(console as any)[k]=old[i];});}
}

test("authorized operator invokes EVERY protected action with the normal results",async()=>{
 const s=prodState();
 const results:Record<string,{status:number;body:any}>={};
 for(const body of PROTECTED(A.a))results[body.action]=await s.call(body,"jwt-a",ONLY_A);
 assert.equal(results.readiness.status,200);assert.equal(results.readiness.body.candidateRevision,null);
 assert.equal(results.catalog.status,200);
 assert.deepEqual(results.catalog.body.flows,[{flowKey:KEY,latestRevision:4}]);
 assert.deepEqual(results.read.body,{ok:true,revision:2,document:s.pubs[0].document});
 assert.equal(results.list.status,200);assert.deepEqual(results.list.body.items.map((i:any)=>i.revision),[4,3,2]);
 assert.deepEqual(results.publish.body,{ok:true,revision:5,activationChanged:false});
 assert.deepEqual(results.activate.body,{ok:true,active:true,revision:2});
 assert.deepEqual(results.rollback.body,{ok:true,active:true,revision:3});
 assert.deepEqual(s.acts.filter(a=>a.is_active).map(a=>a.revision),[3]);
 // Same answers with both owners listed (the default test env) and an uppercase entry.
 for(const env of [PROD_ENV,{...PROD_ENV,FLOW_OPERATOR_USER_IDS:" "+USER.a.toUpperCase()+" "}]){
  const r=await prodState().call({action:"catalog",accountId:A.a,flowKey:KEY},"jwt-a",env);
  assert.equal(r.status,200);assert.deepEqual(r.body.flows,[{flowKey:KEY,latestRevision:4}]);
 }
});

test("ordinary owner: identical 403 on every protected / unknown / missing action, no DB access beyond common steps",async()=>{
 const bodies=[...PROTECTED(A.b),...PROTECTED(A.a),
  {action:"frobnicate",accountId:A.b,flowKey:KEY},{accountId:A.b,flowKey:KEY},
  {action:42,accountId:A.b,flowKey:KEY},{action:null},{action:["readiness"],accountId:A.b,flowKey:KEY},
  {action:{toString:"readiness"}},{action:"Accounts"},{action:"readiness"},{}];
 for(const body of bodies){
  const s=server({pubs:[pub(T.b,A.b,KEY,1,v2Doc("B"))],acts:[act(T.b,A.b,KEY,1,true)]});
  const r=await s.call(body,"jwt-b",ONLY_A);
  assert.equal(r.status,403,JSON.stringify(body));
  assert.deepEqual(r.body,DENIED,JSON.stringify(body));
  assert.deepEqual(commonOnly(s.log),["tenants","rpc:flow_publication_rate_allow"],JSON.stringify(body));
  assert.equal(s.pubs.length,1);assert.equal(s.acts[0].is_active,true);
 }
});

test("401 stays 401: invalid token and missing Bearer, before any allowlist decision",async()=>{
 for(const body of [{action:"readiness",accountId:A.a,flowKey:KEY},{action:"accounts"},{action:"operator_status"}]){
  const s=prodState();
  const bad=await s.call(body,"jwt-invalid",ONLY_A);
  assert.deepEqual([bad.status,bad.body],[401,{ok:false,error:"Not authenticated"}]);
  const noBearer=await s.call(body,"jwt-a",ONLY_A,{authorization:"Basic abc"});
  assert.deepEqual([noBearer.status,noBearer.body],[401,{ok:false,error:"Not authenticated"}]);
  assert.deepEqual(s.log,[]);
 }
});

test("missing/empty/malformed/oversized list: operator actions 403 for everyone, customer actions still work",async()=>{
 for(const [name,raw] of Object.entries(INVALID_LISTS)){
  const env:Env={...PROD_ENV,FLOW_OPERATOR_USER_IDS:raw};
  const {out}=await captureConsole(async()=>{
   for(const body of PROTECTED(A.a)){
    const s=prodState();
    const r=await s.call(body,"jwt-a",env);
    assert.deepEqual([r.status,r.body],[403,DENIED],name+" "+body.action);
    assert.deepEqual(commonOnly(s.log),["tenants","rpc:flow_publication_rate_allow"]);
   }
   const s=server({pubs:[pub(T.a,A.a,KEY,2,v2Doc("A"))],acts:[act(T.a,A.a,KEY,2,true)]});
   const accounts=await s.call({action:"accounts"},"jwt-a",env);
   assert.equal(accounts.status,200,name);assert.deepEqual(accounts.body.accounts.map((a:any)=>a.id),[A.a,A.a2]);
   const caps=await s.call({action:"capabilities",accountId:A.a,flowKey:KEY},"jwt-a",env);
   assert.equal(caps.status,200,name);assert.equal(caps.body.ok,true);
   const live=await s.call({action:"publish_live",accountId:A.a,flowKey:KEY,document:v2Doc("LIVE")},"jwt-a",env);
   assert.deepEqual(live.body,{ok:true,status:"live",revision:3},name);
   const stop=await s.call({action:"deactivate",accountId:A.a,flowKey:KEY},"jwt-a",env);
   assert.deepEqual([stop.status,stop.body],[200,{ok:true,active:false}],name);
   const status=await s.call({action:"operator_status"},"jwt-a",env);
   assert.deepEqual([status.status,status.body],[200,{ok:true,operator:false}],name);
  });
  // Only the fixed code is ever logged, never ids/counts/raw values.
  assert.ok(out.length>0,name);
  for(const line of out)assert.equal(line,"[flow-publication] operator_allowlist_unavailable",name);
 }
});

test("deactivate: owner (not an operator) stops their own flow; never another tenant's",async()=>{
 const s=server({pubs:[pub(T.a,A.a,KEY,2,v2Doc("A")),pub(T.b,A.b,KEY,1,v2Doc("B"))],
  acts:[act(T.a,A.a,KEY,2,true),act(T.b,A.b,KEY,1,true)]});
 // Foreign account (tenant A's), even with a spoofed tenantId: existing 403, nothing changes.
 const foreign=await s.call({action:"deactivate",accountId:A.a,flowKey:KEY,tenantId:T.a},"jwt-b",ONLY_A);
 assert.deepEqual([foreign.status,foreign.body],[403,{ok:false,error:"Account not authorized"}]);
 assert.equal(s.mutations().length,0);
 assert.equal(s.acts[0].is_active,true);
 const own=await s.call({action:"deactivate",accountId:A.b,flowKey:KEY,tenantId:T.a},"jwt-b",ONLY_A);
 assert.deepEqual([own.status,own.body],[200,{ok:true,active:false}]);
 assert.deepEqual(s.mutations().map(m=>[m.rpc,m.args.p_tenant_id,m.args.p_account_id,m.args.p_actor_id]),
  [["flow_deactivate_revision",T.b,A.b,USER.b]]);
 assert.deepEqual(s.acts.map(a=>a.is_active),[true,false]);
});

test("operator_status: exactly {ok:true,operator:boolean}, no account needed",async()=>{
 const s=prodState();
 const yes=await s.call({action:"operator_status"},"jwt-a",ONLY_A);
 assert.equal(yes.status,200);assert.deepEqual(yes.body,{ok:true,operator:true});
 const no=await s.call({action:"operator_status",accountId:A.b,flowKey:KEY},"jwt-b",ONLY_A);
 assert.equal(no.status,200);assert.deepEqual(no.body,{ok:true,operator:false});
 const upper=await s.call({action:"operator_status"},"jwt-a",{...PROD_ENV,FLOW_OPERATOR_USER_IDS:USER.a.toUpperCase()});
 assert.deepEqual(upper.body,{ok:true,operator:true});
 const {value:invalid}=await captureConsole(()=>s.call({action:"operator_status"},"jwt-a",{...PROD_ENV,FLOW_OPERATOR_USER_IDS:USER.a+",bad"}));
 assert.deepEqual(invalid.body,{ok:true,operator:false});
 // Only tenant + rate limiter for each call; no account lookup.
 assert.ok(s.log.every(l=>l.table==="tenants"||l.rpc==="flow_publication_rate_allow"));
});

test("allowlist is re-read on every request (rotation without restart)",async()=>{
 const s=prodState();
 const body={action:"list",accountId:A.b,flowKey:KEY};
 assert.equal((await s.call(body,"jwt-b",ONLY_A)).status,403);
 assert.equal((await s.call(body,"jwt-b",{...PROD_ENV,FLOW_OPERATOR_USER_IDS:USER.a+","+USER.b})).status,200);
 assert.equal((await s.call(body,"jwt-b",ONLY_A)).status,403);
});

test("no identity spoofing: body ids, email, metadata and forwarded headers grant nothing",async()=>{
 const spoof={userId:USER.a,user_id:USER.a,actorId:USER.a,operator:true,isOperator:true,email:"op@example.test",
  user_metadata:{operator:true,role:"operator"},app_metadata:{role:"operator",operator:true},
  auth:{user:{id:USER.a}},FLOW_OPERATOR_USER_IDS:USER.b,tenantId:T.a};
 const headers={"x-forwarded-user":USER.a,"x-user-id":USER.a,"x-operator":"true",
  "x-forwarded-for":"127.0.0.1","x-supabase-user":USER.a,"x-flow-operator":USER.a};
 for(const body of [...PROTECTED(A.b),{action:"operator_status"}]){
  const s=prodState();
  const r=await s.call({...body,...spoof,action:body.action},"jwt-b",ONLY_A,headers);
  if(body.action==="operator_status")assert.deepEqual(r.body,{ok:true,operator:false});
  else assert.deepEqual([r.status,r.body],[403,DENIED],body.action);
  assert.equal(s.mutations().length,0);
 }
});

test("signed-in non-owner (tenant-staff style): existing 403 Tenant not authorized, even if listed",async()=>{
 for(const env of [ONLY_A,{...PROD_ENV,FLOW_OPERATOR_USER_IDS:STAFF_USER}])
  for(const body of [{action:"readiness",accountId:A.a,flowKey:KEY},{action:"accounts"},{action:"operator_status"},
   {action:"deactivate",accountId:A.a,flowKey:KEY}]){
   const s=prodState();
   const r=await s.call(body,"jwt-staff",env);
   assert.deepEqual([r.status,r.body],[403,{ok:false,error:"Tenant not authorized"}],body.action);
   assert.deepEqual(commonOnly(s.log),["tenants"]);
  }
});

test("operator gets no cross-tenant access: still scoped to their own tenant",async()=>{
 const s=server({pubs:[pub(T.b,A.b,KEY,1,v2Doc("B"))]});
 for(const body of PROTECTED(A.b)){
  const r=await s.call({...body,tenantId:T.b},"jwt-a",ONLY_A);
  assert.deepEqual([r.status,r.body],[403,{ok:false,error:"Account not authorized"}],body.action);
 }
 assert.equal(s.mutations().length,0);assert.equal(s.pubs.length,1);
});

test("no leak: bodies, headers and console never contain allowlist ids, the raw env value or user ids",async()=>{
 const raw=" "+USER.a.toUpperCase()+" , "+USER.b.slice(0,-1)+"0";
 const variants:Env[]=[ONLY_A,{...PROD_ENV,FLOW_OPERATOR_USER_IDS:raw},{...PROD_ENV,FLOW_OPERATOR_USER_IDS:undefined}];
 const texts:string[]=[];
 const {out}=await captureConsole(async()=>{
  for(const env of variants)for(const token of ["jwt-a","jwt-b","jwt-staff"])
   for(const body of [...PROTECTED(A.a),...PROTECTED(A.b),{action:"operator_status"},{action:"nope"},{}]){
    const r=await prodState().call(body,token,env);
    if(body.action==="read"&&r.status===200)continue; // returns the stored document only
    texts.push(JSON.stringify(r.body),JSON.stringify([...r.headers]));
   }
 });
 const secrets=[USER.a,USER.b,STAFF_USER,raw.trim(),USER.a.toUpperCase(),USER.b.slice(0,-1)+"0"].map(x=>x.toLowerCase());
 for(const t of [...texts,...out])for(const sec of secrets)
  assert.ok(!t.toLowerCase().includes(sec),"leak: "+t.slice(0,120));
 for(const line of out)assert.equal(line,"[flow-publication] operator_allowlist_unavailable");
});

test("source: operator gate after auth/tenant/rate limit, before account lookup; generic 403; no module cache",()=>{
 const src=readFileSync("supabase/functions/flow-publication/index.ts","utf8");
 const at=(s:string)=>{const i=src.indexOf(s);assert.ok(i>0,s);return i;};
 const order=[at("client.auth.getUser(rawBearer.slice(7))"),at('error("Tenant not authorized",403)'),
  at('"flow_publication_rate_allow"'),at("const customerAction=isCustomerAction(action);"),
  at('parseOperatorAllowlist(env("FLOW_OPERATOR_USER_IDS"))'),at('if(action==="operator_status")return respond({ok:true,operator});'),
  at('if(!operator)return error("Operator access required",403);'),at('if(request.action==="accounts")'),
  at("const accountId=request.accountId;"),at("const {data:account,error:accountError}")];
 assert.ok(order.every((x,i)=>i===0||x>order[i-1]),JSON.stringify(order));
 assert.equal(src.split('env("FLOW_OPERATOR_USER_IDS")').length,2,"read in exactly one place, inside the handler");
 assert.ok(src.indexOf('env("FLOW_OPERATOR_USER_IDS")')>at("export async function handleFlowPublication("));
 assert.equal(src.split('"Operator access required"').length,2);
 const lib=readFileSync("supabase/functions/flow-publication/operatorAuth.ts","utf8");
 assert.doesNotMatch(lib,/Deno\.|^import |console\./m);
 // Never shipped to the browser bundle.
 for(const f of ["src/flow/FlowPublicationPanel.tsx","src/flow/useFlowActivation.ts"])
  assert.doesNotMatch(readFileSync(f,"utf8"),/operatorAuth|FLOW_OPERATOR_USER_IDS/);
 assert.match(lib,/future separate design/);
});
