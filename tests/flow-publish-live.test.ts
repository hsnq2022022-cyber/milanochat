/**
 * flow-publication `publish_live`: validate (exactly as publish) -> derive
 * requirements -> activation gates on the prepared document -> create the
 * immutable revision -> activate THAT exact revision. Offline: the shared
 * fake client double, the real handleFlowPublication.
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {makeNode,edgeFor} from "../src/flow/model.ts";
import {evaluateActivationGates} from "../supabase/functions/flow-publication/activationGates.ts";
import {notLiveReason,NOT_LIVE_MESSAGES,savedNotLive} from "../supabase/functions/flow-publication/publishLive.ts";
import {v2Doc,buttonsDoc,malformedDoc,T,A,USER,KEY,pub,act,server,PROD_ENV,withEnv,type Env}
 from "./flowPublicationDouble.ts";

const live=(document:unknown,accountId=A.a)=>({action:"publish_live",accountId,flowKey:KEY,document});
const rpcs=(s:{log:Array<{rpc?:string}>})=>s.log.filter(l=>l.rpc&&l.rpc!=="flow_publication_rate_allow").map(l=>l.rpc);
/** Prepared by the server but never runnable: a number question (requirements: unsupported_block). */
function numberQuestionDoc(){
 const t=makeNode("trigger",{x:0,y:0},{platform:"instagram",triggerMode:"message",keywords:""});
 const q=makeNode("question",{x:0,y:200},{text:"n?",inputMode:"number",inputField:"n"});
 return {version:3,name:"n",nodes:[t,q],edges:[edgeFor({source:t.id,target:q.id,sourceHandle:"next",targetHandle:"in"} as any)]};
}
/** Editor-built durable graph (trigger -> one-minute delay -> text). */
function delayFlowDoc(){
 const t=makeNode("trigger",{x:0,y:0},{platform:"instagram",triggerMode:"message",keywords:""});
 const d=makeNode("delay",{x:0,y:100},{delayValue:1,delayUnit:"minutes"});
 const m=makeNode("message",{x:0,y:200},{text:"after"});
 return {version:3,name:"d",nodes:[t,d,m],edges:[edgeFor({source:t.id,target:d.id,sourceHandle:"next",targetHandle:"in"} as any),
  edgeFor({source:d.id,target:m.id,sourceHandle:"next",targetHandle:"in"} as any)]};
}
const facebookDoc=()=>{const d=v2Doc("FB");(d.nodes[0].data as any).platform="messenger";return d;};
const badKeywordDoc=()=>{const d=v2Doc("K");Object.assign(d.nodes[0].data,{triggerMode:"keyword",keywords:"x",operator:"nope"});return d;};

test("live: creates the revision, then activates exactly the returned revision",async()=>{
 const s=server({pubs:[pub(T.a,A.a,KEY,1,v2Doc("OLD")),pub(T.a,A.a,"other_flow",9,v2Doc("X"))],
  acts:[act(T.a,A.a,KEY,1,true)]});
 const r=await s.call(live(v2Doc("HI")));
 assert.equal(r.status,200);
 assert.deepEqual(r.body,{ok:true,status:"live",revision:2});
 assert.deepEqual(rpcs(s),["flow_publish_revision","flow_activate_revision"]);
 const publish=s.log.find(l=>l.rpc==="flow_publish_revision")!.args;
 assert.deepEqual({t:publish.p_tenant_id,a:publish.p_account_id,p:publish.p_platform,k:publish.p_flow_key,u:publish.p_actor_id},
  {t:T.a,a:A.a,p:"instagram",k:KEY,u:USER.a});
 const activate=s.log.find(l=>l.rpc==="flow_activate_revision")!.args;
 assert.deepEqual(activate,{p_tenant_id:T.a,p_account_id:A.a,p_platform:"instagram",p_flow_key:KEY,p_revision:2,p_actor_id:USER.a});
 // The RPC's own behavior replaces the previous active revision of this flow.
 assert.deepEqual(s.acts.filter(a=>a.flow_key===KEY).map(a=>[a.revision,a.is_active]),[[2,true]]);
 // The stored document is the prepared one that passed the gates.
 assert.equal(s.pubs.find(p=>p.flow_key===KEY&&p.revision===2)!.document,publish.p_document);
});

