import {test} from "node:test";
import assert from "node:assert/strict";
import {register} from "node:module";
import {readFileSync} from "node:fs";
import {makeNode,edgeFor} from "../src/flow/model.ts";
import type {FlowDocument} from "../src/flow/model.ts";
import {matchInboundEvent,normalizeTriggerText as clientNormalize,
 parseTriggerKeywords as clientParse,keywordMatchesText as clientMatchesText,
 keywordMatchMode as clientMode} from "../src/flow/eventRouting.ts";
import {normalizeTriggerText,parseTriggerKeywords,matchesKeywordTrigger,
 keywordTriggerProblem,documentKeywordTriggerProblem,dmTriggerAcceptsText,documentTriggerData,
 keywordMatchesText,keywordMatchMode}
 from "../supabase/functions/milan-api/triggerKeywords.ts";
import {simpleMessageFromDocument,simpleFlowDocumentSupported,prepareSimpleFlowReply}
 from "../supabase/functions/milan-api/flowPrepareMessage.ts";
import {supportedDurableDocument,durableCandidateKind,attemptDurableInstagram}
 from "../supabase/functions/milan-api/flowDurableIngress.ts";
import {processExclusiveEvent} from "../supabase/functions/milan-api/exclusiveMessageClaim.ts";

// flow-publication/index.ts value-imports "npm:@supabase/supabase-js@2"
// (createClient, never called here: a fake clientFactory is injected). Map the
// Deno npm: specifier to the installed package for Node only.
register("data:text/javascript,"+encodeURIComponent(
 "export async function resolve(s,c,n){return s.startsWith('npm:@supabase/supabase-js')?"+
 "n('@supabase/supabase-js',c):n(s,c);}"),import.meta.url);
const {handleFlowPublication,withKeywordTrigger}=await import("../supabase/functions/flow-publication/index.ts");

// ---------------------------------------------------------------- env shim
type Env=Record<string,string|undefined>;
async function withEnv<T>(env:Env,fn:()=>Promise<T>|T):Promise<T>{
 const old=(globalThis as any).Deno;
 (globalThis as any).Deno={env:{get:(k:string)=>env[k]}};
 try{return await fn();}finally{(globalThis as any).Deno=old;}
}

// ======================================================= B1: pure matcher
// Keyword values below are TEST DATA only; nothing in the code knows them.
test("matcher contains: whole token / phrase, never a substring of another word",()=>{
 const m=(text:unknown,keywords:unknown="TOD",operator?:unknown)=>
  matchesKeywordTrigger({keywords,operator,text});
 for(const t of ["TOD","tod","Tod","TOD 5","  tod  ","I want TOD please","(TOD)","tod!","tod?","5-tod","«tod»","tod.","x/tod/y"])
  assert.equal(m(t),true,t);
 for(const t of ["today","tods","atod","to d","hello","tod5","5tod","todé","تtod"])assert.equal(m(t),false,t);
 // phrases: contiguous normalized sequence, whitespace collapsed
 assert.equal(m("I want   the  PRICE list now","price list"),true);
 assert.equal(m("price-list","price list"),false,"a hyphen is not whitespace inside a phrase");
 assert.equal(m("price lists","price list"),false);
 assert.equal(m("the price\nlist","price list"),true);
 // later occurrence with boundaries still counts
 assert.equal(m("today and tod","tod"),true);
});
test("matcher exact: the whole normalized message equals a keyword or phrase",()=>{
 const m=(text:unknown,keywords:unknown="TOD")=>matchesKeywordTrigger({keywords,operator:"exact",text});
 for(const t of ["TOD","tod","  Tod  ","ＴＯＤ"])assert.equal(m(t),true,t);
 for(const t of ["TOD 5","(TOD)","tod!","today","I want TOD"])assert.equal(m(t),false,t);
 assert.equal(m("Price   List","price list, x"),true);
 assert.equal(m("x","price list, x"),true);
});
test("match mode: legacy operator values map to contains; unknown values never match",()=>{
 const m=(operator:unknown,text="TOD 5")=>matchesKeywordTrigger({keywords:"TOD",operator,text});
 for(const op of [undefined,null,"contains","equals","not_equals","exists"])assert.equal(m(op),true,String(op));
 assert.equal(m("exact"),false);assert.equal(m("exact","tod"),true);
 for(const op of ["starts_with","regex","EXACT","",5,{},[]])assert.equal(m(op),false,String(op));
 assert.equal(keywordTriggerProblem({kind:"trigger",triggerMode:"keyword",keywords:"TOD",operator:"starts_with"}),
  "keyword_trigger_invalid_match_mode");
 assert.equal(keywordTriggerProblem({kind:"trigger",triggerMode:"keyword",keywords:"TOD",operator:"exact"}),null);
 assert.equal(keywordTriggerProblem({kind:"trigger",triggerMode:"keyword",keywords:"TOD",operator:"equals"}),null);
});
test("matcher: Arabic normalization (tashkeel, tatweel, alef and yaa variants), no lossy or morphological folds",()=>{
 const m=(text:string,keywords="اشتراكات",operator?:string)=>matchesKeywordTrigger({keywords,operator,text});
 assert.equal(m("اشتراكات"),true);
 assert.equal(m("اِشْتِرَاكَات"),true,"tashkeel removed");
 assert.equal(m("اشـتـراكات"),true,"tatweel removed");
 assert.equal(m("إشتراكات"),true,"hamza-below alef folded");
 assert.equal(m("أشتراكات"),true);
 assert.equal(m("آشتراكات"),true);
 assert.equal(m("كم سعر اشتراكات؟"),true,"Arabic question mark is a boundary");
 assert.equal(m("كم سعر اشتراكات، شكرا"),true,"Arabic comma is a boundary");
 // Prefixed forms are a different token: customers add them as extra keywords.
 assert.equal(m("كم سعر الاشتراكات؟"),false,"ال prefix is NOT folded");
 assert.equal(m("واشتراكات"),false);
 assert.equal(m("كم سعر الاشتراكات؟","اشتراكات، الاشتراكات"),true,"variant listed as an extra keyword");
 assert.equal(m("اشتراك"),false);
 assert.equal(m("اشتراكات","اشتراك"),false,"no prefix match inside a longer word");
 assert.equal(m("على","علي"),true,"ى -> ي");
 assert.equal(m("مدرسه","مدرسة"),false,"no ة/ه folding");
 // D-1: invisible formatting characters are REMOVED (behaviour change): ZWNJ inside a word
 // no longer hides it, and cannot create a boundary.
 assert.equal(m("اشترا‌كات"),true,"ZWNJ removed: same word");
 assert.equal(m("  اشتراكات  ","اشتراكات","exact"),true);
 assert.equal(m("اشتراكات شهرية","اشتراكات","exact"),false);
 assert.equal(m("كم الاشتراكات الشهرية","الاشتراكات الشهرية"),true,"Arabic phrase");
});
test("matcher: keyword list parsing (comma, Arabic comma, newline), empties never match",()=>{
 assert.deepEqual(parseTriggerKeywords("TOD, اشتراكات"),["tod","اشتراكات"]);
 assert.deepEqual(parseTriggerKeywords("a،b\nc,,  ,a"),["a","b","c"]);
 for(const text of ["TOD","اشتراكات","سعر","price list?"])
  assert.equal(matchesKeywordTrigger({keywords:"TOD،اشتراكات\nسعر, price list",text}),true,text);
 for(const keywords of ["","   ",",",", ،\n , ","ًـ",null,undefined,42,{},[],["  ",""]])
  for(const text of ["","TOD","anything",", ،"])for(const operator of ["contains","exact"])
   assert.equal(matchesKeywordTrigger({keywords,operator,text}),false,JSON.stringify([keywords,text,operator]));
 assert.deepEqual(parseTriggerKeywords("x".repeat(121)),[],"keywords above 120 chars dropped");
 assert.equal(parseTriggerKeywords(Array.from({length:60},(_,i)=>"k"+i).join(",")).length,40);
 assert.equal(matchesKeywordTrigger({keywords:["TOD"," "],text:"tod"}),true,"array form");
});
test("matcher: malformed / hostile input is safe; metacharacters literal; long input bounded",()=>{
 for(const text of [null,undefined,5,{},[],Symbol.iterator])
  assert.equal(matchesKeywordTrigger({keywords:"TOD",text}),false);
 assert.equal(matchesKeywordTrigger(null as any),false);
 assert.equal(matchesKeywordTrigger(undefined as any),false);
 // C-3: one cap, MAX_INBOUND_TEXT = 4096 characters
 assert.equal(matchesKeywordTrigger({keywords:"TOD",text:"x".repeat(4092)+" tod"}),true,"exactly 4096");
 assert.equal(matchesKeywordTrigger({keywords:"TOD",text:"x".repeat(4093)+" tod"}),false,"4097 never matches");
 assert.equal(matchesKeywordTrigger({keywords:"TOD",text:"x".repeat(4093)+"tod"}),false,"inside a word");
 const t0=Date.now();
 matchesKeywordTrigger({keywords:Array.from({length:40},(_,i)=>"a".repeat(i+1)).join(","),text:"a".repeat(8192)});
 matchesKeywordTrigger({keywords:"a a",text:"a ".repeat(4096)});
 assert.ok(Date.now()-t0<1000);
 assert.equal(matchesKeywordTrigger({keywords:".*",text:"anything"}),false);
 assert.equal(matchesKeywordTrigger({keywords:".*",text:"price .* here"}),true);
 assert.equal(matchesKeywordTrigger({keywords:"(a+)+$",text:"aaaaaaaaaaaaaaaaaaaaaaaaaaaab"}),false);
 assert.equal(matchesKeywordTrigger({keywords:"[x]",text:"x"}),false);
 assert.equal(matchesKeywordTrigger({keywords:"[x]",text:"see [x] here"}),true);
 assert.equal(matchesKeywordTrigger({keywords:"a|b",text:"b"}),false);
 assert.equal(matchesKeywordTrigger({keywords:"c++",text:"I love c++!"}),true);
 assert.equal(matchesKeywordTrigger({keywords:"\\d",text:"5"}),false);
 assert.equal(normalizeTriggerText(null),"");
 assert.deepEqual(parseTriggerKeywords(undefined),[]);
});
test("matcher never mutates the stored keyword text",()=>{
 const data=Object.freeze({kind:"trigger",triggerMode:"keyword",keywords:"  TOD ، إشتراكات "});
 assert.equal(dmTriggerAcceptsText(data,"tod"),true);
 assert.equal(data.keywords,"  TOD ، إشتراكات ");
 const list=Object.freeze(["TOD"]);
 assert.equal(matchesKeywordTrigger({keywords:list,text:"tod"}),true);
});

