/**
 * flow-publication `capabilities` action + pure capabilityAvailability:
 * tenant/account scoping, exact gate outcomes (canary account vs non-canary vs
 * flags off), fail-closed reads, no env names/values in the response, no
 * mutation, and PARITY with the real activate action: a document activates
 * exactly when deriveRequirements(document, platform, capabilities) reports
 * nothing unavailable.
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {deriveRequirements,CAPABILITIES} from "../src/flow/requirements.ts";
import {capabilityAvailability,capabilitiesUnavailable} from "../supabase/functions/flow-publication/capabilities.ts";
import {v2Doc,T,A,KEY,pub,server,PROD_ENV,type Env} from "./flowPublicationDouble.ts";

const IMG="https://localhost:54321/storage/v1/object/public/flow-media/u1/a.webp";
const ALL_ON:Env={...PROD_ENV,FLOW_INTERNAL_ACTIONS_ENABLED:"true",FLOW_MEDIA_SEND_ENABLED:"true",
 FLOW_ACTIVATION_CAPABILITIES:"message:image",FLOW_AI_STEP_ENABLED:"true",FLOW_RAG_ENABLED:"true",
 FLOW_COMMENT_AUTOMATION_ENABLED:"true",FLOW_MULTICHANNEL_ENABLED:"true"};
const avail=(r:any)=>Object.fromEntries(Object.entries(r.body.capabilities).map(([k,v]:any)=>[k,v.available?"ok":v.reason]));

// ---------------------------------------------------------------- documents
const msg=(o:Record<string,unknown>={})=>({kind:"message",text:"Hello",image:"",options:[],contentBlocks:[],...o});
const trig=(mode="message",extra={})=>({kind:"trigger",platform:"instagram",triggerMode:mode,keywords:"",...extra});
const line=(...datas:Array<Record<string,unknown>>)=>{
 const nodes=[{id:"t",data:trig()},...datas.map((d,i)=>({id:"n"+i,data:d})),{id:"e",data:{kind:"end"}}];
 const edges=nodes.slice(0,-1).map((n,i)=>({source:n.id,target:nodes[i+1].id,sourceHandle:"next"}));
 return {version:3,name:"x",nodes,edges};
};
const DOCS:Record<string,unknown>={
 simple:v2Doc("HI"),
 textChain:line(msg(),msg({text:"Again"})),
 website:line(msg({platform:"instagram",text:"Visit",options:[{id:"w",label:"Site",action:"website",buttonType:"button",url:"https://example.com/x"}]})),
 delay:line({kind:"delay",delayValue:1,delayUnit:"minutes"},msg()),
 typed:{version:3,name:"q",nodes:[{id:"t",data:trig()},{id:"q",data:{kind:"question",text:"Email?",image:"",contentBlocks:[],inputMode:"email",inputField:"mail",options:[]}},{id:"e",data:{kind:"end"}}],
  edges:[{source:"t",target:"q",sourceHandle:"next"},{source:"q",target:"e",sourceHandle:"valid"}]},
 variables:line({kind:"action",actionType:"set_field",actionValue:"color=red"},msg()),
 tag:line({kind:"action",actionType:"tag",actionValue:"vip"},msg()),
 ai:line({kind:"action",actionType:"ai",actionValue:""}),
 image:line(msg({text:"Pic",contentBlocks:[{id:"b",type:"image",url:IMG}]})),
 buttons:{version:3,name:"b",nodes:[{id:"t",data:trig()},{id:"m",data:msg({options:[{id:"o1",label:"A"},{id:"o2",label:"B"}]})},
  {id:"x",data:{kind:"end"}},{id:"y",data:{kind:"end"}}],
  edges:[{source:"t",target:"m",sourceHandle:"next"},{source:"m",target:"x",sourceHandle:"o1"},{source:"m",target:"y",sourceHandle:"o2"}]},
 comment:{version:3,name:"c",nodes:[{id:"t",data:trig("comment",{commentScope:"all",commentPostId:"",commentMatchType:"any",publicReplyText:"See DM"})},
  {id:"m",data:msg({text:"Link"})}],edges:[{source:"t",target:"m"}]},
 request:line({kind:"request",requestMethod:"GET",requestUrl:"https://example.com"}),
};

test("capabilities: canary account with every flag on -> all supported blocks available; non-canary -> basic only",async()=>{
 const s=server({});
 const r=await s.call({action:"capabilities",accountId:A.a,flowKey:"default"},"jwt-a",ALL_ON);
 assert.equal(r.status,200);assert.equal(r.body.ok,true);assert.equal(r.body.platform,"instagram");
 assert.deepEqual(Object.keys(r.body.capabilities).sort(),[...CAPABILITIES].sort());
 const a=avail(r);
 for(const c of CAPABILITIES)assert.equal(a[c],c==="unsupported_block"?"not_supported":"ok",c);
 assert.deepEqual(r.body.canPublish,{basic:true,advanced:true,comments:true});
 const other=avail(await s.call({action:"capabilities",accountId:A.a2,flowKey:"default"},"jwt-a",ALL_ON));
 for(const c of ["trigger_message","keyword_trigger","message_scope","text","conditions"])assert.equal(other[c],"ok",c);
 for(const c of ["delay","buttons","website_buttons","internal_actions","media_image","ai_step","typed_question","variables","randomizer","goto","multi_step","comment_trigger"])
  assert.equal(other[c],"advanced_not_enabled",c);
});

test("capabilities: exact per-flag reasons, approvals, paused account, channels",async()=>{
 const s=server({});
 const prod=avail(await s.call({action:"capabilities",accountId:A.a,flowKey:"default"},"jwt-a",PROD_ENV));
 assert.equal(prod.delay,"ok");assert.equal(prod.buttons,"ok");assert.equal(prod.website_buttons,"ok");
 assert.equal(prod.internal_actions,"internal_actions_not_enabled");assert.equal(prod.media_image,"media_not_enabled");
 assert.equal(prod.ai_step,"ai_not_enabled");assert.equal(prod.comment_trigger,"comments_not_enabled");
 const noSched=avail(await s.call({action:"capabilities",accountId:A.a,flowKey:"default"},"jwt-a",{...PROD_ENV,FLOW_DURABLE_SCHEDULER_ENABLED:"false"}));
 assert.equal(noSched.delay,"delay_not_enabled");assert.equal(noSched.buttons,"ok");
 const noButtons=avail(await s.call({action:"capabilities",accountId:A.a,flowKey:"default"},"jwt-a",{...PROD_ENV,FLOW_RICH_BUTTONS_ENABLED:undefined}));
 assert.equal(noButtons.buttons,"buttons_not_enabled");assert.equal(noButtons.website_buttons,"buttons_not_enabled");
 const off=avail(await s.call({action:"capabilities",accountId:A.a,flowKey:"default"},"jwt-a",{}));
 assert.equal(off.text,"ok");assert.equal(off.delay,"advanced_not_enabled");assert.equal(off.comment_trigger,"comments_not_enabled");
 // media needs BOTH the capability set and the send flag
 const halfMedia=avail(await s.call({action:"capabilities",accountId:A.a,flowKey:"default"},"jwt-a",{...PROD_ENV,FLOW_MEDIA_SEND_ENABLED:"true"}));
 assert.equal(halfMedia.media_image,"media_not_enabled");
 const notApproved=server({tenantSwitch:{enabled:true,production_approved:false}});
 const na=avail(await notApproved.call({action:"capabilities",accountId:A.a,flowKey:"default"},"jwt-a",ALL_ON));
 for(const c of CAPABILITIES)assert.equal(na[c],c==="unsupported_block"?"not_supported":"account_not_approved",c);
 const noGlobal=avail(await server({globalSwitch:null}).call({action:"capabilities",accountId:A.a,flowKey:"default"},"jwt-a",ALL_ON));
 assert.equal(noGlobal.text,"account_not_approved");
 const paused=avail(await server({accountPatch:{[A.a]:{auto_reply:false}}}).call({action:"capabilities",accountId:A.a,flowKey:"default"},"jwt-a",ALL_ON));
 assert.equal(paused.text,"account_paused");assert.equal(paused.delay,"account_paused");
 // Facebook Page: DM flows never production-authorized; comments only with both flags.
 const fbReg=[{tenant_id:T.a,channel_account_id:A.a2,platform:"facebook"}]; // operator registry row (PK tenant+platform)
 const fb=server({accountPatch:{[A.a2]:{platform:"facebook"}},registry:fbReg});
 const f1=avail(await fb.call({action:"capabilities",accountId:A.a2,flowKey:"default"},"jwt-a",ALL_ON));
 assert.equal(f1.text,"channel_not_supported");assert.equal(f1.delay,"channel_not_supported");
 assert.equal(f1.comment_trigger,"advanced_not_enabled","non-canary account");
 const f2=avail(await fb.call({action:"capabilities",accountId:A.a2,flowKey:"default"},"jwt-a",{...ALL_ON,FLOW_DURABLE_CANARY_ACCOUNT_ID:A.a2}));
 assert.equal(f2.comment_trigger,"ok");
 const f3=avail(await fb.call({action:"capabilities",accountId:A.a2,flowKey:"default"},"jwt-a",{...ALL_ON,FLOW_DURABLE_CANARY_ACCOUNT_ID:A.a2,FLOW_MULTICHANNEL_ENABLED:undefined}));
 assert.equal(f3.comment_trigger,"comments_not_enabled");
 const wa=avail(await server({accountPatch:{[A.a2]:{platform:"whatsapp"}},registry:[{tenant_id:T.a,channel_account_id:A.a2,platform:"whatsapp"}]}).call({action:"capabilities",accountId:A.a2,flowKey:"default"},"jwt-a",{...ALL_ON,FLOW_DURABLE_CANARY_ACCOUNT_ID:A.a2}));
 assert.equal(wa.comment_trigger,"channel_not_supported");assert.equal(wa.text,"channel_not_supported");
});

test("capabilities: scoping, fail-closed reads, no env names/values, no mutation",async()=>{
 const s=server({});
 // Foreign account (tenant B's) from tenant A's session, and vice versa.
 assert.equal((await s.call({action:"capabilities",accountId:A.b,flowKey:"default"},"jwt-a",ALL_ON)).status,403);
 assert.equal((await s.call({action:"capabilities",accountId:A.a,flowKey:"default"},"jwt-b",ALL_ON)).status,403);
 assert.equal((await s.call({action:"capabilities",accountId:"not-a-uuid",flowKey:"default"},"jwt-a",ALL_ON)).status,400);
 // Tenant B's own canary-less account: its own result only.
 const b=await s.call({action:"capabilities",accountId:A.b,flowKey:"default",tenantId:T.a},"jwt-b",ALL_ON);
 assert.equal(b.status,200);assert.equal(b.body.capabilities.delay.reason,"advanced_not_enabled");
 for(const l of s.log.filter(l=>l.table==="automation_flow_tenant_switches"))assert.ok([T.a,T.b].includes(l.filters!.tenant_id as string));
 const bReads=s.log.slice(-6).filter(l=>l.filters&&"tenant_id" in l.filters&&l.table!=="channel_accounts");
 for(const l of bReads)assert.equal(l.filters!.tenant_id,T.b);
 // Read errors -> 503, nothing available.
 for(const t of ["automation_flow_global_switch","automation_flow_tenant_switches"]){
  const r=await server({failTables:[t]}).call({action:"capabilities",accountId:A.a,flowKey:"default"},"jwt-a",ALL_ON);
  assert.equal(r.status,503,t);assert.deepEqual(r.body,{ok:false,error:"Capabilities unavailable"});
 }
 // Serialized response: booleans and reason codes only.
 const env={...ALL_ON,FIELD_ENCRYPTION_KEY:"enc-SECRET-value-123",FLOW_WORKERS_OPERATOR_RELEASE:"production-canary-approved"};
 const r=await s.call({action:"capabilities",accountId:A.a,flowKey:"default"},"jwt-a",env);
 const text=JSON.stringify(r.body);
 for(const [k,v] of Object.entries(env)){
  assert.ok(!text.includes(k),"env name "+k);
  if(v&&v!=="true"&&v!=="false")assert.ok(!text.includes(v),"env value of "+k);
 }
 assert.ok(!text.includes(A.a)&&!text.includes(T.a)&&!text.includes("canary")&&!text.includes("operator"));
 for(const v of Object.values(r.body.capabilities) as any[])
  assert.ok(typeof v.available==="boolean"&&(v.reason===null||/^[a-z_]+$/.test(v.reason)));
 assert.equal(s.log.filter(l=>l.rpc&&l.rpc!=="flow_publication_rate_allow").length,0,"no mutation");
 assert.deepEqual(s.acts,[]);
 // Pure helper fails closed too.
 const u=capabilitiesUnavailable();
 assert.ok(Object.values(u.capabilities).every(e=>e.available===false));
 assert.deepEqual(capabilityAvailability({platform:"instagram"} as any).capabilities.text,{available:false,reason:"account_paused"});
 const src=readFileSync("supabase/functions/flow-publication/index.ts","utf8");
 const body=src.slice(src.indexOf('if(action==="capabilities")'),src.indexOf('if(action==="readiness")'));
 assert.doesNotMatch(body,/\.insert\(|\.update\(|\.delete\(|\.rpc\(/);
});

test("PARITY with the activate action: activates iff nothing required is unavailable",async()=>{
 const envs:Record<string,Env>={ALL_ON,PROD_ENV,noSched:{...PROD_ENV,FLOW_DURABLE_SCHEDULER_ENABLED:undefined},
  noButtons:{...ALL_ON,FLOW_RICH_BUTTONS_ENABLED:undefined},noInternal:{...ALL_ON,FLOW_INTERNAL_ACTIONS_ENABLED:undefined},
  noMedia:{...ALL_ON,FLOW_MEDIA_SEND_ENABLED:undefined},noAi:{...ALL_ON,FLOW_RAG_ENABLED:undefined},
  noComments:{...ALL_ON,FLOW_COMMENT_AUTOMATION_ENABLED:undefined},otherCanary:{...ALL_ON,FLOW_DURABLE_CANARY_ACCOUNT_ID:A.b},
  off:{}};
 let checked=0,activated=0;
 for(const [envName,env] of Object.entries(envs))for(const [docName,doc] of Object.entries(DOCS)){
  const s=server({pubs:[pub(T.a,A.a,KEY,1,doc)]});
  const caps=(await s.call({action:"capabilities",accountId:A.a,flowKey:KEY},"jwt-a",env)).body.capabilities;
  const derived=deriveRequirements(doc,"instagram",caps);
  const r=await s.call({action:"activate",accountId:A.a,flowKey:KEY,revision:1},"jwt-a",env);
  const tag=envName+"/"+docName+" "+JSON.stringify(derived.unavailable)+" -> "+r.status;
  assert.equal(r.status===200,derived.unavailable!.length===0,tag);
  checked++;if(r.status===200)activated++;
 }
 assert.ok(checked===Object.keys(envs).length*Object.keys(DOCS).length&&activated>=20&&checked-activated>=40,checked+"/"+activated);
});