test("live: activates the exact returned revision, never the latest stored one",async()=>{
 const s=server({pubs:[pub(T.a,A.a,KEY,8,v2Doc("NEWER"))],
  publishRpc:(args)=>{s.pubs.push(pub(args.p_tenant_id,args.p_account_id,args.p_flow_key,5,args.p_document));return {data:5,error:null};}});
 const r=await s.call(live(v2Doc("HI")));
 assert.deepEqual(r.body,{ok:true,status:"live",revision:5});
 assert.equal(s.log.find(l=>l.rpc==="flow_activate_revision")!.args.p_revision,5);
 assert.ok(!s.log.some(l=>l.table==="automation_flow_publications"),"no stored-revision lookup");
});

test("gates run before the revision is created",async()=>{
 const s=server({});
 await s.call(live(v2Doc("HI")));
 const gateRead=s.log.findIndex(l=>l.table==="automation_flow_global_switch");
 const publish=s.log.findIndex(l=>l.rpc==="flow_publish_revision");
 const activate=s.log.findIndex(l=>l.rpc==="flow_activate_revision");
 assert.ok(gateRead>0&&publish>gateRead&&activate>publish,JSON.stringify(s.log.map(l=>l.table??l.rpc)));
});

test("gate blocked: saved_not_live with the saved revision, no activation RPC",async()=>{
 const cases:Array<{name:string;s:ReturnType<typeof server>;env?:Env;doc?:unknown;reason:string}>=[
  {name:"switch off",s:server({tenantSwitch:{enabled:false,production_approved:true}}),env:{},reason:"not_enabled"},
  {name:"paused",s:server({accountPatch:{[A.a]:{auto_reply:false}}}),reason:"account_paused"},
  {name:"switches unreadable",s:server({failTables:["automation_flow_global_switch"]}),reason:"unavailable"},
  {name:"advanced not enabled",s:server({}),env:{},doc:delayFlowDoc(),reason:"not_enabled"},
  {name:"scope required",s:server({}),env:{...PROD_ENV,FLOW_MESSAGE_SCOPE_REQUIRED:"true"},reason:"settings_incomplete"},
  {name:"unsupported block",s:server({}),doc:numberQuestionDoc(),reason:"unsupported_feature"},
 ];
 for(const c of cases){
  const r=await c.s.call(live(c.doc??v2Doc("HI")),"jwt-a",c.env??PROD_ENV);
  assert.equal(r.status,200,c.name);
  assert.deepEqual(r.body,{ok:true,status:"saved_not_live",revision:1,reason:c.reason,
   message:(NOT_LIVE_MESSAGES as any)[c.reason]},c.name);
  assert.deepEqual(rpcs(c.s),["flow_publish_revision"],c.name);
  assert.equal(c.s.pubs.filter(p=>p.flow_key===KEY).length,1,c.name);
  assert.deepEqual(c.s.acts,[],c.name);
 }
});

test("unsupported blocks never go live even when every flag is on",async()=>{
 const s=server({});
 const r=await s.call(live(numberQuestionDoc()),"jwt-a",{...PROD_ENV,FLOW_INTERNAL_ACTIONS_ENABLED:"true"});
 assert.equal(r.body.status,"saved_not_live");assert.equal(r.body.reason,"unsupported_feature");
 assert.ok(!s.log.some(l=>l.rpc==="flow_activate_revision"));
});

test("activation not confirmed: saved_not_live with that exact saved revision",async()=>{
 const results:Array<[string,(a:any)=>any,string]>=[
  ["false",()=>({data:false,error:null}),"switch_off"],
  ["null",()=>({data:null,error:null}),"switch_off"],
  ["db error",()=>({data:null,error:{code:"XX000",message:"internal detail"}}),"unavailable"],
  ["throws",()=>{throw Error("internal detail");},"unavailable"],
 ];
 for(const [name,activateRpc,reason] of results){
  const s=server({pubs:[pub(T.a,A.a,KEY,3,v2Doc("OLD"))],activateRpc});
  const r=await s.call(live(v2Doc("HI")));
  assert.equal(r.status,200,name);
  assert.deepEqual(r.body,savedNotLive(4,reason as any),name);
  assert.equal(s.log.find(l=>l.rpc==="flow_activate_revision")!.args.p_revision,4,name);
  assert.ok(s.pubs.some(p=>p.flow_key===KEY&&p.revision===4),name);
 }
});