// Parity: one shared table through src/flow/eventRouting.ts and the server copy.
const PARITY_TEXTS=["TOD","tod","Tod","TOD 5","tods","today","(TOD)","tod!","to d","","   ","اشتراكات","اِشْتِرَاكَات",
 "إشتراكات","أشتراكات","آشتراكات","ٱشتراكات","اشـتـراكات","اشتراك","الاشتراكات","كم سعر اشتراكات؟","على","علي","مدرسه","مدرسة",
 "ＴＯＤ","ﻻ","price .* here","a|b","x‌y","Line1\nLine2","  مرحبا\t بكم  ","İstanbul","ß","ǅ",
 "اشترا‌كات","سعر؟","ﷺ","١٢٣","123","the price list please","price-list","𝒜 tod 𝒜","tod😀","c++ rocks"];
const PARITY_KEYWORDS=["TOD","TOD, اشتراكات","اشتراك","اشتراكات","الاشتراكات","إشتراك، أسعار","","  ",", ،",
 "a\nb","ＴＯＤ","على","مدرسة",".*","a|b","x".repeat(121),"ß","İ","123","١٢٣","ًـ","ﻻ",
 "price list","price","c++","سعر"];
const PARITY_OPERATORS=[undefined,"contains","exact","equals","starts_with"];
test("parity: normalizeTriggerText / parseTriggerKeywords identical to src/flow/eventRouting.ts",()=>{
 for(const s of [...PARITY_TEXTS,...PARITY_KEYWORDS]){
  assert.equal(normalizeTriggerText(s),clientNormalize(s),JSON.stringify(s));
  assert.deepEqual(parseTriggerKeywords(s),clientParse(s),JSON.stringify(s));
 }
});
test("parity: keyword match result identical to eventRouting.ts matchInboundEvent (both modes, legacy, invalid)",()=>{
 const counts:Record<string,number>={};
 for(const operator of PARITY_OPERATORS)for(const keywords of PARITY_KEYWORDS)for(const text of PARITY_TEXTS){
  const trigger=makeNode("trigger",{x:0,y:0},{platform:"instagram",triggerMode:"keyword",keywords,
   ...(operator===undefined?{}:{operator:operator as any})});
  if(operator===undefined)delete (trigger.data as any).operator;
  const message=makeNode("message",{x:0,y:200},{text:"hi"});
  const document:FlowDocument={version:3,name:"p",nodes:[trigger,message],edges:[]};
  const client=matchInboundEvent({tenantId:"t",accountId:"a",eventId:"e",senderId:"s",
   platform:"instagram",mode:"message",text},
   [{id:"f",tenantId:"t",accountId:"a",enabled:true,document}]).length===1;
  const server=matchesKeywordTrigger({keywords,operator,text});
  assert.equal(server,client,JSON.stringify([operator,keywords,text]));
  assert.equal(dmTriggerAcceptsText(trigger.data,text),client);
  assert.equal(clientMatchesText(clientNormalize(text),clientNormalize(keywords),clientMode(operator)??"contains"),
   keywordMatchesText(normalizeTriggerText(text),normalizeTriggerText(keywords),keywordMatchMode(operator)??"contains"));
  if(client)counts[String(operator)]=(counts[String(operator)]??0)+1;
 }
 assert.ok((counts.undefined??0)>10&&(counts.exact??0)>5,"the table exercises matches in both modes");
 assert.equal(counts.starts_with??0,0,"invalid mode never matches");
 assert.equal(counts.equals,counts.contains,"legacy equals = contains");
});
test("message trigger accepts every DM (keywords ignored); other modes never",()=>{
 assert.equal(dmTriggerAcceptsText({kind:"trigger",triggerMode:"message",keywords:""},"anything"),true);
 assert.equal(dmTriggerAcceptsText({kind:"trigger",triggerMode:"message",keywords:"TOD"},"hello"),true);
 for(const mode of ["comment","story","ad","live","referral",undefined])
  assert.equal(dmTriggerAcceptsText({kind:"trigger",triggerMode:mode,keywords:"TOD"},"TOD"),false);
 assert.equal(dmTriggerAcceptsText(null,"TOD"),false);
 assert.equal(keywordTriggerProblem({kind:"trigger",triggerMode:"keyword",keywords:" , "}),
  "keyword_trigger_requires_keywords");
 assert.equal(keywordTriggerProblem({kind:"trigger",triggerMode:"keyword",keywords:"TOD"}),null);
 assert.equal(keywordTriggerProblem({kind:"trigger",triggerMode:"message",keywords:""}),null);
 assert.equal(keywordTriggerProblem({kind:"trigger",triggerMode:"comment",keywords:""}),null);
});

// ============================================================ fixtures
const kwTrigger=(keywords:string,platform="instagram")=>
 ({kind:"trigger",platform,triggerMode:"keyword",keywords,operator:"contains"});
function v2Doc(trigger:Record<string,unknown>,text="أهلاً بك"){
 return {version:3,name:"V2",nodes:[
  {id:"in",data:trigger},
  {id:"out",data:{kind:"message",text,options:[],contentBlocks:[],image:""}}
 ],edges:[{source:"in",sourceHandle:"next",target:"out",targetHandle:"in"}]};
}
function v2ConditionDoc(trigger:Record<string,unknown>){
 return {version:3,nodes:[
  {id:"in",data:trigger},
  {id:"test",data:{kind:"condition",conditionField:"message",operator:"contains",conditionValue:"5"}},
  {id:"y",data:{kind:"message",text:"YES",options:[],contentBlocks:[],image:""}},
  {id:"n",data:{kind:"message",text:"NO",options:[],contentBlocks:[],image:""}}
 ],edges:[{source:"in",target:"test",sourceHandle:"next"},
  {source:"test",target:"y",sourceHandle:"yes"},{source:"test",target:"n",sourceHandle:"no"}]};
}
function buttonsDoc(trigger:Record<string,unknown>,question="اختر"){
 return {version:3,name:"Buttons",nodes:[
  {id:"start",data:trigger},
  {id:"choose",data:{kind:"question",inputMode:"buttons",text:question,image:"",contentBlocks:[],options:[
   {id:"prices",label:"الأسعار"},{id:"support",label:"المساعدة"}]}},
  {id:"yes",data:{kind:"message",text:"هذه الأسعار",image:"",options:[],contentBlocks:[]}},
  {id:"no",data:{kind:"message",text:"تواصل معنا",image:"",options:[],contentBlocks:[]}}
 ],edges:[{source:"start",target:"choose",sourceHandle:"next"},
  {source:"choose",target:"yes",sourceHandle:"prices"},
  {source:"choose",target:"no",sourceHandle:"support"}]};
}
function delayDoc(trigger:Record<string,unknown>){
 return {version:3,nodes:[{id:"start",data:trigger},
  {id:"sleep",data:{kind:"delay",delayValue:1,delayUnit:"minutes"}},
  {id:"yes",data:{kind:"message",text:"بعد دقيقة",image:"",options:[],contentBlocks:[]}}],
  edges:[{source:"start",target:"sleep",sourceHandle:"next"},{source:"sleep",target:"yes",sourceHandle:"next"}]};
}
const messageTrigger={kind:"trigger",platform:"instagram",triggerMode:"message",keywords:""};

// ============================================================ B2: V2 path
test("V2 shape: keyword trigger supported only with >= 1 valid keyword; message trigger unchanged",()=>{
 assert.equal(simpleFlowDocumentSupported(v2Doc(kwTrigger("TOD, اشتراكات")),"instagram"),true);
 assert.equal(simpleFlowDocumentSupported(v2ConditionDoc(kwTrigger("TOD")),"instagram"),true);
 for(const k of [""," ",", ،","ً","x".repeat(121)]){
  assert.equal(simpleFlowDocumentSupported(v2Doc(kwTrigger(k)),"instagram"),false,JSON.stringify(k));
  for(const text of ["",k,"TOD","anything"])
   assert.equal(simpleMessageFromDocument(v2Doc(kwTrigger(k)),"instagram",text),null);
 }
 // keyword trigger of another platform is refused like a message trigger
 assert.equal(simpleFlowDocumentSupported(v2Doc(kwTrigger("TOD","messenger")),"instagram"),false);
 assert.equal(simpleFlowDocumentSupported(v2Doc(kwTrigger("TOD","messenger")),"facebook"),true);
 // message trigger: byte-for-byte as before for any text
 for(const text of ["","hello","TOD"]){
  assert.equal(simpleMessageFromDocument(v2Doc(messageTrigger),"instagram",text),"أهلاً بك");
  assert.equal(simpleMessageFromDocument(v2Doc({...messageTrigger,keywords:"TOD"}),"instagram",text),"أهلاً بك");
 }
 assert.equal(simpleFlowDocumentSupported(v2Doc(messageTrigger),"instagram"),true);
 // other trigger modes stay unsupported
 for(const triggerMode of ["comment","story","ad","live","referral"])
  assert.equal(simpleFlowDocumentSupported(v2Doc({...messageTrigger,triggerMode,keywords:"TOD"}),"instagram"),false);
});
test("V2 reply: keyword match replies, non-match is null; condition still evaluated after the gate",()=>{
 const doc=v2Doc(kwTrigger("TOD, اشتراكات"));
 assert.equal(simpleMessageFromDocument(doc,"instagram","tod"),"أهلاً بك");
 assert.equal(simpleMessageFromDocument(doc,"instagram","كم إشتراكات؟"),"أهلاً بك");
 assert.equal(simpleMessageFromDocument(doc,"instagram","today"),null,"token-aware: not inside another word");
 assert.equal(simpleMessageFromDocument(doc,"instagram","hello"),null);
 assert.equal(simpleMessageFromDocument(doc,"instagram",""),null);
 assert.equal(simpleMessageFromDocument(doc,"instagram"),null);
 const cond=v2ConditionDoc(kwTrigger("TOD"));
 assert.equal(simpleMessageFromDocument(cond,"instagram","TOD 5"),"YES");
 assert.equal(simpleMessageFromDocument(cond,"instagram","TOD"),"NO");
 assert.equal(simpleMessageFromDocument(cond,"instagram","5"),null);
});

type Pub={tenant:string;account:string;platform:string;flow_key:string;revision:number;document:unknown};
type Act={tenant:string;account:string;platform:string;flow_key:string;revision:number};
const T={a:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",b:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"};
const A={a:"11111111-1111-4111-8111-111111111111",b:"22222222-2222-4222-8222-222222222222"};
/** Filter-aware fake (tenant_id / channel_account_id / platform / flow_key / revision). */
function scopedDb(o:{pubs:Pub[];acts:Act[];approved?:boolean;awaiting?:any[];claims?:string[];
 rpc?:Record<string,(args:any)=>any>}){
 const reads:Array<{table:string;filters:Record<string,unknown>}>=[];
 const calls:Array<{name:string;args:any}>=[];
 const claimed=new Set(o.claims??[]);
 const match=(f:Record<string,unknown>,row:{tenant:string;account:string;platform:string;flow_key:string;revision:number})=>
  (!("tenant_id" in f)||f.tenant_id===row.tenant)&&
  (!("channel_account_id" in f)||f.channel_account_id===row.account)&&
  (!("platform" in f)||f.platform===row.platform)&&
  (!("flow_key" in f)||f.flow_key===row.flow_key)&&
  (!("revision" in f)||Number(f.revision)===row.revision);
 const db:any={
  from:(table:string)=>{
   const filters:Record<string,unknown>={};
   const q:any={
    select:()=>q,eq:(k:string,v:unknown)=>{filters[k]=v;return q;},
    in:(k:string,v:unknown)=>{filters[k]=v;return q;},gt:()=>q,lte:()=>q,
    update:()=>{throw Error("unexpected write");},insert:()=>{throw Error("unexpected write");},
    maybeSingle:async()=>{reads.push({table,filters});
     if(table==="automation_flow_global_switch")return {data:{enabled:true},error:null};
     if(table==="automation_flow_tenant_switches")return {data:{enabled:true,test_only:false,
      production_approved:o.approved!==false},error:null};
     if(table==="automation_flow_publications"){
      const hit=o.pubs.filter(p=>match(filters,p));
      return {data:hit.length===1?{document:hit[0].document}:null,error:null};
     }
     return {data:null,error:null};
    },
    limit:async()=>{reads.push({table,filters});
     if(table==="automation_flow_activations")
      return {data:o.acts.filter(a=>match(filters,a)).map(a=>({flow_key:a.flow_key,revision:a.revision,is_active:true})),error:null};
     if(table==="automation_flow_runs")
      return {data:filters.run_status==="awaiting_input"?(o.awaiting??[]):[],error:null};
     if(table==="automation_message_claims")
      return {data:claimed.has(String(filters.provider_event_id))?[{id:"c"}]:[],error:null};
     return {data:[],error:null};
    }
   };return q;
  },
  rpc:async(name:string,args:any)=>{
   calls.push({name,args});
   if(o.rpc?.[name])return o.rpc[name](args);
   if(name==="flow_claim_begin_durable_run"){
    if(claimed.has(args.p_event))return {data:[{acquired:false,run_id:null}],error:null};
    claimed.add(args.p_event);
    return {data:[{acquired:true,run_id:"88888888-8888-4888-8888-888888888888"}],error:null};
   }
   if(name==="flow_claim_inbound_durable"){claimed.add(args.p_provider_event_id);
    return {data:[{acquired:true,route:"flow"}],error:null};}
   if(name==="flow_resume_button_run")return {data:true,error:null};
   if(name==="flow_cancel_run")return {data:true,error:null};
   throw Error("Unexpected RPC "+name);
  }
 };
 return {db,reads,calls};
}
const scopedTo=(reads:Array<{table:string;filters:Record<string,unknown>}>,tenant:string,account:string)=>{
 for(const r of reads){
  if(r.table==="automation_flow_global_switch")continue;
  assert.equal(r.filters.tenant_id,tenant,r.table+" read without the event tenant");
  if(["automation_flow_activations","automation_flow_publications","automation_flow_runs",
   "automation_message_claims"].includes(r.table))
   assert.equal(r.filters.channel_account_id,account,r.table+" read without the event account");
  if(["automation_flow_activations","automation_flow_publications"].includes(r.table))
   assert.ok("platform" in r.filters,r.table+" read without platform");
 }
};