test("revision creation fails: publish's errors, nothing activated, never claims saved",async()=>{
 const cases:Array<[(a:any)=>any,number,string]>=[
  [()=>({data:null,error:{code:"XX000"}}),503,"Flow publish is unavailable"],
  [()=>({data:0,error:null}),403,"Publishing was rejected"],
  [()=>({data:1.5,error:null}),403,"Publishing was rejected"],
  [()=>({data:null,error:null}),403,"Publishing was rejected"],
 ];
 for(const [publishRpc,status,message] of cases){
  for(const action of ["publish","publish_live"]){
   const s=server({publishRpc});
   const r=await s.call({...live(v2Doc("HI")),action});
   assert.equal(r.status,status,action);
   assert.deepEqual(r.body,{ok:false,error:message},action);
   assert.ok(!s.log.some(l=>l.rpc==="flow_activate_revision"),action);
   assert.deepEqual(s.acts,[]);
  }
 }
});

test("invalid documents: same 4xx as publish, nothing created, gates not evaluated",async()=>{
 const docs:Record<string,unknown>={malformed:malformedDoc,missing:undefined,array:[],facebook:facebookDoc(),
  badKeyword:badKeywordDoc(),
  notImmediate:(()=>{const d=v2Doc("S");(d.nodes[0].data as any).messageScope="bogus";return d;})()};
 for(const [name,doc] of Object.entries(docs)){
  const a=server({}),b=server({});
  const pl=await a.call(live(doc));
  const p=await b.call({...live(doc),action:"publish"});
  assert.equal(pl.status,422,name);
  assert.deepEqual([pl.status,pl.body],[p.status,p.body],name);
  assert.deepEqual(rpcs(a),[],name);
  assert.ok(!a.log.some(l=>l.table?.startsWith("automation_flow")),name+": no gate reads");
  assert.deepEqual(a.pubs,[]);
 }
});

test("isolation: foreign/other-tenant accounts rejected, nothing written; scope never from the body",async()=>{
 const s=server({});
 assert.equal((await s.call(live(v2Doc("HI"),A.b),"jwt-a")).status,403);
 assert.equal((await s.call(live(v2Doc("HI"),A.a),"jwt-b")).status,403);
 assert.equal((await s.call(live(v2Doc("HI"),"not-a-uuid"),"jwt-a")).status,400);
 assert.equal((await s.call({...live(v2Doc("HI")),flowKey:"../x"},"jwt-a")).status,400);
 assert.deepEqual(rpcs(s),[]);assert.deepEqual(s.pubs,[]);assert.deepEqual(s.acts,[]);
 // Disabled account: publish's 403, nothing saved.
 const off=server({accountPatch:{[A.a]:{is_active:false}}});
 const r=await off.call(live(v2Doc("HI")));
 assert.deepEqual([r.status,r.body],[403,{ok:false,error:"Account is disabled"}]);
 assert.deepEqual(rpcs(off),[]);
 // Tenant B on its own account: every write is scoped to tenant B, whatever the body says.
 const b=await s.call({...live(v2Doc("HI"),A.b),tenantId:T.a,platform:"facebook"},"jwt-b");
 assert.equal(b.status,200);
 for(const l of s.log.filter(l=>l.rpc==="flow_publish_revision"||l.rpc==="flow_activate_revision"))
  assert.deepEqual([l.args.p_tenant_id,l.args.p_account_id,l.args.p_platform,l.args.p_actor_id],[T.b,A.b,"instagram",USER.b]);
 assert.ok(s.pubs.every(p=>p.tenant===T.b));
});

test("customer fields never carry internal strings",async()=>{
 const env:Env={...PROD_ENV,FLOW_MESSAGE_SCOPE_REQUIRED:"true",FIELD_ENCRYPTION_KEY:"enc-SECRET-value-123"};
 const bodies:any[]=[];
 bodies.push((await server({}).call(live(v2Doc("HI")),"jwt-a",env)).body);
 bodies.push((await server({}).call(live(delayFlowDoc(),A.a2),"jwt-a",env)).body);
 bodies.push((await server({}).call(live(numberQuestionDoc()))).body);
 bodies.push((await server({tenantSwitch:null}).call(live(v2Doc("HI")))).body);
 bodies.push((await server({activateRpc:()=>({data:null,error:{code:"P0001",message:"flow_activate_revision boom"}})}).call(live(v2Doc("HI")))).body);
 bodies.push((await server({accountPatch:{[A.a]:{agent_enabled:false}}}).call(live(v2Doc("HI")))).body);
 for(const body of bodies){
  assert.equal(body.status,"saved_not_live",JSON.stringify(body));
  assert.deepEqual(Object.keys(body).sort(),["message","ok","reason","revision","status"]);
  assert.match(body.reason,/^[a-z_]+$/);
  assert.ok(body.message.length<90&&/[؀-ۿ]/.test(body.message)&&!/[A-Za-z0-9]/.test(body.message),body.message);
  const text=JSON.stringify(body);
  for(const [k,v] of Object.entries(env)){assert.ok(!text.includes(k),k);if(v&&v!=="true")assert.ok(!text.includes(v),k);}
  for(const bad of [/FLOW_/,/durable/i,/simple/i,/\bV[234]\b/,/engine/i,/canary/i,/operator/i,/readiness/i,/unsupported runtime/i,
   /Publication activation/i,/boom/,/P0001/,T.a,T.b,A.a,A.a2,USER.a,KEY])
   assert.ok(typeof bad==="string"?!text.includes(bad):!bad.test(text),String(bad)+" in "+text);
 }
 assert.deepEqual([...new Set(bodies.map(b=>b.reason))].sort(),
  ["account_paused","not_enabled","settings_incomplete","unavailable","unsupported_feature"]);
 for(const m of Object.values(NOT_LIVE_MESSAGES))assert.ok(!/[A-Za-z0-9]/.test(m)&&m.length<90,m);
});

test("notLiveReason: one pure mapping, unknown -> not_live_unknown",()=>{
 const g=(status:number,code?:string)=>({ok:false as const,status,body:{ok:false as const,error:"x",...(code?{code}:{})}});
 assert.equal(notLiveReason(g(403),false),"account_paused");
 assert.equal(notLiveReason(g(423),false),"not_enabled");
 assert.equal(notLiveReason(g(503),false),"unavailable");
 assert.equal(notLiveReason(g(422),false),"not_enabled");
 assert.equal(notLiveReason(g(422,"FLOW_MESSAGE_SCOPE_REQUIRED"),false),"settings_incomplete");
 assert.equal(notLiveReason(g(404),false),"not_live_unknown");
 assert.equal(notLiveReason(g(500),false),"not_live_unknown");
 assert.equal(notLiveReason(null,false),"not_live_unknown");
 for(const s of [403,422,423,503])assert.equal(notLiveReason(g(s),true),"unsupported_feature");
 assert.deepEqual(savedNotLive(3,"not_live_unknown"),{ok:true,status:"saved_not_live",revision:3,
  reason:"not_live_unknown",message:NOT_LIVE_MESSAGES.not_live_unknown});
});

test("publish and activate responses unchanged",async()=>{
 const s=server({});
 const p=await s.call({action:"publish",accountId:A.a,flowKey:KEY,document:v2Doc("HI")});
 assert.deepEqual([p.status,p.body],[200,{ok:true,revision:1,activationChanged:false}]);
 assert.deepEqual(rpcs(s),["flow_publish_revision"]);
 assert.ok(!s.log.some(l=>l.table==="automation_flow_global_switch"),"publish evaluates no gates");
 const a=await s.call({action:"activate",accountId:A.a,flowKey:KEY,revision:1});
 assert.deepEqual([a.status,a.body],[200,{ok:true,active:true,revision:1}]);
 const missing=await s.call({action:"activate",accountId:A.a,flowKey:KEY,revision:2});
 assert.deepEqual([missing.status,missing.body],[404,{ok:false,error:"Publication revision not found"}]);
 const off=await server({pubs:[pub(T.a,A.a,KEY,1,v2Doc("HI"))],tenantSwitch:{enabled:false,production_approved:true}})
  .call({action:"activate",accountId:A.a,flowKey:KEY,revision:1},"jwt-a",{});
 assert.deepEqual([off.status,off.body],[423,{ok:false,error:"Publication activation is disabled"}]);
 const denied=await server({pubs:[pub(T.a,A.a,KEY,1,v2Doc("HI"))],activateRpc:()=>({data:false,error:null})})
  .call({action:"activate",accountId:A.a,flowKey:KEY,revision:1});
 assert.deepEqual([denied.status,denied.body],[423,{ok:false,error:"Global/tenant switch is OFF"}]);
});