test("V2 prepareSimpleFlowReply: keyword match -> reply of the ACTIVE revision; non-match -> null",async()=>{
 const pubs:Pub[]=[
  {tenant:T.a,account:A.a,platform:"instagram",flow_key:"kw",revision:1,document:v2Doc(kwTrigger("TOD"),"OLD")},
  {tenant:T.a,account:A.a,platform:"instagram",flow_key:"kw",revision:2,document:v2Doc(kwTrigger("TOD"),"ACTIVE")},
  {tenant:T.b,account:A.b,platform:"instagram",flow_key:"kw",revision:2,document:v2Doc(kwTrigger("hello"),"B-REPLY")}];
 const acts:Act[]=[{tenant:T.a,account:A.a,platform:"instagram",flow_key:"kw",revision:2},
  {tenant:T.b,account:A.b,platform:"instagram",flow_key:"kw",revision:2}];
 await withEnv({},async()=>{
  const hit=scopedDb({pubs,acts});
  assert.equal(await prepareSimpleFlowReply(hit.db,T.a,A.a,"instagram","Tod please"),"ACTIVE");
  scopedTo(hit.reads,T.a,A.a);
  const miss=scopedDb({pubs,acts});
  // B's keyword "hello" is never consulted for account A.
  assert.equal(await prepareSimpleFlowReply(miss.db,T.a,A.a,"instagram","hello"),null);
  scopedTo(miss.reads,T.a,A.a);
  assert.equal(miss.calls.length,0,"no claim from the prepare step");
  // Unapproved tenant: unchanged gate (null before any activation read).
  const off=scopedDb({pubs,acts,approved:false});
  assert.equal(await prepareSimpleFlowReply(off.db,T.a,A.a,"instagram","TOD"),null);
  assert.ok(!off.reads.some(r=>r.table==="automation_flow_activations"));
  // Facebook/WhatsApp: V2 stays off without FLOW_RUNTIME_MODE=message_only.
  const fb=scopedDb({pubs:[{...pubs[1],platform:"facebook",document:v2Doc(kwTrigger("TOD","messenger"))}],
   acts:[{...acts[0],platform:"facebook"}]});
  assert.equal(await prepareSimpleFlowReply(fb.db,T.a,A.a,"facebook","TOD"),null);
  assert.equal(fb.reads.length,0);
 });
});
test("V2 non-match falls through to the legacy AI route: claim(engineReady=false), no flow reply",async()=>{
 const pubs:Pub[]=[{tenant:T.a,account:A.a,platform:"instagram",flow_key:"kw",revision:1,
  document:v2Doc(kwTrigger("TOD"),"FLOW-REPLY")}];
 const acts:Act[]=[{tenant:T.a,account:A.a,platform:"instagram",flow_key:"kw",revision:1}];
 await withEnv({},async()=>{
  for(const [text,expectReady,expectSent] of [["hello",false,"AI-REPLY"],["tod",true,"FLOW-REPLY"]] as const){
   const {db}=scopedDb({pubs,acts});
   const ready:boolean[]=[];let ai=0;const sent:string[]=[];
   const r=await processExclusiveEvent({
    prepareFlow:()=>prepareSimpleFlowReply(db,T.a,A.a,"instagram",text),
    claim:async(engineReady)=>{ready.push(engineReady);
     return {acquired:true,route:engineReady?"flow":"legacy_ai",outgoing_message_id:"o"};},
    legacyAnswer:async()=>{ai++;return "AI-REPLY";},
    send:async(t)=>{sent.push(t);return {providerMessageId:"mid"};},
    persistSent:async()=>true,debit:async()=>1
   });
   assert.equal(r,"sent_and_billed");
   assert.deepEqual(ready,[expectReady]);
   assert.deepEqual(sent,[expectSent]);
   assert.equal(ai,expectReady?0:1);
  }
 });
});

// ======================================================== B3: durable path
// Worker readiness gates (flowDurableIngress.ts durableWorkerGatesOpen): a NEW
// durable run starts only while the operator gates of the workers that produce
// its reply are open, so the durable start tests run with them open.
const WORKERS_READY:Record<string,string>={FLOW_WORKERS_OPERATOR_RELEASE:"production-canary-approved",
 FLOW_OUTBOX_SEND_ENABLED:"true",FLOW_ATOMIC_CONSUME_READY:"true",FLOW_DURABLE_SCHEDULER_ENABLED:"true",
 FLOW_RICH_BUTTONS_ENABLED:"true",FLOW_INTERNAL_ACTIONS_ENABLED:"true",FIELD_ENCRYPTION_KEY:"test-only-field-key"};
const canary={...WORKERS_READY,FLOW_DURABLE_INGRESS_ENABLED:"true",FLOW_DURABLE_CANARY_ACCOUNT_ID:A.a};
const ev=(over:Record<string,unknown>={})=>({tenantId:T.a,accountId:A.a,
 conversationId:"44444444-4444-4444-8444-444444444444",inboundId:"77777777-7777-4777-8777-777777777771",
 eventId:"meta-1",platform:"instagram",providerEventIdGenuine:true,text:"TOD",...over}) as any;

test("durable whitelist: keyword trigger accepted with valid keywords; kinds unchanged",()=>{
 assert.equal(supportedDurableDocument(buttonsDoc(kwTrigger("TOD"))),true);
 assert.equal(durableCandidateKind(buttonsDoc(kwTrigger("TOD"))),"buttons");
 assert.equal(durableCandidateKind(delayDoc(kwTrigger("TOD"))),"delay");
 assert.equal(durableCandidateKind(buttonsDoc(messageTrigger)),"buttons");
 for(const k of [""," , ","ـ"]){
  assert.equal(supportedDurableDocument(buttonsDoc(kwTrigger(k))),false);
  assert.equal(durableCandidateKind(delayDoc(kwTrigger(k))),"unsupported");
 }
 // V2 shapes stay V2's (disjoint), with keyword triggers too
 assert.equal(supportedDurableDocument(v2Doc(kwTrigger("TOD"))),false);
 assert.equal(supportedDurableDocument(v2ConditionDoc(kwTrigger("TOD"))),false);
 assert.equal(durableCandidateKind(v2Doc(kwTrigger("TOD"))),"unsupported");
 assert.equal(simpleFlowDocumentSupported(buttonsDoc(kwTrigger("TOD")),"instagram"),false);
 for(const triggerMode of ["comment","story"])
  assert.equal(supportedDurableDocument(buttonsDoc({...messageTrigger,triggerMode,keywords:"TOD"})),false);
});
const durablePubs=(docA:unknown,docB:unknown=buttonsDoc(kwTrigger("اشتراكات"),"B-Q")):Pub[]=>[
 {tenant:T.a,account:A.a,platform:"instagram",flow_key:"flowA",revision:3,document:docA},
 {tenant:T.b,account:A.b,platform:"instagram",flow_key:"flowB",revision:1,document:docB}];
const durableActs:Act[]=[{tenant:T.a,account:A.a,platform:"instagram",flow_key:"flowA",revision:3},
 {tenant:T.b,account:A.b,platform:"instagram",flow_key:"flowB",revision:1}];

test("durable: matching keyword starts exactly one run with one atomic claim",async()=>{
 await withEnv(canary,async()=>{
  const {db,calls,reads}=scopedDb({pubs:durablePubs(buttonsDoc(kwTrigger("TOD"))),acts:durableActs});
  assert.equal(await attemptDurableInstagram(db,ev({text:"tod 5"})),"handled");
  assert.deepEqual(calls.map(c=>c.name),["flow_claim_begin_durable_run"]);
  const a=calls[0].args;
  assert.equal(a.p_flow,"flowA");assert.equal(a.p_revision,3);
  assert.equal(a.p_tenant,T.a);assert.equal(a.p_account,A.a);assert.equal(a.p_platform,"instagram");
  assert.equal(a.p_effects[0].payload.text,"اختر");
  scopedTo(reads,T.a,A.a);
 });
});
test("durable: non-matching text -> no claim, no run, no cancel/supersede, falls back",async()=>{
 await withEnv(canary,async()=>{
  for(const text of ["hello","",undefined,null,"اشتراكات"]){
   const {db,calls,reads}=scopedDb({pubs:durablePubs(buttonsDoc(kwTrigger("TOD"))),acts:durableActs});
   assert.equal(await attemptDurableInstagram(db,ev({text})),"fallback",String(text));
   assert.deepEqual(calls,[],"no RPC at all: nothing claimed, started, cancelled or superseded");
   // B's flow/keywords are never consulted for account A
   scopedTo(reads,T.a,A.a);
   assert.ok(!reads.some(r=>r.filters.flow_key==="flowB"));
  }
  // delay flow (a sleeping run could exist): a non-match still never reaches the superseding RPC
  const {db,calls}=scopedDb({pubs:durablePubs(delayDoc(kwTrigger("TOD"))),acts:durableActs});
  assert.equal(await attemptDurableInstagram(db,ev({text:"hi"})),"fallback");
  assert.deepEqual(calls,[]);
 });
});
test("durable: message-trigger graphs start for any text (unchanged)",async()=>{
 await withEnv(canary,async()=>{
  for(const text of ["hello","",undefined]){
   const {db,calls}=scopedDb({pubs:durablePubs(buttonsDoc(messageTrigger)),acts:durableActs});
   assert.equal(await attemptDurableInstagram(db,ev({text})),"handled");
   assert.deepEqual(calls.map(c=>c.name),["flow_claim_begin_durable_run"]);
  }
 });
});
test("durable: button reply resumes the waiting run regardless of keywords",async()=>{
 await withEnv(canary,async()=>{
  const run={id:"77777777-7777-4777-8777-7777777777a4",tenant_id:T.a,channel_account_id:A.a,
   platform:"instagram",conversation_id:ev().conversationId,provider_event_id:"meta-start",
   flow_key:"flowA",publication_revision:3,current_node_id:"choose",run_status:"awaiting_input",
   step_count:2,variables:{},wake_at:null};
  const {db,calls}=scopedDb({pubs:durablePubs(buttonsDoc(kwTrigger("TOD"))),acts:durableActs,awaiting:[run]});
  assert.equal(await attemptDurableInstagram(db,ev({eventId:"meta-tap",text:"الأسعار",selectedChoiceId:"prices"})),"handled");
  assert.deepEqual(calls.map(c=>c.name),["flow_claim_inbound_durable","flow_resume_button_run"]);
  assert.equal(calls[1].args.p_run,run.id);
  assert.equal(calls[1].args.p_effects[0].payload.text,"هذه الأسعار");
 });
});
test("durable: duplicate delivery of the same provider event -> one run, one claim",async()=>{
 await withEnv(canary,async()=>{
  const {db,calls}=scopedDb({pubs:durablePubs(buttonsDoc(kwTrigger("TOD"))),acts:durableActs});
  assert.equal(await attemptDurableInstagram(db,ev()),"handled");
  assert.equal(await attemptDurableInstagram(db,ev()),"handled");
  assert.equal(calls.filter(c=>c.name==="flow_claim_begin_durable_run").length,1);
  assert.equal(calls.length,1);
 });
});
test("durable: two tenants with different keyword flows stay isolated",async()=>{
 await withEnv({...canary},async()=>{
  // B's keyword sent to A: A's flow does not match -> fallback, B never read.
  const x=scopedDb({pubs:durablePubs(buttonsDoc(kwTrigger("TOD"))),acts:durableActs});
  assert.equal(await attemptDurableInstagram(x.db,ev({text:"اشتراكات"})),"fallback");
  assert.deepEqual(x.calls,[]);
  scopedTo(x.reads,T.a,A.a);
  // A's keyword: A's flow/revision only.
  const y=scopedDb({pubs:durablePubs(buttonsDoc(kwTrigger("TOD"))),acts:durableActs});
  assert.equal(await attemptDurableInstagram(y.db,ev({text:"TOD"})),"handled");
  assert.equal(y.calls[0].args.p_flow,"flowA");
  scopedTo(y.reads,T.a,A.a);
  // B's account is not the canary: its matching keyword never enters the durable path.
  const z=scopedDb({pubs:durablePubs(buttonsDoc(kwTrigger("TOD"))),acts:durableActs});
  assert.equal(await attemptDurableInstagram(z.db,ev({tenantId:T.b,accountId:A.b,text:"اشتراكات"})),"fallback");
  assert.deepEqual(z.reads,[]);assert.deepEqual(z.calls,[]);
 });
 await withEnv({...canary,FLOW_DURABLE_CANARY_ACCOUNT_ID:A.b},async()=>{
  const w=scopedDb({pubs:durablePubs(buttonsDoc(kwTrigger("TOD"))),acts:durableActs});
  assert.equal(await attemptDurableInstagram(w.db,ev({tenantId:T.b,accountId:A.b,text:"TOD"})),"fallback");
  assert.deepEqual(w.calls,[]);
  scopedTo(w.reads,T.b,A.b);
  const v=scopedDb({pubs:durablePubs(buttonsDoc(kwTrigger("TOD"))),acts:durableActs});
  assert.equal(await attemptDurableInstagram(v.db,ev({tenantId:T.b,accountId:A.b,text:"كم اشتراكات"})),"handled");
  assert.equal(v.calls[0].args.p_flow,"flowB");
  assert.equal(v.calls[0].args.p_effects[0].payload.text,"B-Q");
  scopedTo(v.reads,T.b,A.b);
 });
});
test("durable: stored keyword flow with blank keywords never starts (fail safe)",async()=>{
 await withEnv(canary,async()=>{
  for(const text of ["", " , ","TOD"]){
   const {db,calls}=scopedDb({pubs:durablePubs(buttonsDoc(kwTrigger(" , "))),acts:durableActs});
   assert.equal(await attemptDurableInstagram(db,ev({text})),"fallback");
   assert.deepEqual(calls,[]);
  }
 });
});
test("documentTriggerData requires exactly one trigger",()=>{
 assert.equal(documentTriggerData(null),null);
 assert.equal(documentTriggerData({nodes:[]}),null);
 const d=buttonsDoc(kwTrigger("TOD"));
 assert.equal(documentTriggerData({...d,nodes:[...d.nodes,d.nodes[0]]}),null);
 assert.equal(documentTriggerData(d)?.keywords,"TOD");
});