test("evaluateActivationGates: without `document` reads the stored revision exactly as before; with it, no lookup and the same decision",async()=>{
 const docs=[v2Doc("HI"),buttonsDoc,delayFlowDoc(),numberQuestionDoc()];
 const envs:Env[]=[PROD_ENV,{},{...PROD_ENV,FLOW_MESSAGE_SCOPE_REQUIRED:"true"}];
 for(const doc of docs)for(const env of envs){
  const log:Array<Record<string,unknown>>=[];
  const client={from:(table:string)=>{
   const f:Record<string,unknown>={};
   const q:any={select:()=>q,eq:(k:string,v:unknown)=>{f[k]=v;return q;},maybeSingle:async()=>{
    log.push({table,...f});
    if(table==="automation_flow_global_switch")return {data:{enabled:true},error:null};
    if(table==="automation_flow_tenant_switches")return {data:{enabled:true,production_approved:true},error:null};
    if(table==="automation_flow_publications")return {data:f.revision===1?{document:doc}:null,error:null};
    return {data:null,error:null};}};
   return q;}};
  const common={client,env:(k:string)=>env[k]??"",commentSwitches:()=>({commentAutomationEnabled:false,multichannelEnabled:false}),
   scope:{tenantId:T.a,accountId:A.a,platform:"instagram" as const},tenant:{is_active:true},
   account:{is_active:true,agent_enabled:true,auto_reply:true},flowKey:KEY,action:"activate" as const};
  const stored=await evaluateActivationGates({...common,rev:1});
  const lookup=log.filter(l=>l.table==="automation_flow_publications");
  assert.deepEqual(lookup,[{table:"automation_flow_publications",tenant_id:T.a,channel_account_id:A.a,platform:"instagram",flow_key:KEY,revision:1}]);
  log.length=0;
  const given=await evaluateActivationGates({...common,document:doc});
  assert.ok(!log.some(l=>l.table==="automation_flow_publications"));
  assert.deepEqual(given,stored,JSON.stringify(env));
  assert.deepEqual(await evaluateActivationGates({...common,rev:2}),
   {ok:false,status:404,body:{ok:false,error:"Publication revision not found"}});
 }
 // Lookup error stays 503.
 const failing={from:(table:string)=>{const q:any={select:()=>q,eq:()=>q,maybeSingle:async()=>table==="automation_flow_publications"?
  {data:null,error:{code:"XX000"}}:{data:{enabled:true,production_approved:true},error:null}};return q;}};
 assert.deepEqual(await withEnv({},()=>evaluateActivationGates({client:failing,env:()=>"",
  commentSwitches:()=>({commentAutomationEnabled:false,multichannelEnabled:false}),
  scope:{tenantId:T.a,accountId:A.a,platform:"instagram"},tenant:{is_active:true},
  account:{is_active:true,agent_enabled:true,auto_reply:true},flowKey:KEY,rev:1,action:"activate"})),
  {ok:false,status:503,body:{ok:false,error:"Publication lookup unavailable"}});
});

test("source: publish_live evaluates gates before its only publish/activate calls and activates `revision`",()=>{
 const src=readFileSync("supabase/functions/flow-publication/index.ts","utf8");
 const start=src.indexOf('if(action==="publish_live")');
 const branch=src.slice(start,src.indexOf('if(action==="list")',start));
 const order=["validatePublishDocument(","deriveRequirements(doc,scope.platform)","await evaluateActivationGates({",
  "await createRevision(",'client.rpc("flow_activate_revision"'].map(x=>branch.indexOf(x));
 assert.ok(order.every((x,i)=>x>0&&(i===0||x>order[i-1])),JSON.stringify(order));
 assert.match(branch,/document:doc,action:"activate"\}\)/);
 assert.match(branch,/p_revision:revision,/);
 assert.doesNotMatch(branch,/automation_flow_publications|\.order\(|latest/i);
});