// =================================================== B4: flow-publication
const ORIGIN="https://hsnq2022022-cyber.github.io";
const USER="99999999-9999-4999-8999-999999999999";
function modelDoc(mode:"keyword"|"message",keywords:string):FlowDocument{
 const t=makeNode("trigger",{x:0,y:0},{platform:"instagram",triggerMode:mode,keywords});
 const m=makeNode("message",{x:0,y:200},{text:"مرحبا"});
 return {version:3,name:"k",nodes:[t,m],edges:[edgeFor({source:t.id,target:m.id,sourceHandle:"next",targetHandle:"in"} as any)]};
}
function publicationClient(stored:unknown){
 const rpcs:Array<{name:string;args:any}>=[];
 const factory=()=>({
  auth:{getUser:async()=>({data:{user:{id:USER}},error:null})},
  from:(table:string)=>{
   const q:any={select:()=>q,eq:()=>q,in:()=>q,order:()=>q,
    maybeSingle:async()=>({data:
     table==="tenants"?{id:T.a,user_id:USER,is_active:true}:
     table==="channel_accounts"?{id:A.a,tenant_id:T.a,platform:"instagram",is_active:true,agent_enabled:true,auto_reply:true}:
     table==="automation_flow_global_switch"?{enabled:true}:
     table==="automation_flow_tenant_switches"?{enabled:true,production_approved:true}:
     // operator registry (publication/runtime agreement): this account is registered
     table==="automation_flow_canary_accounts"?{channel_account_id:A.a}:
     table==="automation_flow_publications"?(stored===undefined?null:{document:stored}):null,error:null}),
    limit:async()=>({data:[],error:null})};
   return q;
  },
  rpc:async(name:string,args:any)=>{rpcs.push({name,args});
   if(name==="flow_publication_rate_allow")return {data:true,error:null};
   if(name==="flow_publish_revision")return {data:7,error:null};
   if(name==="flow_activate_revision")return {data:true,error:null};
   throw Error("unexpected rpc "+name);}
 });
 return {factory:factory as any,rpcs};
}
const post=(body:unknown)=>new Request("https://example.test/functions/v1/flow-publication",{method:"POST",
 headers:{origin:ORIGIN,authorization:"Bearer user-jwt","content-type":"application/json"},body:JSON.stringify(body)});
const baseEnv:Env={SUPABASE_SERVICE_ROLE_KEY:"dummy-service",SUPABASE_URL:"http://localhost:54321",
 FLOW_OPERATOR_USER_IDS:USER};
async function call(env:Env,body:Record<string,unknown>,stored?:unknown){
 return withEnv({...baseEnv,...env},async()=>{
  const c=publicationClient(stored);
  const res=await handleFlowPublication(post({accountId:A.a,flowKey:"kw_flow",...body}),c.factory);
  return {status:res.status,body:await res.json(),rpcs:c.rpcs.map(r=>r.name)};
 });
}
test("publish: keyword trigger with no usable keyword is rejected (422), valid ones publish",async()=>{
 const empty=await call({},{action:"publish",document:modelDoc("keyword","")});
 assert.equal(empty.status,422);
 assert.ok(!empty.rpcs.includes("flow_publish_revision"));
 for(const k of [" ، ","ًـ","x".repeat(121)]){
  const blank=await call({},{action:"publish",document:modelDoc("keyword",k)});
  assert.equal(blank.status,422,JSON.stringify(k));
  // Checked on the raw document first: an explicit reason, never published.
  assert.equal(blank.body.error,k.length>120?"Keyword trigger keyword is longer than 120 characters":
   "Keyword trigger needs at least one keyword");
  assert.ok(!blank.rpcs.includes("flow_publish_revision"));
 }
 const ok=await call({},{action:"publish",document:modelDoc("keyword","TOD, اشتراكات")});
 assert.equal(ok.status,200);assert.equal(ok.body.revision,7);
 const msg=await call({},{action:"publish",document:modelDoc("message","")});
 assert.equal(msg.status,200,"message trigger with empty keywords still publishes");
});
test("activate: V2 keyword flow accepted on the production path; message flow unchanged",async()=>{
 const kw=await call({},{action:"activate",revision:7},modelDoc("keyword","TOD"));
 assert.equal(kw.status,200);assert.deepEqual(kw.rpcs.slice(-1),["flow_activate_revision"]);
 const msg=await call({},{action:"activate",revision:7},modelDoc("message",""));
 assert.equal(msg.status,200);
 // stored keyword document with blank keywords (bypassing publish): refused
 const raw=JSON.parse(JSON.stringify(modelDoc("keyword","TOD")));raw.nodes[0].data.keywords=" ، ";
 const blank=await call({},{action:"activate",revision:7},raw);
 assert.equal(blank.status,422);assert.ok(!blank.rpcs.includes("flow_activate_revision"));
 // unsupported nodes still refused
 const story=JSON.parse(JSON.stringify(modelDoc("keyword","TOD")));story.nodes[0].data.triggerMode="story";
 assert.equal((await call({},{action:"activate",revision:7},story)).status,422);
 assert.equal((await call({},{action:"activate",revision:7},buttonsDoc(kwTrigger("TOD")))).status,422,
  "durable graph without the durable operator gates");
});
const durableEnv:Env={FLOW_DURABLE_ACTIVATION_READY:"true",FLOW_DURABLE_INGRESS_ENABLED:"true",
 FLOW_DURABLE_CANARY_ACCOUNT_ID:A.a,FLOW_WORKERS_OPERATOR_RELEASE:"production-canary-approved",
 FLOW_OUTBOX_SEND_ENABLED:"true",FLOW_ATOMIC_CONSUME_READY:"true",FIELD_ENCRYPTION_KEY:"dummy-field-key",
 FLOW_RICH_BUTTONS_ENABLED:"true",FLOW_DURABLE_SCHEDULER_ENABLED:"true"};
test("activate: durable keyword flow accepted only with every durable gate; blank keywords refused",async()=>{
 const ok=await call(durableEnv,{action:"activate",revision:3},buttonsDoc(kwTrigger("TOD")));
 assert.equal(ok.status,200);
 const delay=await call(durableEnv,{action:"activate",revision:3},delayDoc(kwTrigger("TOD")));
 assert.equal(delay.status,200);
 const noSched=await call({...durableEnv,FLOW_DURABLE_SCHEDULER_ENABLED:undefined},
  {action:"activate",revision:3},delayDoc(kwTrigger("TOD")));
 assert.equal(noSched.status,422,"readiness gate (scheduler) still enforced");
 const blank=await call(durableEnv,{action:"activate",revision:3},buttonsDoc(kwTrigger(" , ")));
 assert.equal(blank.status,422);assert.ok(!blank.rpcs.includes("flow_activate_revision"));
 const other=await call({...durableEnv,FLOW_DURABLE_CANARY_ACCOUNT_ID:A.b},{action:"activate",revision:3},
  buttonsDoc(kwTrigger("TOD")));
 assert.equal(other.status,422,"another canary account: not durable");
});
test("readiness reports the durable candidate kind of a keyword flow",async()=>{
 const r=await call(durableEnv,{action:"readiness",revision:3},delayDoc(kwTrigger("TOD")));
 assert.equal(r.status,200);
 assert.equal(r.body.readiness.candidateKind,"delay");
 assert.equal(r.body.readiness.needsScheduler,true);
 const blank=await call(durableEnv,{action:"readiness",revision:3},delayDoc(kwTrigger(" ")));
 assert.equal(blank.body.readiness.candidateKind,"unsupported");
});
test("canary capability set: trigger:keyword only follows trigger:message",()=>{
 assert.deepEqual([...withKeywordTrigger(new Set(["execution-engine","trigger:message"] as any))].sort(),
  ["execution-engine","trigger:keyword","trigger:message"]);
 assert.deepEqual([...withKeywordTrigger(new Set(["execution-engine"] as any))],["execution-engine"]);
});
test("documentKeywordTriggerProblem only concerns keyword triggers",()=>{
 assert.equal(documentKeywordTriggerProblem(modelDoc("keyword","")),"keyword_trigger_requires_keywords");
 assert.equal(documentKeywordTriggerProblem(modelDoc("keyword","TOD")),null);
 assert.equal(documentKeywordTriggerProblem(modelDoc("message","")),null);
 assert.equal(documentKeywordTriggerProblem(null),null);
});
test("publish/activate: keyword match mode exact accepted; unknown mode refused (never silently changed)",async()=>{
 const exact=modelDoc("keyword","TOD");(exact.nodes[0].data as any).operator="exact";
 const ok=await call({},{action:"publish",document:exact});
 assert.equal(ok.status,200);
 const legacy=modelDoc("keyword","TOD");(legacy.nodes[0].data as any).operator="equals";
 assert.equal((await call({},{action:"publish",document:legacy})).status,200,"legacy value = contains");
 for(const op of ["starts_with","regex","EXACT",5]){
  const bad=JSON.parse(JSON.stringify(modelDoc("keyword","TOD")));bad.nodes[0].data.operator=op;
  const r=await call({},{action:"publish",document:bad});
  assert.equal(r.status,422,String(op));
  assert.equal(r.body.error,"Keyword trigger match mode is invalid");
  assert.ok(!r.rpcs.includes("flow_publish_revision"));
  // a stored document with an invalid mode (bypassing publish) is never activated
  const act=await call({},{action:"activate",revision:7},bad);
  assert.equal(act.status,422);assert.ok(!act.rpcs.includes("flow_activate_revision"));
 }
 // exact mode activates on the V2 path
 const actOk=await call({},{action:"activate",revision:7},exact);
 assert.equal(actOk.status,200);
});

// ============================================ D-1: hidden formatting characters
import {HIDDEN_FORMAT_CHARS,keywordListProblem,MAX_INBOUND_TEXT,MAX_TRIGGER_KEYWORDS,MAX_TRIGGER_KEYWORD_LENGTH}
 from "../supabase/functions/milan-api/triggerKeywords.ts";
import {HIDDEN_FORMAT_CHARS as CLIENT_HIDDEN,keywordListProblem as clientListProblem,MAX_TEXT as CLIENT_MAX_TEXT}
 from "../src/flow/eventRouting.ts";
import {MAX_TEXT_CHARS as INGRESS_MAX_TEXT} from "../supabase/functions/milan-api/normalizeMetaMessage.ts";
const HIDDEN=["­","؜","​","‌","‍","‎","‏","‪","‫","‬","‭","‮",
 "⁠","⁡","⁢","⁣","⁤","⁦","⁧","⁨","⁩","﻿"];
/** Same decision in both copies (server matcher and src/flow/eventRouting.ts). */
const both=(keywords:string,text:string,operator?:string)=>{
 const server=matchesKeywordTrigger({keywords,operator,text});
 const trigger=makeNode("trigger",{x:0,y:0},{platform:"instagram",triggerMode:"keyword",keywords,
  ...(operator?{operator:operator as any}:{})});
 const document:FlowDocument={version:3,name:"h",nodes:[trigger,makeNode("message",{x:0,y:200},{text:"x"})],edges:[]};
 const client=matchInboundEvent({tenantId:"t",accountId:"a",eventId:"e",senderId:"s",platform:"instagram",mode:"message",text},
  [{id:"f",tenantId:"t",accountId:"a",enabled:true,document}]).length===1;
 assert.equal(server,client,JSON.stringify([keywords,text,operator]));
 return server;
};
test("D-1: the hidden-character set is identical in both copies and removed from text AND keywords",()=>{
 assert.equal(String(HIDDEN_FORMAT_CHARS),String(CLIENT_HIDDEN));
 for(const h of HIDDEN){
  assert.equal(normalizeTriggerText("to"+h+"d"),"tod",JSON.stringify(h));
  assert.equal(clientNormalize("to"+h+"d"),"tod");
 }
 // visible separators are NOT in the set (they stay boundaries)
 for(const visible of ["\u200A","\u00A0","\u3000"])assert.equal(normalizeTriggerText("a"+visible+"b"),"a b");
});
test("D-1: hidden characters never create an artificial boundary nor bypass matching (both modes, both copies)",()=>{
 for(const h of HIDDEN){
  assert.equal(both("TOD","tod"+h+"ay"),false,"tod<hidden>ay is 'today' "+h.codePointAt(0)!.toString(16));
  assert.equal(both("today","tod"+h+"ay"),true);
  assert.equal(both("TOD","T"+h+"OD 5"),true,"hidden inside the keyword in the text");
  assert.equal(both("TOD",h+"tod"+h),true,"edges");
  assert.equal(both("TOD",h+"tod"+h,"exact"),true,"exact unaffected by edge marks");
  assert.equal(both("TOD","x"+h+"tod","exact"),false);
  assert.equal(both("TO"+h+"D","tod"),true,"keyword with a hidden mark normalizes identically");
  assert.equal(both("TO"+h+"D","tod","exact"),true);
 }
 // Arabic: ZWNJ inside a word no longer splits/hides it
 assert.equal(both("اشتراكات","كم اشترا‌كات"),true);
 assert.equal(both("اشتراك","اشترا‌كات"),false,"still the longer word, no boundary created");
});

// ============================================ Arabic prefixes / suffixes (no stemming)
test("Arabic: prefixed/suffixed/digit forms are different words in BOTH modes and BOTH copies",()=>{
 const kw="اشتراكات";
 const forms=["الاشتراكات","واشتراكات","باشتراكات","لاشتراكات","كاشتراكات","فاشتراكات","اشتراكاتي","اشتراكاتها","اشتراكات٢","اشتراكات2","اشتراك"];
 for(const f of forms){
  assert.equal(both(kw,f),false,"contains "+f);
  assert.equal(both(kw,"كم "+f+" ؟"),false,"contains in a sentence "+f);
  assert.equal(both(kw,f,"exact"),false,"exact "+f);
 }
 assert.equal(both(kw,"كم اشتراكات ؟"),true);
 assert.equal(both(kw,"اشتراكات","exact"),true);
 assert.equal(both("اشتراك","اشتراكات"),false,"«اشتراكات» never equals «اشتراك»");
 assert.equal(both("اشتراك","اشتراكات","exact"),false);
 assert.equal(both("مدرسة","مدرسه"),false,"no ة/ه folding");
 assert.equal(both("٢","2"),false,"no digit folding");
 // customers list the variants explicitly
 assert.equal(both("اشتراكات، الاشتراكات، اشتراكاتي","هل اشتراكاتي فعالة"),true);
});

// ============================================ D-2: explicit list limits
test("D-2: 40 keywords ok, 41 rejected; 120 chars ok, 121 rejected; counted after de-duplication; both copies",()=>{
 const list=(n:number)=>Array.from({length:n},(_,i)=>"kw"+i).join(", ");
 assert.equal(MAX_TRIGGER_KEYWORDS,40);assert.equal(MAX_TRIGGER_KEYWORD_LENGTH,120);
 for(const [raw,expected] of [
  [list(40),null],[list(41),"keyword_trigger_too_many_keywords"],
  [list(40)+", KW0, kw1 ,kw2",null],          // duplicates after normalization do not count
  ["a".repeat(120),null],["a".repeat(121),"keyword_trigger_keyword_too_long"],
  ["ok, "+"b".repeat(121),"keyword_trigger_keyword_too_long"],
  ["a".repeat(120)+"\u200B",null], // the hidden character is removed before counting
  ["",'keyword_trigger_requires_keywords'],[" , ، ",'keyword_trigger_requires_keywords']
 ] as Array<[string,string|null]>){
  assert.equal(keywordListProblem(raw),expected,raw.slice(0,30));
  assert.equal(clientListProblem(raw),expected,"client "+raw.slice(0,30));
 }
 // runtime: never matches / never selected, even on a valid keyword of the list
 assert.equal(both(list(41),"kw0"),false);
 assert.equal(both("ok, "+"b".repeat(121),"ok"),false);
 assert.equal(both(list(40),"kw39"),true);
 const t={kind:"trigger",platform:"instagram",triggerMode:"keyword",keywords:list(41)};
 assert.equal(keywordTriggerProblem(t),"keyword_trigger_too_many_keywords");
 assert.equal(simpleFlowDocumentSupported(v2Doc(t),"instagram"),false,"V2 never selects it");
 assert.equal(supportedDurableDocument(buttonsDoc(t)),false,"durable never starts it");
 // the editor model reports it explicitly (no silent truncation on import either)
});
test("D-2: publish 422 with a clear message; activate 422 for a stored invalid list",async()=>{
 for(const [k,msg] of [[Array.from({length:41},(_,i)=>"k"+i).join(","),"Keyword trigger has more than 40 keywords"],
   ["ok, "+"z".repeat(121),"Keyword trigger keyword is longer than 120 characters"]] as const){
  const r=await call({},{action:"publish",document:modelDoc("keyword",k)});
  assert.equal(r.status,422);assert.equal(r.body.error,msg);assert.ok(!r.rpcs.includes("flow_publish_revision"));
  const a=await call({},{action:"activate",revision:7},modelDoc("keyword",k));
  assert.equal(a.status,422);assert.ok(!a.rpcs.includes("flow_activate_revision"));
 }
 const ok=await call({},{action:"publish",document:modelDoc("keyword",Array.from({length:40},(_,i)=>"k"+"x".repeat(100)+i).join(","))});
 assert.equal(ok.status,200,"a valid 40 x 102-char list is published untruncated");
});

// ============================================ C-3: one text cap
test("C-3: one inbound text cap (4096) for ingress, selection/matching (both copies) and the V2 runtime",async()=>{
 assert.equal(MAX_INBOUND_TEXT,4096);assert.equal(MAX_TRIGGER_TEXT_SERVER(),4096);
 assert.equal(CLIENT_MAX_TEXT,MAX_INBOUND_TEXT);assert.equal(INGRESS_MAX_TEXT,MAX_INBOUND_TEXT);
 const at="x".repeat(MAX_INBOUND_TEXT-4)+" tod",over="x".repeat(MAX_INBOUND_TEXT-3)+" tod";
 assert.equal(at.length,4096);assert.equal(over.length,4097);
 assert.equal(both("TOD",at),true);assert.equal(both("TOD",over),false);
 const doc=v2Doc(kwTrigger("TOD"),"R");
 assert.equal(simpleMessageFromDocument(doc,"instagram",at),"R","a selected winner is answered at the limit");
 assert.equal(simpleMessageFromDocument(doc,"instagram",over),null);
 const msgDoc=v2Doc(messageTrigger,"M");
 assert.equal(simpleMessageFromDocument(msgDoc,"instagram","y".repeat(4096)),"M");
 assert.equal(simpleMessageFromDocument(msgDoc,"instagram","y".repeat(4097)),null);
 // selection and runtime agree at the boundary: the winner is never dropped to the AI
 const {chooseInboundFlow}=await import("../supabase/functions/milan-api/flowInboundSelection.ts");
 const classify=(d:unknown)=>simpleFlowDocumentSupported(d,"instagram")?"v2" as const:null;
 for(const text of [at,"y".repeat(4096)]){
  const w=chooseInboundFlow([{flowKey:"a",revision:1,activatedAt:null,document:doc},{flowKey:"b",revision:1,activatedAt:null,document:msgDoc}],text,classify);
  assert.ok(w);assert.notEqual(simpleMessageFromDocument(w!.document,"instagram",text),null,"winner answers");
 }
});
const MAX_TRIGGER_TEXT_SERVER=()=>MAX_INBOUND_TEXT;

// ============================================ A-2: capabilities and gates
test("A-2: trigger:keyword is in the production V2 set and follows trigger:message for the canary; no channel is opened",async()=>{
 const src=readFileSync("supabase/functions/flow-publication/activationGates.ts","utf8");
 assert.match(src,/new Set<FlowCapability>\(\["execution-engine","instagram","trigger:message","trigger:keyword","message:text","condition"\]\)/);
 assert.deepEqual([...withKeywordTrigger(new Set(["trigger:message"] as any))].sort(),["trigger:keyword","trigger:message"]);
 // Facebook / WhatsApp keyword flows: V2 off without FLOW_RUNTIME_MODE=message_only, durable off without multichannel
 await withEnv({},async()=>{
  for(const platform of ["facebook","whatsapp"] as const){
   const db={from:()=>{throw Error("no db");}} as any;
   assert.equal(await prepareSimpleFlowReply(db,T.a,A.a,platform,"TOD"),null,platform);
   assert.equal(await attemptDurableInstagram(db,ev({platform,text:"TOD"})),"fallback",platform);
  }
 });
 await withEnv({...canary},async()=>{
  const db={from:()=>{throw Error("no db");},rpc:()=>{throw Error("no rpc");}} as any;
  for(const platform of ["facebook","whatsapp"])
   assert.equal(await attemptDurableInstagram(db,ev({platform,text:"TOD"})),"fallback","multichannel gate still off: "+platform);
 });
 // no gate default changed in the source
 const ingress=readFileSync("supabase/functions/milan-api/flowDurableIngress.ts","utf8");
 assert.match(ingress,/return Deno\.env\.get\("FLOW_MULTICHANNEL_ENABLED"\)==="true";/);
 const v2=readFileSync("supabase/functions/milan-api/flowPrepareMessage.ts","utf8");
 assert.match(v2,/if\(platform!=="instagram"\)return null;/);
});
test("D-2: editor model validation reports the list problems in Arabic+English; a valid long list is never truncated on import",async()=>{
 const {validateDocument,importFlow}=await import("../src/flow/model.ts");
 const msgs=(k:string)=>validateDocument(modelDoc("keyword",k)).filter(i=>i.severity==="error").map(i=>i.message).join(" | ");
 assert.match(msgs(Array.from({length:41},(_,i)=>"k"+i).join(",")),/أكثر من 40.*More than 40 keywords/);
 assert.match(msgs("ok, "+"z".repeat(121)),/أطول من 120.*longer than 120 characters/);
 assert.match(msgs(" , "),/أضف كلمة مفتاحية واحدة على الأقل/);
 assert.doesNotMatch(msgs(Array.from({length:40},(_,i)=>"k"+i).join(",")),/40|120|أضف كلمة/);
 const long=Array.from({length:40},(_,i)=>"k"+"x".repeat(100)+i).join(",");
 const imported=importFlow(JSON.parse(JSON.stringify(modelDoc("keyword",long))));
 assert.equal(imported!.nodes[0].data.keywords,long,"valid 40-keyword list kept intact");
 // comment triggers keep their previous 500-character import bound
 const c=JSON.parse(JSON.stringify(modelDoc("keyword","x")));c.nodes[0].data.triggerMode="comment";c.nodes[0].data.keywords="y".repeat(700);
 assert.equal(importFlow(c)!.nodes[0].data.keywords.length,500);
});
