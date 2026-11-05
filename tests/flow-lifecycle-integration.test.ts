// Flow V3/V4 lifecycle integration: inbound webhook -> exclusive claim ->
// durable ingress -> run -> outbox -> provider send -> receipt, plus wake,
// fallback, takeover, tenant isolation, crash/lease recovery and knowledge_ai.
//
// The REAL TypeScript code runs end to end: attemptDurableInstagram
// (milan-api/flowDurableIngress.ts), the flow-runtime-worker and the
// flow-outbox-worker Deno.serve handlers, with the real supabase-js client.
// supabase-js HTTP calls are answered by a thin in-test PostgREST adapter that
// executes the equivalent SQL (as service_role) on a THROWAWAY local
// PostgreSQL cluster (temporary data dir, unix socket only, listen_addresses='',
// removed afterwards) built from the repo fixture chain and migrations.
// Only external services are mocked: Meta/Instagram Graph send and OpenAI.
// No network, no secrets, no remote database. Billing is out of scope: the
// throwaway DB has a constant consume_flow_reply stub (gate simply open).
//
// Run (needs Deno + node_modules with @supabase/supabase-js and PostgreSQL
// server binaries):  deno test -A tests/flow-lifecycle-integration.test.ts
import assert from "node:assert/strict";
import {encryptMessageBody} from "../supabase/functions/flow-outbox-worker/deliveryCore.ts";
import {verifyMetaWebhookSignature} from "../supabase/functions/milan-api/metaSignature.ts";
import {persistInboundOnce} from "../supabase/functions/milan-api/persistInboundOnce.ts";
import {loadFlowReview} from "../supabase/functions/flow-delivery-review/review.ts";

const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACC="11111111-1111-4111-8111-111111111111";
const ACCB="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ACC2="dddddddd-dddd-4ddd-8ddd-dddddddddddd"; // tenant A instagram, NOT the canary
const SERVICE="svc-test-only-not-a-secret";
const FIELD_KEY="field-key-test-only";
const PG_HOST="pg.local";

// ------------------------------------------------------------ local cluster
function findPgBin():string|null{
 const c:string[]=[];
 const env=Deno.env.get("PG_BIN");if(env)c.push(env);
 try{for(const v of [...Deno.readDirSync("/usr/lib/postgresql")].map(e=>e.name).sort().reverse())
  c.push(`/usr/lib/postgresql/${v}/bin`);}catch{/* none */}
 return c.find(d=>["initdb","pg_ctl","psql"].every(b=>{try{return Deno.statSync(`${d}/${b}`).isFile;}catch{return false;}}))??null;
}
const BIN=findPgBin();
const isRoot=Deno.uid()===0;
const hasPostgresUser=!isRoot||new Deno.Command("id",{args:["-u","postgres"],stdout:"null",stderr:"null"}).outputSync().success;
const live=!!BIN&&hasPostgresUser;
const dec=(b:Uint8Array)=>new TextDecoder().decode(b);
function asServer(cmd:string,args:string[]){
 const c=isRoot?new Deno.Command("runuser",{args:["-u","postgres","--",`${BIN}/${cmd}`,...args]})
  :new Deno.Command(`${BIN}/${cmd}`,{args});
 const o=c.outputSync();
 return {ok:o.success,out:dec(o.stdout)+dec(o.stderr)};
}
let dir="",port=0,started=false,db="postgres";
async function psql(database:string,sql:string,role?:string){
 const p=new Deno.Command(`${BIN}/psql`,{args:["-X","-q","-v","ON_ERROR_STOP=1","-v","VERBOSITY=verbose",
  "-h",dir,"-p",String(port),"-U","postgres","-d",database,"-tA"],
  stdin:"piped",stdout:"piped",stderr:"piped"}).spawn();
 const w=p.stdin.getWriter();
 await w.write(new TextEncoder().encode((role?`SET ROLE ${role};\n`:"")+sql+"\n"));
 await w.close();
 const o=await p.output();
 return {ok:o.success,out:dec(o.stdout),err:dec(o.stderr)};
}
async function exec(sql:string,database=db){
 const r=await psql(database,sql);
 if(!r.ok)throw Error("SQL failed: "+r.err+"\n"+sql.slice(0,400));
}
async function rows<T=Record<string,unknown>>(query:string,role?:string):Promise<T[]>{
 const r=await psql(db,`SELECT '@@'||coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb)::text FROM (${query}) x;`,role);
 if(!r.ok)throw Error("SQL failed: "+r.err+"\n"+query);
 return JSON.parse(r.out.split("\n").find(l=>l.startsWith("@@"))!.slice(2));
}
async function val<T=unknown>(query:string,role?:string):Promise<T>{
 const r=await rows<{v:T}>(`SELECT (${query}) AS v`,role);return r[0]?.v as T;
}
const sqlError=(err:string)=>{
 const m=err.match(/ERROR:\s+([0-9A-Z]{5}):\s+([^\n]*)/);
 return m?{code:m[1],message:m[2]}:{code:"XX000",message:err.split("\n")[0]??"error"};
};

// ------------------------------------------------- PostgREST-over-psql shim
const ident=(s:string)=>{
 if(!/^[a-z_][a-z0-9_]*$/.test(s))throw Error("unsafe identifier "+s);return `"${s}"`;
};
const lit=(v:unknown):string=>v===null||v===undefined?"NULL":
 typeof v==="object"?`'${JSON.stringify(v).replace(/'/g,"''")}'`:`'${String(v).replace(/'/g,"''")}'`;
function filterSql(col:string,raw:string):string{
 const i=raw.indexOf(".");const op=raw.slice(0,i),v=raw.slice(i+1);
 const c=ident(col);
 const ops:Record<string,string>={eq:"=",neq:"<>",lt:"<",lte:"<=",gt:">",gte:">="};
 if(ops[op])return `${c} ${ops[op]} ${lit(v)}`;
 if(op==="is")return `${c} IS ${v==="null"?"NULL":v==="true"?"TRUE":"FALSE"}`;
 if(op==="in"){
  const list=v.replace(/^\(|\)$/g,"").split(",").map(x=>x.replace(/^"|"$/g,""));
  return list.length?`${c} IN (${list.map(lit).join(",")})`:"FALSE";
 }
 throw Error("unsupported filter "+raw);
}
const pgResponse=(status:number,body:unknown)=>new Response(body===undefined?null:JSON.stringify(body),
 {status,headers:{"content-type":"application/json"}});
function pgError(err:string){
 const e=sqlError(err);
 const status=e.code==="23505"?409:e.code==="42501"?403:e.code==="42703"||e.code==="42P01"?400:400;
 return pgResponse(status,{code:e.code,message:e.message,details:null,hint:null});
}
const rpcMeta=new Map<string,{set:boolean;comp:boolean}|null>();
export const restLog:string[]=[];
async function postgrest(req:Request):Promise<Response>{
 const url=new URL(req.url);
 const path=url.pathname.replace(/^\/rest\/v1\//,"");
 const text=req.method==="GET"?"":await req.text();
 const body=text?JSON.parse(text):{};
 restLog.push(req.method+" "+path);
 if(path.startsWith("rpc/")){
  const name=path.slice(4);ident(name);
  if(!rpcMeta.has(name)){
   const m=await rows<{set:boolean;comp:boolean}>(`SELECT p.proretset AS set,
    (t.typtype='c' OR p.prorettype='record'::regtype) AS comp FROM pg_proc p
    JOIN pg_type t ON t.oid=p.prorettype WHERE p.proname=${lit(name)}
    AND p.pronamespace='public'::regnamespace LIMIT 1`);
   rpcMeta.set(name,m[0]??null);
  }
  const meta=rpcMeta.get(name);
  if(!meta)return pgResponse(404,{code:"PGRST202",message:"function not found",details:null,hint:null});
  const args=Object.entries(body).map(([k,v])=>`${ident(k)} => ${lit(v)}`).join(",");
  const call=`public.${ident(name)}(${args})`;
  const q=meta.set?`SELECT '@@'||coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb)::text FROM ${call} r;`:
   meta.comp?`SELECT '@@'||to_jsonb(r)::text FROM ${call} r;`:
   `SELECT '@@'||coalesce(to_jsonb(${call}),'null'::jsonb)::text;`;
  const r=await psql(db,q,"service_role");
  if(!r.ok)return pgError(r.err);
  return pgResponse(200,JSON.parse(r.out.split("\n").find(l=>l.startsWith("@@"))!.slice(2)));
 }
 const table=ident(path);
 let select="*",order="",limit="";const where:string[]=[];
 for(const [k,v] of url.searchParams){
  if(k==="select")select=v.split(",").map(c=>c.trim()==="*"?"*":ident(c.trim())).join(",");
  else if(k==="order")order=" ORDER BY "+v.split(",").map(o=>{
   const [c,dir,nulls]=o.split(".");
   return ident(c)+(dir==="desc"?" DESC":" ASC")+(nulls==="nullsfirst"?" NULLS FIRST":nulls==="nullslast"?" NULLS LAST":"");
  }).join(",");
  else if(k==="limit")limit=" LIMIT "+String(Number.parseInt(v,10));
  else where.push(filterSql(k,v));
 }
 const w=where.length?" WHERE "+where.join(" AND "):"";
 const wantObject=(req.headers.get("accept")??"").includes("vnd.pgrst.object");
 const wantRows=req.method==="GET"||(req.headers.get("prefer")??"").includes("return=representation");
 let q:string;
 if(req.method==="GET")
  q=`SELECT '@@'||coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb)::text FROM (SELECT ${select} FROM public.${table}${w}${order}${limit}) t;`;
 else if(req.method==="PATCH"){
  const set=Object.entries(body).map(([k,v])=>`${ident(k)}=${lit(v)}`).join(",");
  q=`WITH u AS (UPDATE public.${table} SET ${set}${w} RETURNING ${select}) SELECT '@@'||coalesce(jsonb_agg(to_jsonb(u)),'[]'::jsonb)::text FROM u;`;
 }else if(req.method==="POST"){
  const list=Array.isArray(body)?body:[body];
  const cols=Object.keys(list[0]);
  q=`WITH i AS (INSERT INTO public.${table}(${cols.map(ident).join(",")}) VALUES ${
   list.map(r=>"("+cols.map(c=>lit(r[c])).join(",")+")").join(",")} RETURNING ${select}) SELECT '@@'||coalesce(jsonb_agg(to_jsonb(i)),'[]'::jsonb)::text FROM i;`;
 }else if(req.method==="DELETE"){
  if(!where.length)return pgResponse(400,{code:"21000",message:"DELETE requires a filter",details:null,hint:null});
  q=`WITH d AS (DELETE FROM public.${table}${w} RETURNING ${select}) SELECT '@@'||coalesce(jsonb_agg(to_jsonb(d)),'[]'::jsonb)::text FROM d;`;
 }else return pgResponse(405,{code:"PGRST000",message:"unsupported",details:null,hint:null});
 const r=await psql(db,q,"service_role");
 if(!r.ok)return pgError(r.err);
 const data=JSON.parse(r.out.split("\n").find(l=>l.startsWith("@@"))!.slice(2)) as unknown[];
 if(wantObject){
  if(data.length!==1)return pgResponse(406,{code:"PGRST116",
   message:"JSON object requested, multiple (or no) rows returned",details:null,hint:null});
  return pgResponse(200,data[0]);
 }
 if(!wantRows)return new Response(null,{status:201});
 return pgResponse(req.method==="POST"?201:200,data);
}

// --------------------------------------------------- external service mocks
type MetaMode="ok"|"5xx"|"timeout"|"noid"|"400";
const meta={plan:[] as MetaMode[],calls:[] as {url:string;auth:string|null;body:any}[],n:0};
async function metaGraph(req:Request):Promise<Response>{
 const body=JSON.parse(await req.text());
 meta.calls.push({url:req.url,auth:req.headers.get("authorization"),body});
 const mode=meta.plan.shift()??"ok";
 if(mode==="timeout")throw new DOMException("The signal has been aborted","TimeoutError");
 if(mode==="5xx")return new Response('{"error":{"code":2}}',{status:503});
 if(mode==="400")return new Response('{"error":{"code":100}}',{status:400});
 if(mode==="noid")return pgResponse(200,{recipient_id:body.recipient?.id});
 return pgResponse(200,{recipient_id:body.recipient?.id,message_id:"mid.out."+(++meta.n)});
}
// plan: per chat-completion call, an HTTP status to fail with or "timeout"
// (empty = answer normally). chat counts chat-completion calls only.
type AiMode=number|"timeout";
const openai={answer:null as null|{answer:string;quote:string},calls:0,chat:0,plan:[] as AiMode[]};
async function openAI(req:Request):Promise<Response>{
 openai.calls++;
 if(new URL(req.url).pathname.endsWith("/embeddings"))
  return pgResponse(200,{data:[{embedding:[0.11,0.22,0.33]}]});
 openai.chat++;
 const mode=openai.plan.shift();
 if(mode==="timeout")throw new DOMException("The signal has been aborted","TimeoutError");
 if(typeof mode==="number")return new Response('{"error":{"message":"mock"}}',{status:mode});
 const a=openai.answer;
 return pgResponse(200,{choices:[{message:{content:JSON.stringify(a?
  {answer:a.answer,grounded:true,supporting_quote:a.quote}:
  {answer:"",grounded:false,supporting_quote:""})}}]});
}
const realFetch=globalThis.fetch;
globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
 const req=new Request(input,init);
 const host=new URL(req.url).host;
 if(host===PG_HOST)return postgrest(req);
 if(host==="graph.instagram.com"||host==="graph.facebook.com")return metaGraph(req);
 if(host==="api.openai.com")return openAI(req);
 throw new TypeError("network disabled in this test: "+host);
}) as typeof fetch;

// --------------------------------------------- real handlers under test
for(const [k,v] of Object.entries({
 SUPABASE_URL:"http://"+PG_HOST,SUPABASE_SERVICE_ROLE_KEY:SERVICE,FIELD_ENCRYPTION_KEY:FIELD_KEY,
 FLOW_WORKERS_OPERATOR_RELEASE:"production-canary-approved",FLOW_OUTBOX_SEND_ENABLED:"true",
 FLOW_ATOMIC_CONSUME_READY:"true",FLOW_DURABLE_SCHEDULER_ENABLED:"true",
 FLOW_DURABLE_INGRESS_ENABLED:"true",FLOW_DURABLE_CANARY_ACCOUNT_ID:ACC,
 FLOW_RICH_BUTTONS_ENABLED:"true",FLOW_RAG_ENABLED:"true",
 LLM_API_KEY:"llm-test-only",EMBED_API_KEY:"embed-test-only"
}))Deno.env.set(k,v);
Deno.env.delete("flow_worker_service_role_key");
type Handler=(req:Request)=>Promise<Response>;
let captured:Handler|null=null;
const realServe=Deno.serve;
(Deno as unknown as {serve:unknown}).serve=(h:unknown)=>{
 captured=(typeof h==="function"?h:(h as {handler:Handler}).handler) as Handler;
 return {finished:Promise.resolve(),shutdown:async()=>{},ref(){},unref(){},
  addr:{transport:"tcp",hostname:"127.0.0.1",port:0}};
};
await import("../supabase/functions/flow-outbox-worker/index.ts");
const outboxWorker=captured!;
await import("../supabase/functions/flow-runtime-worker/index.ts");
const runtimeWorker=captured!;
(Deno as unknown as {serve:unknown}).serve=realServe;
const {attemptDurableInstagram,selectedFlowChoice,reaskField}=await import("../supabase/functions/milan-api/flowDurableIngress.ts");
const {createClient}=await import("npm:@supabase/supabase-js@2");
const sb=createClient("http://"+PG_HOST,SERVICE,{auth:{persistSession:false,autoRefreshToken:false}});

async function tick(h:Handler,auth="Bearer "+SERVICE){
 const r=await h(new Request("http://worker.local/",{method:"POST",
  headers:{authorization:auth,"content-type":"application/json"},body:JSON.stringify({mode:"tick"})}));
 return {status:r.status,body:await r.json()};
}
const outboxTick=()=>tick(outboxWorker);
const runtimeTick=()=>tick(runtimeWorker);

// ------------------------------------------------------------- fixtures
const buttonsDoc={version:3,name:"two choices",nodes:[
 {id:"start",data:{kind:"trigger",platform:"instagram",triggerMode:"message"}},
 {id:"choose",data:{kind:"question",inputMode:"buttons",text:"اختر",image:"",contentBlocks:[],options:[
  {id:"prices",label:"الأسعار"},{id:"support",label:"المساعدة"}]}},
 {id:"yes",data:{kind:"message",text:"هذه الأسعار",image:"",options:[],contentBlocks:[]}},
 {id:"no",data:{kind:"message",text:"تواصل معنا",image:"",options:[],contentBlocks:[]}}
],edges:[
 {source:"start",target:"choose",sourceHandle:"next"},
 {source:"choose",target:"yes",sourceHandle:"prices"},
 {source:"choose",target:"no",sourceHandle:"support"}
]};
const delayDoc={version:3,name:"delay",nodes:[
 {id:"start",data:{kind:"trigger",platform:"instagram",triggerMode:"message"}},
 {id:"sleep",data:{kind:"delay",delayValue:30,delayUnit:"seconds"}},
 {id:"later",data:{kind:"message",text:"رد بعد الانتظار",image:"",options:[],contentBlocks:[]}}
],edges:[{source:"start",target:"sleep",sourceHandle:"next"},{source:"sleep",target:"later",sourceHandle:"next"}]};
// Multi-step chain: welcome -> button menu -> answer -> delay -> follow-up -> end.
const chainDoc={version:3,name:"chain",nodes:[
 {id:"start",data:{kind:"trigger",platform:"instagram",triggerMode:"message"}},
 {id:"welcome",data:{kind:"message",text:"أهلاً بك في المتجر",image:"",options:[],contentBlocks:[]}},
 {id:"menu",data:{kind:"question",inputMode:"buttons",inputField:"menu",text:"شنو تحتاج؟",image:"",contentBlocks:[],options:[
  {id:"prices",label:"الأسعار"},{id:"support",label:"المساعدة"}]}},
 {id:"ans_prices",data:{kind:"message",text:"هذه قائمة الأسعار",image:"",options:[],contentBlocks:[]}},
 {id:"ans_support",data:{kind:"message",text:"فريق الدعم معك",image:"",options:[],contentBlocks:[]}},
 {id:"wait",data:{kind:"delay",delayValue:1,delayUnit:"days"}},
 {id:"follow",data:{kind:"message",text:"هل تحتاج شيئاً آخر؟",image:"",options:[],contentBlocks:[]}},
 {id:"done",data:{kind:"end"}}
],edges:[
 {source:"start",target:"welcome",sourceHandle:"next"},{source:"welcome",target:"menu",sourceHandle:"next"},
 {source:"menu",target:"ans_prices",sourceHandle:"prices"},{source:"menu",target:"ans_support",sourceHandle:"support"},
 {source:"ans_prices",target:"wait",sourceHandle:"next"},{source:"ans_support",target:"wait",sourceHandle:"next"},
 {source:"wait",target:"follow",sourceHandle:"next"},{source:"follow",target:"done",sourceHandle:"next"}
]};
// Data collection: welcome -> email question -> thanks {{email}} -> condition on it.
const collectDoc={version:3,name:"collect",nodes:[
 {id:"start",data:{kind:"trigger",platform:"instagram",triggerMode:"message"}},
 {id:"welcome",data:{kind:"message",text:"أهلاً بك",image:"",options:[],contentBlocks:[]}},
 {id:"askEmail",data:{kind:"question",inputMode:"email",inputField:"email",text:"ما بريدك الإلكتروني؟",image:"",contentBlocks:[],options:[]}},
 {id:"thanks",data:{kind:"message",text:"شكراً، سجلنا {{email}}",image:"",options:[],contentBlocks:[]}},
 {id:"isVip",data:{kind:"condition",conditionField:"email",operator:"contains",conditionValue:"@vip."}},
 {id:"vip",data:{kind:"message",text:"عرض VIP لـ {{email}}",image:"",options:[],contentBlocks:[]}},
 {id:"std",data:{kind:"message",text:"عرض عادي",image:"",options:[],contentBlocks:[]}}
],edges:[
 {source:"start",target:"welcome",sourceHandle:"next"},{source:"welcome",target:"askEmail",sourceHandle:"next"},
 {source:"askEmail",target:"thanks",sourceHandle:"valid"},{source:"thanks",target:"isVip",sourceHandle:"next"},
 {source:"isVip",target:"vip",sourceHandle:"yes"},{source:"isVip",target:"std",sourceHandle:"no"}
]};
// Phone question -> saved {{phone}} + delay -> wake -> follow-up {{phone}} -> end.
const collectDelayDoc={version:3,name:"collect+delay",nodes:[
 {id:"start",data:{kind:"trigger",platform:"instagram",triggerMode:"message"}},
 {id:"askPhone",data:{kind:"question",inputMode:"phone",inputField:"phone",text:"ما رقم هاتفك؟",image:"",contentBlocks:[],options:[]}},
 {id:"saved",data:{kind:"message",text:"تم حفظ رقمك {{phone}}",image:"",options:[],contentBlocks:[]}},
 {id:"wait",data:{kind:"delay",delayValue:1,delayUnit:"hours"}},
 {id:"follow",data:{kind:"message",text:"سنتصل بك على {{phone}}",image:"",options:[],contentBlocks:[]}},
 {id:"done",data:{kind:"end"}}
],edges:[
 {source:"start",target:"askPhone",sourceHandle:"next"},{source:"askPhone",target:"saved",sourceHandle:"valid"},
 {source:"saved",target:"wait",sourceHandle:"next"},{source:"wait",target:"follow",sourceHandle:"next"},
 {source:"follow",target:"done",sourceHandle:"next"}
]};

// Internal actions: welcome -> email question -> tag -> notify {{email}} -> handoff message -> handoff.
const handoffDoc={version:3,name:"lead handoff",nodes:[
 {id:"start",data:{kind:"trigger",platform:"instagram",triggerMode:"message"}},
 {id:"welcome",data:{kind:"message",text:"أهلاً بك",image:"",options:[],contentBlocks:[]}},
 {id:"askEmail",data:{kind:"question",inputMode:"email",inputField:"email",text:"ما بريدك الإلكتروني؟",image:"",contentBlocks:[],options:[]}},
 {id:"tagLead",data:{kind:"action",actionType:"tag",actionValue:"lead"}},
 {id:"notify",data:{kind:"action",actionType:"notify",actionValue:"عميل جديد {{email}}"}},
 {id:"bye",data:{kind:"message",text:"سيتواصل معك موظف الآن",image:"",options:[],contentBlocks:[]}},
 {id:"human",data:{kind:"action",actionType:"handoff",actionValue:""}}
],edges:[
 {source:"start",target:"welcome",sourceHandle:"next"},{source:"welcome",target:"askEmail",sourceHandle:"next"},
 {source:"askEmail",target:"tagLead",sourceHandle:"valid"},{source:"tagLead",target:"notify",sourceHandle:"next"},
 {source:"notify",target:"bye",sourceHandle:"next"},{source:"bye",target:"human",sourceHandle:"next"}
]};

// Production live-only columns (schema.sql / omnichannel / human_agent migrations).
const LIVE_COLUMNS=`
ALTER TABLE public.tenants ADD COLUMN is_active boolean NOT NULL DEFAULT true,
 ADD COLUMN business_name text NOT NULL DEFAULT 'Test Store';
ALTER TABLE public.channel_accounts ADD COLUMN is_active boolean NOT NULL DEFAULT true,
 ADD COLUMN agent_enabled boolean NOT NULL DEFAULT true,ADD COLUMN auto_reply boolean NOT NULL DEFAULT true,
 ADD COLUMN external_id text,ADD COLUMN access_token_encrypted text;
ALTER TABLE public.conversations ADD COLUMN transferred boolean NOT NULL DEFAULT false,
 ADD COLUMN auto_paused_reason text,ADD COLUMN human_agent_expires_at timestamptz;
ALTER TABLE public.messages ADD COLUMN body_encrypted text,ADD COLUMN external_message_id text;
ALTER TABLE public.automation_flow_tenant_switches
 ADD COLUMN production_approved boolean NOT NULL DEFAULT false;
`;
async function seed(){
 const tokA=await encryptMessageBody("IGA-token-test",FIELD_KEY);
 const tokB=await encryptMessageBody("IGB-token-test",FIELD_KEY);
 return `
INSERT INTO public.channel_accounts(id,tenant_id,platform,channel) VALUES('${ACCB}','${B}','instagram','instagram');
UPDATE public.channel_accounts SET external_id='17841400000000001',access_token_encrypted='${tokA}' WHERE id='${ACC}';
UPDATE public.channel_accounts SET external_id='17841400000000002',access_token_encrypted='${tokB}' WHERE id='${ACCB}';
INSERT INTO public.automation_flow_publications(tenant_id,flow_key,revision,channel_account_id,platform,document,published_by)
VALUES('${A}','buttons',1,'${ACC}','instagram',${lit(buttonsDoc)},'88888888-8888-4888-8888-888888888888'),
      ('${A}','delay',1,'${ACC}','instagram',${lit(delayDoc)},'88888888-8888-4888-8888-888888888888'),
      ('${A}','chain',1,'${ACC}','instagram',${lit(chainDoc)},'88888888-8888-4888-8888-888888888888'),
      ('${A}','collect',1,'${ACC}','instagram',${lit(collectDoc)},'88888888-8888-4888-8888-888888888888'),
      ('${A}','collectdelay',1,'${ACC}','instagram',${lit(collectDelayDoc)},'88888888-8888-4888-8888-888888888888'),
      ('${A}','handoff',1,'${ACC}','instagram',${lit(handoffDoc)},'88888888-8888-4888-8888-888888888888'),
      ('${B}','bflow',1,'${ACCB}','instagram',${lit(buttonsDoc)},'88888888-8888-4888-8888-888888888888');
INSERT INTO public.automation_flow_activations(tenant_id,channel_account_id,platform,flow_key,revision,is_active)
VALUES('${A}','${ACC}','instagram','buttons',1,false),('${A}','${ACC}','instagram','delay',1,false),
      ('${A}','${ACC}','instagram','chain',1,false),
      ('${A}','${ACC}','instagram','collect',1,false),('${A}','${ACC}','instagram','collectdelay',1,false),
      ('${A}','${ACC}','instagram','handoff',1,false),
      ('${B}','${ACCB}','instagram','bflow',1,true);
INSERT INTO public.automation_flow_tenant_switches(tenant_id,enabled,test_only,production_approved)
VALUES('${A}',true,true,true),('${B}',true,true,true)
ON CONFLICT(tenant_id) DO UPDATE SET enabled=true,test_only=true,production_approved=true;
UPDATE public.automation_flow_global_switch SET enabled=true;
GRANT SELECT,INSERT,UPDATE ON public.tenants,public.channel_accounts,public.conversations,public.messages TO service_role;
GRANT SELECT ON public.automation_message_claims,public.automation_flow_delivery_attempts TO service_role;
-- RAG stubs with the production RPC/column names used by flowKnowledge.ts.
CREATE TABLE public.knowledge_sources(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,status text NOT NULL);
CREATE TABLE public.knowledge_chunks(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,content text NOT NULL,source_id uuid);
CREATE FUNCTION public.match_knowledge(p_tenant_id uuid,p_query text,p_limit integer,p_threshold double precision)
RETURNS TABLE(id uuid,content text,similarity double precision) LANGUAGE sql STABLE AS $f$
 SELECT c.id,c.content,0.9::double precision FROM public.knowledge_chunks c
 WHERE c.tenant_id=p_tenant_id ORDER BY c.id LIMIT p_limit$f$;
GRANT SELECT ON public.knowledge_sources,public.knowledge_chunks TO service_role;
GRANT EXECUTE ON FUNCTION public.match_knowledge(uuid,text,integer,double precision) TO service_role;
-- Billing is excluded from this suite: constant stub, gate simply open.
CREATE FUNCTION public.consume_flow_reply(p_tenant_id uuid,p_message_id uuid)
RETURNS integer LANGUAGE sql AS $f$SELECT 4$f$;
GRANT EXECUTE ON FUNCTION public.consume_flow_reply(uuid,uuid) TO service_role;
CREATE SCHEMA it;
CREATE FUNCTION it.conv(p_tenant uuid,p_acc uuid,p_psid text) RETURNS uuid LANGUAGE sql AS $f$
 INSERT INTO public.conversations(id,tenant_id,account_id,wa_chat_id)
 VALUES(gen_random_uuid(),p_tenant,p_acc,'instagram:'||p_psid) RETURNING id$f$;
-- Same row milan-api persistInboundOnce writes before any routing.
CREATE FUNCTION it.inbound(p_tenant uuid,p_conv uuid,p_mid text) RETURNS uuid LANGUAGE sql AS $f$
 INSERT INTO public.messages(tenant_id,conversation_id,direction,wa_message_id)
 VALUES(p_tenant,p_conv,'in',p_mid) RETURNING id$f$;
`;
}
const CHAIN=[
 "tests/sql/fixtures/installed-flow-switches.sql","tests/sql/fixtures/installed-flow-runtime.sql",
 "tests/sql/flow-exclusive-claim-bootstrap.sql","@LIVE",
 "supabase/migrations/20261028220000_webhook_exclusive_claim.sql",
 "supabase/migrations/20261028224000_delivery_attempts.sql",
 "supabase/migrations/20261028225000_flow_runtime_advance.sql",
 "supabase/migrations/20261028226000_flow_outbox_delivery_attempts.sql",
 // Staff memberships + internal effect tables (flow_conversation_tags,
 // flow_staff_notifications) used by the internal executor; the bootstrap
 // adds the auth.users stub and tenants.user_id (owner) they reference.
 "tests/sql/flow-staff-membership-bootstrap.sql",
 "supabase/migrations/20261028227000_tenant_staff_memberships.sql",
 "supabase/migrations/20261028228000_flow_internal_actions.sql",
 // Durable start/button RPCs (bodies identical to the former proposal step).
 "supabase/migrations/20261029125000_flow_durable_button_run.sql",
 "supabase/migrations/20261029130000_flow_run_lifecycle.sql",
 "supabase/migrations/20261029140000_flow_outbox_ai_retry.sql",
 "supabase/migrations/20261029150000_flow_takeover_resume.sql",
 "supabase/migrations/20261029160000_flow_credits_pause.sql",
 "supabase/migrations/20261029170000_flow_canary_claim_durable.sql",
 // Final durable start/button bodies (resume flag re-check, claim conversation check).
 "supabase/migrations/20261029180000_flow_durable_button_run_guards.sql"
];
const repo=new URL("..",import.meta.url).pathname;
let dbSeq=0;
async function freshDb(){
 const name="lc_"+(++dbSeq);
 await exec(`CREATE DATABASE ${name} TEMPLATE lifecycle_base;`,"postgres");
 db=name;
}
// Every event here carries a provider mid, so the explicit provenance flag is
// true; id-less deliveries (B1 step 7) pass false like milan-api/index.ts.
const ev=(conv:string,inbound:string,eventId:string,choice?:string|null,tenant=A,acc=ACC,genuine=true)=>({
 tenantId:tenant,accountId:acc,conversationId:conv,inboundId:inbound,eventId,platform:"instagram",
 providerEventIdGenuine:genuine,...(choice===undefined?{}:{selectedChoiceId:choice})});
async function conv(psid:string,tenant=A,acc=ACC){return await val<string>(`SELECT it.conv('${tenant}','${acc}','${psid}')`);}
async function inbound(c:string,mid:string,tenant=A){return await val<string>(`SELECT it.inbound('${tenant}','${c}','${mid}')`);}
const runsOf=(c:string)=>rows<{id:string;run_status:string;current_node_id:string;ended_reason:string|null}>(
 `SELECT id,run_status,current_node_id,ended_reason FROM public.automation_flow_runs WHERE conversation_id='${c}' ORDER BY updated_at,id`);
const effectsOf=(c:string)=>rows<{id:string;effect_kind:string;delivery_status:string;cancel_reason:string|null;
 provider_message_id:string|null;payload:any;outgoing_message_id:string}>(
 `SELECT o.id,o.effect_kind,o.delivery_status,o.cancel_reason,o.provider_message_id,o.payload,o.outgoing_message_id
  FROM public.automation_flow_outbox o JOIN public.automation_flow_runs r ON r.tenant_id=o.tenant_id AND r.id=o.run_id
  WHERE r.conversation_id='${c}' ORDER BY o.created_at,o.id`);
const activate=(flow:string,on:boolean)=>exec(`UPDATE public.automation_flow_activations SET is_active=${on}
 WHERE tenant_id='${A}' AND channel_account_id='${ACC}' AND flow_key='${flow}';`);
const resetMeta=()=>{meta.plan=[];meta.calls=[];};
// Inbound text as milan-api/index.ts passes it (customerText) to the durable path.
const evText=(conv:string,inbound:string,eventId:string,text:string,choice?:string|null)=>
 ({...ev(conv,inbound,eventId,choice),text});
// A NEW handler instance of a worker (fresh module evaluation = process restart).
async function freshHandler(path:string,tag:string):Promise<Handler>{
 let h:Handler|null=null;
 (Deno as unknown as {serve:unknown}).serve=(x:unknown)=>{
  h=(typeof x==="function"?x:(x as {handler:Handler}).handler) as Handler;
  return {finished:Promise.resolve(),shutdown:async()=>{},ref(){},unref(){},
   addr:{transport:"tcp",hostname:"127.0.0.1",port:0}};
 };
 try{await import(path+"?instance="+tag);}finally{(Deno as unknown as {serve:unknown}).serve=realServe;}
 assert.ok(h,"handler captured");
 return h!;
}
const runRow=(c:string)=>rows<{run_status:string;current_node_id:string;step_count:number;variables:Record<string,string>;ended_reason:string|null}>(
 `SELECT run_status,current_node_id,step_count,variables,ended_reason FROM public.automation_flow_runs WHERE conversation_id='${c}' ORDER BY updated_at,id`);
const sentTexts=()=>meta.calls.map(x=>x.body.message.text);

// ---------------------------------------------------------------- tests
Deno.test({name:"flow V3/V4 lifecycle integration (real handlers + throwaway PostgreSQL)",
 ignore:!live,sanitizeOps:false,sanitizeResources:false},async t=>{
 dir=await Deno.makeTempDir({prefix:"flow-lifecycle-pg-"});
 try{
  if(isRoot){
   const id=(f:string)=>Number(dec(new Deno.Command("id",{args:[f,"postgres"]}).outputSync().stdout));
   Deno.chownSync(dir,id("-u"),id("-g"));
  }
  port=20000+((Deno.pid+29)%20000);
  let r=asServer("initdb",["-D",dir+"/data","-U","postgres","--auth=trust","-E","UTF8","--no-locale"]);
  assert.ok(r.ok,r.out);
  r=asServer("pg_ctl",["-D",dir+"/data","-l",dir+"/server.log","-w","-o",
   `-c listen_addresses='' -k ${dir} -p ${port} -c fsync=off`,"start"]);
  assert.ok(r.ok,r.out);
  started=true;
  await exec("CREATE DATABASE lifecycle_base;","postgres");
  await exec(Deno.readTextFileSync(repo+"tests/sql/fixtures/flow-live-shape-bootstrap.sql"),"lifecycle_base");
  for(const f of CHAIN)
   await exec(f==="@LIVE"?LIVE_COLUMNS:Deno.readTextFileSync(repo+f),"lifecycle_base");
  await exec(await seed(),"lifecycle_base");

  await t.step("webhook -> claim -> durable question -> outbox send -> receipt; tap resumes the right branch; duplicates and stale taps are inert",async()=>{
   await freshDb();resetMeta();await activate("buttons",true);
   const c=await conv("1000001");
   const m1=await inbound(c,"mid.in.1");
   // Same webhook delivered twice concurrently: one claim, one run, one effect.
   assert.deepEqual(await Promise.all([attemptDurableInstagram(sb,ev(c,m1,"mid.in.1",null)),
    attemptDurableInstagram(sb,ev(c,m1,"mid.in.1",null))]),["handled","handled"]);
   let runs=await runsOf(c);
   assert.equal(runs.length,1);
   assert.equal(runs[0].run_status,"awaiting_input");assert.equal(runs[0].current_node_id,"choose");
   assert.equal(await val(`SELECT count(*)::int FROM public.automation_message_claims WHERE provider_event_id='mid.in.1' AND route='flow'`),1);
   let fx=await effectsOf(c);
   assert.equal(fx.length,1);assert.equal(fx[0].effect_kind,"question");assert.equal(fx[0].delivery_status,"pending");
   // A later re-delivery of the same Meta event stops at the inbound unique index
   // (milan-api persistInboundOnce -> "duplicate") before any routing.
   const dup=await psql(db,`SELECT it.inbound('${A}','${c}','mid.in.1');`);
   assert.equal(dup.ok,false);assert.equal(sqlError(dup.err).code,"23505");
   // Worker sends the question exactly once and records the receipt.
   let o=await outboxTick();
   assert.equal(o.status,200);assert.equal(o.body.status.settled,1,JSON.stringify(o.body));
   assert.equal(meta.calls.length,1);
   assert.equal(meta.calls[0].url,"https://graph.instagram.com/v21.0/me/messages");
   assert.equal(meta.calls[0].auth,"Bearer IGA-token-test");
   assert.equal(meta.calls[0].body.recipient.id,"1000001");
   assert.deepEqual(meta.calls[0].body.message.quick_replies.map((q:any)=>q.payload),
    ["flow-choice:prices","flow-choice:support"]);
   fx=await effectsOf(c);
   assert.equal(fx[0].delivery_status,"settled");assert.equal(fx[0].provider_message_id,"mid.out.1");
   assert.deepEqual(await rows(`SELECT status,provider_message_id FROM public.automation_flow_delivery_attempts WHERE outbox_id='${fx[0].id}'`),
    [{status:"confirmed",provider_message_id:"mid.out.1"}]);
   assert.deepEqual(await rows(`SELECT direction,wa_message_id,is_auto FROM public.messages WHERE id='${fx[0].outgoing_message_id}'`),
    [{direction:"out",wa_message_id:"mid.out.1",is_auto:true}]);
   o=await outboxTick();assert.equal(meta.calls.length,1,"settled effect never re-sent");
   // Valid tap resumes the SAME run on the tapped branch.
   const m2=await inbound(c,"mid.in.2");
   assert.equal(await attemptDurableInstagram(sb,ev(c,m2,"mid.in.2","prices")),"handled");
   runs=await runsOf(c);
   assert.equal(runs.length,1);assert.equal(runs[0].run_status,"completed");assert.equal(runs[0].current_node_id,"yes");
   o=await outboxTick();
   assert.equal(meta.calls.length,2);
   assert.equal(meta.calls[1].body.message.text,"هذه الأسعار");
   assert.equal(meta.calls[1].body.message.quick_replies,undefined);
   // A stale tap after completion never starts a new run or sends anything.
   const m3=await inbound(c,"mid.in.3");
   assert.equal(await attemptDurableInstagram(sb,ev(c,m3,"mid.in.3","support")),"handled");
   assert.equal((await runsOf(c)).length,1);assert.equal((await effectsOf(c)).length,2);
   await outboxTick();assert.equal(meta.calls.length,2);
  });

  await t.step("signed webhook: real HMAC check, real persistInboundOnce on the messages unique index; replays (sequential/concurrent/late), duplicate and out-of-order taps give one claim, one run, one reply each",async()=>{
   await freshDb();resetMeta();await activate("buttons",true);
   // milan-api/index.ts order for an Instagram message (its Deno.serve handler
   // cannot be imported offline: top-level npm:cheerio): verifyMetaSignature
   // -> persistInboundOnce(messages insert) -> only when "saved":
   // attemptDurableInstagram with selectedFlowChoice(message). Same real units here.
   const SECRET="ig-app-secret-test-only";
   const enc=new TextEncoder();
   const sign=async(raw:string,secret=SECRET)=>{
    const key=await crypto.subtle.importKey("raw",enc.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
    return "sha256="+[...new Uint8Array(await crypto.subtle.sign("HMAC",key,enc.encode(raw)))]
     .map(b=>b.toString(16).padStart(2,"0")).join("");
   };
   const hook=(psid:string,mid:string,text:string,payload?:string)=>JSON.stringify({object:"instagram",entry:[{
    id:"17841400000000001",time:1,messaging:[{sender:{id:psid},recipient:{id:"17841400000000001"},timestamp:1,
     message:{mid,text,...(payload?{quick_reply:{payload}}:{})}}]}]});
   const secrets=["",SECRET]; // INSTAGRAM_APP_SECRET unset, META_APP_SECRET set (index.ts order)
   const c=await conv("1100001"),c2=await conv("1100002");
   const deliver=async(conversation:string,raw:string,sig:string|null)=>{
    if(!await verifyMetaWebhookSignature(raw,sig??"",secrets))return "rejected";
    const msg=JSON.parse(raw).entry[0].messaging[0].message;
    let id:string|null=null;
    const stored=await persistInboundOnce(async()=>{
     const r=await sb.from("messages").insert({conversation_id:conversation,tenant_id:A,direction:"in",
      body_encrypted:await encryptMessageBody(msg.text,FIELD_KEY),kind:"customer",is_auto:false,
      wa_message_id:msg.mid}).select("id").single();
     if(!r.error&&typeof r.data?.id==="string")id=r.data.id;
     return r;
    });
    if(stored!=="saved")return stored;
    return await attemptDurableInstagram(sb,ev(conversation,id!,msg.mid,selectedFlowChoice(msg)));
   };
   const count=(table:string,mid:string,col="provider_event_id")=>
    val<number>(`SELECT count(*)::int FROM public.${table} WHERE ${col}='${mid}'`);
   const raw1=hook("1100001","mid.idem.1","hello"),sig1=await sign(raw1);
   // HMAC: tampered body, wrong secret, missing/malformed header -> nothing stored or routed.
   assert.equal(await deliver(c,raw1.replace('"hello"','"hellO"'),sig1),"rejected","tampered body");
   assert.equal(await deliver(c,raw1,await sign(raw1,"other-app-secret")),"rejected","wrong secret");
   assert.equal(await deliver(c,raw1,null),"rejected","missing header");
   assert.equal(await deliver(c,raw1,"sha1="+sig1.slice(7,47)),"rejected","legacy sha1 header");
   assert.equal(await deliver(c,raw1,sig1),"handled","valid signature");
   assert.equal(await count("messages","mid.idem.1","wa_message_id"),1);
   // Meta retries the identical signed body: HMAC passes again (no replay protection
   // in HMAC itself); the messages unique index stops it before any routing.
   assert.equal(await deliver(c,raw1,sig1),"duplicate","sequential replay");
   assert.deepEqual((await Promise.all([deliver(c,raw1,sig1),deliver(c,raw1,sig1)])),["duplicate","duplicate"]);
   // Concurrent first delivery of a NEW event: exactly one "saved" -> one route.
   const raw2=hook("1100002","mid.idem.2","hi"),sig2=await sign(raw2);
   assert.deepEqual((await Promise.all([deliver(c2,raw2,sig2),deliver(c2,raw2,sig2)])).sort(),["duplicate","handled"]);
   for(const [cv,mid] of [[c,"mid.idem.1"],[c2,"mid.idem.2"]]){
    assert.equal(await count("messages",mid,"wa_message_id"),1,mid);
    assert.equal(await count("automation_message_claims",mid),1,mid);
    const runs=await runsOf(cv);
    assert.deepEqual(runs.map(r=>[r.run_status,r.current_node_id]),[["awaiting_input","choose"]],mid);
    assert.equal((await effectsOf(cv)).length,1,mid);
   }
   await outboxTick();
   assert.equal(meta.calls.length,2,"one question per conversation");
   // Late replay reaching the durable ingress again for the SAME already-claimed
   // trigger event (e.g. a handler retried after persisting): no new claim, run or reply,
   // and the waiting run is NOT ended by its own trigger event.
   const m1=await val<string>(`SELECT id FROM public.messages WHERE wa_message_id='mid.idem.1'`);
   assert.equal(await attemptDurableInstagram(sb,ev(c,m1,"mid.idem.1",null)),"handled");
   assert.deepEqual((await runsOf(c)).map(r=>[r.run_status,r.current_node_id]),[["awaiting_input","choose"]],
    "late replay of the trigger event keeps the run waiting");
   assert.equal(await count("automation_message_claims","mid.idem.1"),1);
   // Duplicate tap (Meta delivers the same quick-reply event twice, concurrently and later).
   const tap=hook("1100001","mid.idem.tap","prices","flow-choice:prices"),tapSig=await sign(tap);
   assert.deepEqual((await Promise.all([deliver(c,tap,tapSig),deliver(c,tap,tapSig)])).sort(),["duplicate","handled"]);
   assert.equal(await deliver(c,tap,tapSig),"duplicate");
   const mTap=await val<string>(`SELECT id FROM public.messages WHERE wa_message_id='mid.idem.tap'`);
   assert.deepEqual(await Promise.all([attemptDurableInstagram(sb,ev(c,mTap,"mid.idem.tap","prices")),
    attemptDurableInstagram(sb,ev(c,mTap,"mid.idem.tap","prices"))]),["handled","handled"],"tap replayed into the ingress");
   assert.deepEqual((await runsOf(c)).map(r=>[r.run_status,r.current_node_id]),[["completed","yes"]]);
   assert.equal(await count("automation_message_claims","mid.idem.tap"),1);
   assert.equal(await count("automation_flow_event_receipts","mid.idem.tap"),1);
   assert.equal((await effectsOf(c)).length,2,"one reply for the tap");
   await outboxTick();await outboxTick();
   assert.equal(meta.calls.length,3);assert.equal(meta.calls[2].body.message.text,"هذه الأسعار");
   // Out-of-order tap: a quick-reply event for a conversation with no waiting run
   // (e.g. delivered before / without its question) never starts a run, claims or sends.
   const c3=await conv("1100003");
   const early=hook("1100003","mid.idem.early","support","flow-choice:support");
   assert.equal(await deliver(c3,early,await sign(early)),"handled");
   assert.equal(await count("automation_message_claims","mid.idem.early"),0);
   assert.equal((await runsOf(c3)).length,0);
   await outboxTick();assert.equal(meta.calls.length,3,"nothing sent for the out-of-order tap");
  });

  await t.step("free text, unknown button and deactivated revision end the waiting run and fall back without consuming the claim",async()=>{
   await freshDb();resetMeta();await activate("buttons",true);
   const start=async(psid:string)=>{
    const c=await conv(psid);const m=await inbound(c,"mid.s."+psid);
    assert.equal(await attemptDurableInstagram(sb,ev(c,m,"mid.s."+psid,null)),"handled");
    return c;
   };
   const c1=await start("2000001"),c2=await start("2000002"),c3=await start("2000003");
   await outboxTick();assert.equal(meta.calls.length,3);
   // free text
   const f=await inbound(c1,"mid.free");
   assert.equal(await attemptDurableInstagram(sb,ev(c1,f,"mid.free",null)),"fallback");
   assert.deepEqual((await runsOf(c1)).map(r=>[r.run_status,r.ended_reason]),[["blocked","free_text"]]);
   // The existing V2/AI path can still own this inbound.
   assert.equal(await val(`SELECT count(*)::int FROM public.automation_message_claims WHERE provider_event_id='mid.free'`),0);
   assert.deepEqual(await rows(`SELECT acquired,route FROM public.flow_claim_inbound('${A}','${ACC}','instagram','mid.free','${c1}','${f}',false)`,"service_role"),
    [{acquired:true,route:"legacy_ai"}]);
   // unknown/stale button id for the waiting question
   const s=await inbound(c2,"mid.stale");
   assert.equal(await attemptDurableInstagram(sb,ev(c2,s,"mid.stale","old_option")),"fallback");
   assert.deepEqual((await runsOf(c2)).map(r=>[r.run_status,r.ended_reason]),[["blocked","free_text"]]);
   // revision deactivated while awaiting input
   await activate("buttons",false);
   const tap=await inbound(c3,"mid.tap");
   assert.equal(await attemptDurableInstagram(sb,ev(c3,tap,"mid.tap","prices")),"fallback");
   assert.deepEqual((await runsOf(c3)).map(r=>[r.run_status,r.ended_reason]),[["blocked","revision_inactive"]]);
   for(const c of [c1,c2,c3])assert.equal((await effectsOf(c)).length,1,"no branch effect queued");
   await outboxTick();assert.equal(meta.calls.length,3,"nothing else sent");
  });

  // B1: a duplicate or previously processed event must never cancel, resume or
  // supersede a NEWER run, with and WITHOUT the messages(wa_message_id) unique
  // index (no repo migration creates it; only the test bootstrap does).
  for(const withIndex of [true,false])
  await t.step(`B1 duplicates never interfere with a newer run (messages unique index ${withIndex?"present":"ABSENT"})`,async()=>{
   await freshDb();resetMeta();await activate("buttons",true);
   if(!withIndex)await exec(`DROP INDEX public.idx_messages_wa_message_id;`);
   // milan-api/index.ts order after the signature check (its pre-insert SELECT
   // is skipped on purpose: it misses under concurrency or a read error):
   // persistInboundOnce -> attemptDurableInstagram -> on "fallback" V2's own
   // exclusive claim (the same flow_claim_inbound call, engine not ready).
   type Out={stored:string;durable?:string;v2?:boolean;inbound?:string};
   const v2=async(c:string,m:string,mid:string,tenant=A,acc=ACC)=>{
    const r=await sb.rpc("flow_claim_inbound",{p_tenant_id:tenant,p_account_id:acc,p_platform:"instagram",
     p_provider_event_id:mid,p_conversation_id:c,p_inbound_message_id:m,p_engine_ready:false});
    assert.equal(r.error,null);return (r.data as any[])[0]?.acquired===true;
   };
   const route=async(c:string,m:string,mid:string,choice:string|null,tenant=A,acc=ACC,genuine=true):Promise<Out>=>{
    const durable=await attemptDurableInstagram(sb,ev(c,m,mid,choice,tenant,acc,genuine));
    return {stored:"saved",durable,inbound:m,...(durable==="fallback"?{v2:await v2(c,m,mid,tenant,acc)}:{})};
   };
   // providerMid=null models a Meta event without mid: the same derivation as
   // milan-api/index.ts (synthetic ig_<ms> id for V2, provenance flag false).
   const deliver=async(c:string,providerMid:string|null,choice:string|null,tenant=A,acc=ACC):Promise<Out>=>{
    const mid=providerMid||`ig_${Date.now()}`;
    const genuine=typeof providerMid==="string"&&providerMid.length>0;
    let m:string|null=null;
    const stored=await persistInboundOnce(async()=>{
     const r=await sb.from("messages").insert({conversation_id:c,tenant_id:tenant,direction:"in",
      body_encrypted:await encryptMessageBody("x",FIELD_KEY),kind:"customer",is_auto:false,
      wa_message_id:mid}).select("id").single();
     if(!r.error&&typeof r.data?.id==="string")m=r.data.id;
     return r;
    });
    return stored==="saved"?route(c,m!,mid,choice,tenant,acc,genuine):{stored};
   };
   // Replay of an earlier event. With the index the insert is refused and the
   // worst case is a handler retry into the ingress with the ORIGINAL row; without
   // it a second inbound row is stored and routed.
   const replay=async(c:string,first:Out,mid:string,choice:string|null):Promise<Out>=>{
    const d=await deliver(c,mid,choice);
    if(withIndex){
     assert.equal(d.stored,"duplicate",mid);
     return route(c,first.inbound!,mid,choice);
    }
    assert.equal(d.stored,"saved",mid);return d;
   };
   const state=async(c:string)=>(await runsOf(c)).map(r=>[r.run_status,r.current_node_id,r.ended_reason]);
   const claims=(mid:string)=>val<number>(`SELECT count(*)::int FROM public.automation_message_claims WHERE provider_event_id='${mid}'`);
   const receipts=(mid:string)=>val<number>(`SELECT count(*)::int FROM public.automation_flow_event_receipts WHERE provider_event_id='${mid}'`);
   const inert=async(c:string,o:Out,mid:string,before:unknown[],fx:number)=>{
    assert.notEqual(o.v2,true,mid+": no second answer");
    assert.deepEqual(await state(c),before,mid+": runs untouched");
    assert.equal((await effectsOf(c)).length,fx,mid+": no new effect");
    assert.ok(await claims(mid)<=1,mid);
   };

   // (1)/(3)/(5) old free text and old triggers vs a NEWER waiting run.
   const c=await conv("4100001");
   const t1=await deliver(c,"mid.b1.t1",null);assert.equal(t1.durable,"handled");
   const f1=await deliver(c,"mid.b1.f1",null);
   assert.deepEqual([f1.durable,f1.v2],["fallback",true],"new free text cancels and V2 answers once");
   const t2=await deliver(c,"mid.b1.t2",null);assert.equal(t2.durable,"handled");
   let before=await state(c);
   assert.deepEqual(before,[["blocked","choose","free_text"],["awaiting_input","choose",null]]);
   let fx=(await effectsOf(c)).length;assert.equal(fx,2);
   await inert(c,await replay(c,f1,"mid.b1.f1",null),"mid.b1.f1",before,fx);
   await inert(c,await replay(c,t1,"mid.b1.t1",null),"mid.b1.t1",before,fx);
   await inert(c,await replay(c,t2,"mid.b1.t2",null),"mid.b1.t2",before,fx);
   // (2)/(5) old button taps vs a newer question (the next run's question).
   const tap1=await deliver(c,"mid.b1.tap1","prices");assert.equal(tap1.durable,"handled");
   const t3=await deliver(c,"mid.b1.t3",null);assert.equal(t3.durable,"handled");
   before=await state(c);fx=(await effectsOf(c)).length;
   assert.deepEqual(before.slice(1),[["completed","yes",null],["awaiting_input","choose",null]]);
   await inert(c,await replay(c,tap1,"mid.b1.tap1","prices"),"mid.b1.tap1",before,fx);
   assert.equal(await receipts("mid.b1.tap1"),1,"old tap never resumes the newer run");
   const stale=await deliver(c,"mid.b1.stale","old_option");
   assert.deepEqual([stale.durable,stale.v2],["fallback",true],"new stale tap cancels as free text");
   const t4=await deliver(c,"mid.b1.t4",null);assert.equal(t4.durable,"handled");
   before=await state(c);fx=(await effectsOf(c)).length;
   assert.deepEqual(before.at(-1),["awaiting_input","choose",null]);
   await inert(c,await replay(c,stale,"mid.b1.stale","old_option"),"mid.b1.stale",before,fx);
   await inert(c,await replay(c,tap1,"mid.b1.tap1","prices"),"mid.b1.tap1",before,fx);
   await inert(c,await replay(c,t3,"mid.b1.t3",null),"mid.b1.t3",before,fx);

   // (4) two concurrent deliveries of the same NEW event: exactly one effective processing.
   const answered=(os:Out[])=>os.filter(o=>o.v2===true).length;
   const cf=await conv("4100002");
   assert.equal((await deliver(cf,"mid.b1.cf.t",null)).durable,"handled");
   const fxCf=(await effectsOf(cf)).length;
   const freeBoth=await Promise.all([deliver(cf,"mid.b1.cf.f",null),deliver(cf,"mid.b1.cf.f",null)]);
   assert.equal(answered(freeBoth),1,JSON.stringify(freeBoth));
   assert.equal(await claims("mid.b1.cf.f"),1);
   const cfState=await state(cf);
   assert.equal(cfState.length,1);
   assert.ok(JSON.stringify(cfState[0])===JSON.stringify(["blocked","choose","free_text"])||
    (!withIndex&&cfState[0][0]==="awaiting_input"),JSON.stringify(cfState));
   assert.equal((await effectsOf(cf)).length,fxCf);
   const ct=await conv("4100003");
   assert.equal((await deliver(ct,"mid.b1.ct.t",null)).durable,"handled");
   const tapBoth=await Promise.all([deliver(ct,"mid.b1.ct.tap","support"),deliver(ct,"mid.b1.ct.tap","support")]);
   assert.equal(await claims("mid.b1.ct.tap"),1);
   assert.equal(await receipts("mid.b1.ct.tap")+answered(tapBoth),1,JSON.stringify(tapBoth));
   assert.ok((await effectsOf(ct)).length<=2);
   const cs=await conv("4100004");
   const trigBoth=await Promise.all([deliver(cs,"mid.b1.cs.t",null),deliver(cs,"mid.b1.cs.t",null)]);
   assert.equal(await claims("mid.b1.cs.t"),1);
   assert.equal((await runsOf(cs)).length+answered(trigBoth),1,JSON.stringify(trigBoth));

   // (6) the same provider id in another tenant/account: tenant B claims it first.
   const cb=await conv("4100005",B,ACCB),ca=await conv("4100006");
   const b=await deliver(cb,"mid.b1.shared",null,B,ACCB);
   assert.deepEqual([b.durable,b.v2],["fallback",true],"tenant B (not the env canary) -> V2");
   const a=await deliver(ca,"mid.b1.shared",null);
   if(withIndex)assert.equal(a.stored,"duplicate","the GLOBAL test index drops a cross-tenant id collision before routing");
   else{
    assert.equal(a.durable,"handled","B's claim/row never makes A's event a duplicate");
    assert.deepEqual(await state(ca),[["awaiting_input","choose",null]]);
   }
   assert.equal((await runsOf(cb)).length,0);

   // (7) no provider id: index.ts derives ig_<ms>, new on every delivery, and
   // marks it synthetic (flag false) whatever the generated string looks like.
   const cy=await conv("4100007");
   assert.equal((await deliver(cy,"mid.b1.cy.t",null)).durable,"handled");
   before=await state(cy);fx=(await effectsOf(cy)).length;
   for(let i=0;i<2;i++){
    if(i)await new Promise(r=>setTimeout(r,2)); // distinct ig_<ms> per delivery
    const mark=restLog.length;
    const s=await deliver(cy,null,i===0?null:"prices");
    assert.equal(s.durable,"fallback");
    assert.equal(s.v2,true,"V2 behaviour for an id-less message is unchanged");
    assert.deepEqual(restLog.slice(mark).filter(l=>!l.startsWith("POST messages")&&!l.startsWith("POST rpc/flow_claim_inbound")),[],
     "the durable path touched nothing");
    assert.deepEqual(await state(cy),before,"never cancels the waiting run");
    assert.equal((await effectsOf(cy)).length,fx);
   }
   // (8) a GENUINE Meta mid that merely looks like the synthetic pattern is a
   // real provider id: full durable path, and its replay stays inert (B1).
   const cg=await conv("4100008");
   const g1=await deliver(cg,"ig_1730000000000",null);
   assert.equal(g1.durable,"handled","provenance flag, not the string shape, decides");
   assert.equal(await claims("ig_1730000000000"),1);
   before=await state(cg);fx=(await effectsOf(cg)).length;
   assert.deepEqual(before,[["awaiting_input","choose",null]]);
   await inert(cg,await replay(cg,g1,"ig_1730000000000",null),"ig_1730000000000",before,fx);
  });

  await t.step("delay -> sleeping -> due -> lease; crashed worker lease expires; wake commits once; no double send",async()=>{
   await freshDb();resetMeta();await activate("delay",true);
   const c=await conv("3000001");const m=await inbound(c,"mid.d.1");
   assert.equal(await attemptDurableInstagram(sb,ev(c,m,"mid.d.1",null)),"handled");
   let runs=await runsOf(c);
   assert.equal(runs[0].run_status,"sleeping");assert.equal(runs[0].current_node_id,"sleep");
   assert.equal(await val(`SELECT wake_at>now() FROM public.automation_flow_runs WHERE id='${runs[0].id}'`),true);
   let w=await runtimeTick();
   assert.equal(w.status,200);assert.equal(w.body.leased,0,"not due yet");
   await outboxTick();assert.equal(meta.calls.length,0,"delay effect is not a provider send");
   await exec(`UPDATE public.automation_flow_runs SET wake_at=now()-interval '1 second' WHERE id='${runs[0].id}';`);
   // Worker #1 leases and crashes before committing.
   const lease=await rows<{lease_token:string}>(`SELECT lease_token FROM public.flow_lease_due_runs(20)`,"service_role");
   assert.equal(lease.length,1);
   w=await runtimeTick();
   assert.equal(w.body.leased,0,"held lease is not re-leased");assert.equal(w.body.committed,0);
   assert.equal((await runsOf(c))[0].run_status,"sleeping");
   await exec(`UPDATE public.automation_flow_run_leases SET expires_at=now()-interval '1 second' WHERE run_id='${runs[0].id}';`);
   w=await runtimeTick();
   assert.equal(w.body.leased,1);assert.equal(w.body.committed,1,JSON.stringify(w.body));
   runs=await runsOf(c);
   assert.equal(runs[0].run_status,"completed");assert.equal(runs[0].current_node_id,"later");
   // The crashed worker comes back with its stale token: rejected, no effects.
   assert.equal(await val(`SELECT public.flow_commit_run_step('${A}','${runs[0].id}',1,'sleeping','later',2,'completed',
    '{}'::jsonb,NULL,'[{"kind":"message","idempotencyKey":"crashed-dup","payload":{"kind":"message","text":"dup"}}]'::jsonb,
    'completed','${lease[0].lease_token}')`,"service_role"),false);
   const fx=await effectsOf(c);
   assert.deepEqual(fx.map(e=>e.effect_kind),["delay","message"]);
   await outboxTick();
   assert.equal(meta.calls.length,1);assert.equal(meta.calls[0].body.message.text,"رد بعد الانتظار");
   w=await runtimeTick();assert.equal(w.body.leased,0);
   await outboxTick();assert.equal(meta.calls.length,1,"exactly one send");
  });

  await t.step("provider 5xx / timeout / 2xx without id / 4xx -> uncertain, never resent, routed to human review",async()=>{
   await freshDb();resetMeta();await activate("buttons",true);
   const cs:string[]=[];
   for(const p of ["4000001","4000002","4000003","4000004"]){
    const c=await conv(p);const m=await inbound(c,"mid.p."+p);
    assert.equal(await attemptDurableInstagram(sb,ev(c,m,"mid.p."+p,null)),"handled");cs.push(c);
   }
   meta.plan=["5xx","timeout","noid","400"];
   const o=await outboxTick();
   assert.equal(o.body.status.uncertain,4,JSON.stringify(o.body));
   assert.equal(meta.calls.length,4);
   for(const c of cs){
    const fx=await effectsOf(c);
    assert.equal(fx[0].delivery_status,"uncertain");assert.equal(fx[0].provider_message_id,null);
    assert.equal(await val(`SELECT status FROM public.automation_flow_delivery_attempts WHERE outbox_id='${fx[0].id}'`),"uncertain");
    assert.equal(await val(`SELECT count(*)::int FROM public.messages WHERE id='${fx[0].outgoing_message_id}'`),0);
   }
   await outboxTick();assert.equal(meta.calls.length,4,"uncertain effects are never resent");
   await exec(`UPDATE public.automation_flow_delivery_attempts SET uncertain_at=now()-interval '20 minutes',attempted_at=now()-interval '20 minutes';`);
   assert.equal(await val(`SELECT public.flow_queue_outbox_human_review(15,100)`,"service_role"),4);
   assert.equal(await val(`SELECT count(*)::int FROM public.automation_flow_delivery_attempts WHERE review_status='queued'`),4);
   await outboxTick();assert.equal(meta.calls.length,4);
  });

  await t.step("human takeover and revision deactivation mid-run end the run and skip its effects",async()=>{
   await freshDb();resetMeta();await activate("delay",true);
   const start=async(p:string)=>{const c=await conv(p);const m=await inbound(c,"mid.h."+p);
    assert.equal(await attemptDurableInstagram(sb,ev(c,m,"mid.h."+p,null)),"handled");return c;};
   const c1=await start("5000001"),c2=await start("5000002"),c3=await start("5000003");
   await exec(`UPDATE public.automation_flow_runs SET wake_at=now()-interval '1 second' WHERE conversation_id IN('${c1}','${c2}');
    UPDATE public.conversations SET transferred=true,auto_paused_reason='manual_takeover',
     human_agent_expires_at=now()+interval '1 hour' WHERE id='${c1}';`);
   await runtimeTick();
   assert.deepEqual((await runsOf(c1)).map(r=>[r.run_status,r.ended_reason]),[["blocked","human_takeover"]]);
   assert.equal((await runsOf(c2))[0].run_status,"completed");
   // Takeover starts after the step was planned but before the send.
   await exec(`UPDATE public.conversations SET transferred=true,auto_paused_reason='manual_takeover',
    human_agent_expires_at=now()+interval '1 hour' WHERE id='${c2}';`);
   await outboxTick();
   assert.equal(meta.calls.length,0);
   const m2=(await effectsOf(c2)).find(e=>e.effect_kind==="message")!;
   assert.deepEqual([m2.delivery_status,m2.cancel_reason],["cancelled","human_takeover"]);
   // Revision deactivated while sleeping.
   await activate("delay",false);
   await exec(`UPDATE public.automation_flow_runs SET wake_at=now()-interval '1 second' WHERE conversation_id='${c3}';`);
   await runtimeTick();
   assert.deepEqual((await runsOf(c3)).map(r=>[r.run_status,r.ended_reason]),[["blocked","revision_inactive"]]);
   assert.deepEqual((await effectsOf(c3)).map(e=>e.effect_kind),["delay"]);
   await outboxTick();assert.equal(meta.calls.length,0);
  });

  await t.step("tenant isolation across ingress, outbox and tokens",async()=>{
   await freshDb();resetMeta();await activate("buttons",true);
   const cA=await conv("6000001");
   const cB=await conv("6000002",B,ACCB);
   const mB=await inbound(cB,"mid.b.1",B);
   // Tenant A event pointing at tenant B's conversation/inbound: refused, nothing created.
   assert.equal(await attemptDurableInstagram(sb,ev(cB,mB,"mid.b.1",null)),"handled");
   assert.equal(await val(`SELECT count(*)::int FROM public.automation_flow_runs WHERE conversation_id='${cB}'`),0);
   assert.equal(await val(`SELECT count(*)::int FROM public.automation_message_claims WHERE provider_event_id='mid.b.1'`),0);
   // Tenant B (not the canary account) never enters the durable path.
   assert.equal(await attemptDurableInstagram(sb,ev(cB,mB,"mid.b.1",null,B,ACCB)),"fallback");
   // A tenant-B effect cannot reference a tenant-A run (composite FK).
   const mA=await inbound(cA,"mid.a.1");
   assert.equal(await attemptDurableInstagram(sb,ev(cA,mA,"mid.a.1",null)),"handled");
   const runA=(await runsOf(cA))[0].id;
   const forged=await psql(db,`INSERT INTO public.automation_flow_outbox(tenant_id,run_id,idempotency_key,effect_kind,payload)
    VALUES('${B}','${runA}','forged','message','{"kind":"message","text":"x"}');`,"service_role");
   assert.equal(forged.ok,false);assert.equal(sqlError(forged.err).code,"23503");
   // Tenant B has its own legitimately claimed run/effect; each is sent with its own token/recipient.
   await exec(`
    INSERT INTO public.automation_message_claims(tenant_id,channel_account_id,platform,provider_event_id,conversation_id,inbound_message_id,route)
    VALUES('${B}','${ACCB}','instagram','mid.b.1','${cB}','${mB}','flow');
    INSERT INTO public.automation_flow_event_receipts(tenant_id,channel_account_id,platform,provider_event_id)
    VALUES('${B}','${ACCB}','instagram','mid.b.1');
    WITH r AS (INSERT INTO public.automation_flow_runs(tenant_id,flow_key,publication_revision,channel_account_id,platform,
     conversation_id,provider_event_id,current_node_id,run_status,step_count)
     VALUES('${B}','bflow',1,'${ACCB}','instagram','${cB}','mid.b.1','yes','completed',2) RETURNING id)
    INSERT INTO public.automation_flow_outbox(tenant_id,run_id,idempotency_key,effect_kind,payload)
    SELECT '${B}',r.id,'b-msg','message','{"kind":"message","text":"tenant B text"}'::jsonb FROM r;`);
   await outboxTick();
   assert.equal(meta.calls.length,2);
   const byRecipient=Object.fromEntries(meta.calls.map(c=>[c.body.recipient.id,c]));
   assert.equal(byRecipient["6000001"].auth,"Bearer IGA-token-test");
   assert.equal(byRecipient["6000002"].auth,"Bearer IGB-token-test");
   assert.equal(byRecipient["6000002"].body.message.text,"tenant B text");
   // Tenant B switched off: its new effect stays pending; tenant A is unaffected.
   await exec(`UPDATE public.automation_flow_tenant_switches SET enabled=false WHERE tenant_id='${B}';
    INSERT INTO public.automation_flow_outbox(tenant_id,run_id,idempotency_key,effect_kind,payload)
    SELECT tenant_id,id,'b-msg-2','message','{"kind":"message","text":"B paused"}'::jsonb
    FROM public.automation_flow_runs WHERE conversation_id='${cB}';`);
   const tap=await inbound(cA,"mid.a.2");
   assert.equal(await attemptDurableInstagram(sb,ev(cA,tap,"mid.a.2","support")),"handled");
   await outboxTick();
   assert.equal(meta.calls.length,3);assert.equal(meta.calls[2].body.message.text,"تواصل معنا");
   assert.deepEqual((await effectsOf(cB)).map(e=>e.delivery_status),["settled","pending"]);
  });

  await t.step("knowledge_ai effect: grounded answer is sent once; no_knowledge is cancelled without a send",async()=>{
   await freshDb();resetMeta();await activate("buttons",true);
   await exec(`INSERT INTO public.knowledge_sources VALUES('d0000000-0000-4000-8000-000000000001','${A}','indexed');
    INSERT INTO public.knowledge_chunks VALUES('d0000000-0000-4000-8000-000000000002','${A}','The item price is 1000 IQD including delivery.','d0000000-0000-4000-8000-000000000001');`);
   const seedAi=async(p:string,question:string)=>{
    const c=await conv(p);const m=await inbound(c,"mid.k."+p);
    await exec(`
     INSERT INTO public.automation_message_claims(tenant_id,channel_account_id,platform,provider_event_id,conversation_id,inbound_message_id,route)
     VALUES('${A}','${ACC}','instagram','mid.k.${p}','${c}','${m}','flow');
     INSERT INTO public.automation_flow_event_receipts(tenant_id,channel_account_id,platform,provider_event_id)
     VALUES('${A}','${ACC}','instagram','mid.k.${p}');
     WITH r AS (INSERT INTO public.automation_flow_runs(tenant_id,flow_key,publication_revision,channel_account_id,platform,
      conversation_id,provider_event_id,current_node_id,run_status,step_count,variables)
      VALUES('${A}','buttons',1,'${ACC}','instagram','${c}','mid.k.${p}','yes','completed',2,${lit({message:question})}) RETURNING id)
     INSERT INTO public.automation_flow_outbox(tenant_id,run_id,idempotency_key,effect_kind,payload)
     SELECT '${A}',r.id,'ai-${p}','message','{"kind":"message","source":"knowledge_ai","text":"","nodeId":"ai"}'::jsonb FROM r;`);
    return c;
   };
   const c1=await seedAi("7000001","How much is the item?");
   openai.answer={answer:"السعر 1000 دينار",quote:"The item price is 1000 IQD"};
   let o=await outboxTick();
   assert.equal(o.body.status.settled,1,JSON.stringify(o.body));
   assert.equal(meta.calls.length,1);assert.equal(meta.calls[0].body.message.text,"السعر 1000 دينار");
   assert.equal(await val(`SELECT ai_answer_encrypted IS NOT NULL FROM public.automation_flow_outbox WHERE idempotency_key='ai-7000001'`),true);
   const calls=openai.calls;
   await outboxTick();
   assert.equal(meta.calls.length,1);assert.equal(openai.calls,calls,"no second model call");
   const c2=await seedAi("7000002","Do you ship to Mars?");
   openai.answer=null;
   o=await outboxTick();
   assert.equal(meta.calls.length,1,"no_knowledge never sends");
   const fx=await effectsOf(c2);
   assert.deepEqual([fx[0].delivery_status,fx[0].cancel_reason],["cancelled","no_knowledge"]);
   assert.equal((await effectsOf(c1))[0].delivery_status,"settled");
  });

  await t.step("knowledge_ai retry/dead_letter on the real worker: transient 503/429/timeout -> retry_wait (no send, not due = no call), retry then one send; 5 failures -> dead_letter in delivery review; 401/400 -> dead_letter at once; concurrent workers -> one call, one send",async()=>{
   await freshDb();resetMeta();await activate("buttons",true);
   openai.plan=[];openai.answer={answer:"السعر 1000 دينار",quote:"The item price is 1000 IQD"};
   await exec(`INSERT INTO public.knowledge_sources VALUES('d0000000-0000-4000-8000-000000000001','${A}','indexed');
    INSERT INTO public.knowledge_chunks VALUES('d0000000-0000-4000-8000-000000000002','${A}','The item price is 1000 IQD including delivery.','d0000000-0000-4000-8000-000000000001');`);
   // Same shape as the knowledge_ai step above (no path creates knowledge_ai effects yet).
   const seedAi=async(p:string)=>{
    const c=await conv(p);const m=await inbound(c,"mid.r."+p);
    await exec(`
     INSERT INTO public.automation_message_claims(tenant_id,channel_account_id,platform,provider_event_id,conversation_id,inbound_message_id,route)
     VALUES('${A}','${ACC}','instagram','mid.r.${p}','${c}','${m}','flow');
     INSERT INTO public.automation_flow_event_receipts(tenant_id,channel_account_id,platform,provider_event_id)
     VALUES('${A}','${ACC}','instagram','mid.r.${p}');
     WITH r AS (INSERT INTO public.automation_flow_runs(tenant_id,flow_key,publication_revision,channel_account_id,platform,
      conversation_id,provider_event_id,current_node_id,run_status,step_count,variables)
      VALUES('${A}','buttons',1,'${ACC}','instagram','${c}','mid.r.${p}','yes','completed',2,${lit({message:"How much is the item?"})}) RETURNING id)
     INSERT INTO public.automation_flow_outbox(tenant_id,run_id,idempotency_key,effect_kind,payload)
     SELECT '${A}',r.id,'ai-${p}','message','{"kind":"message","source":"knowledge_ai","text":"","nodeId":"ai"}'::jsonb FROM r;`);
    return c;
   };
   type AiRow={delivery_status:string;cancel_reason:string|null;ai_attempts:number;ai_last_error_code:string|null;
    due:boolean|null;wait_s:number|null;answered:boolean;id:string};
   const ai=async(p:string)=>(await rows<AiRow>(`SELECT id,delivery_status,cancel_reason,ai_attempts,ai_last_error_code,
    retry_at<=now() AS due,round(extract(epoch FROM retry_at-now()))::int AS wait_s,ai_answer_encrypted IS NOT NULL AS answered
    FROM public.automation_flow_outbox WHERE idempotency_key='ai-${p}'`))[0];
   const makeDue=(p:string)=>exec(`UPDATE public.automation_flow_outbox SET retry_at=now()-interval '1 second' WHERE idempotency_key='ai-${p}'`);
   const runOf=async(c:string)=>(await runsOf(c))[0];

   // (1) transient 503 -> retry_wait with retry_at ~60 s (+<=10% jitter); no send; run not touched.
   const c1=await seedAi("7100001");
   openai.plan=[503];openai.chat=0;
   let o=await outboxTick();
   assert.equal(o.status,200);assert.equal(o.body.status.ai_retry_scheduled,1,JSON.stringify(o.body));
   let r=await ai("7100001");
   assert.deepEqual([r.delivery_status,r.cancel_reason,r.ai_attempts,r.ai_last_error_code,r.due,r.answered],
    ["retry_wait",null,1,"ai_http_5xx",false,false]);
   assert.ok(r.wait_s!>=55&&r.wait_s!<=67,`backoff ${r.wait_s}s`);
   assert.equal(meta.calls.length,0,"no send while retrying");
   assert.equal((await runOf(c1)).run_status,"completed","run not cancelled");
   // Re-invocation before retry_at: not listed, no model call, unchanged.
   o=await outboxTick();
   assert.equal(openai.chat,1,"no model call before retry_at");
   assert.deepEqual((await ai("7100001")).delivery_status,"retry_wait");assert.equal(meta.calls.length,0);
   // After retry_at (advanced in SQL, no sleeping): 429 -> second backoff ~120 s.
   await makeDue("7100001");openai.plan=[429];
   o=await outboxTick();
   r=await ai("7100001");
   assert.deepEqual([r.delivery_status,r.ai_attempts,r.ai_last_error_code],["retry_wait",2,"ai_http_429"]);
   assert.ok(r.wait_s!>=115&&r.wait_s!<=133,`backoff ${r.wait_s}s`);
   // timeout -> third backoff ~240 s.
   await makeDue("7100001");openai.plan=["timeout"];
   await outboxTick();
   r=await ai("7100001");
   assert.deepEqual([r.delivery_status,r.ai_attempts,r.ai_last_error_code],["retry_wait",3,"ai_timeout"]);
   assert.ok(r.wait_s!>=235&&r.wait_s!<=265,`backoff ${r.wait_s}s`);
   assert.equal(meta.calls.length,0);
   // Due again and the provider recovers: answer stored, sent exactly once.
   await makeDue("7100001");
   o=await outboxTick();
   assert.equal(o.body.status.settled,1,JSON.stringify(o.body));
   r=await ai("7100001");
   assert.deepEqual([r.delivery_status,r.ai_attempts,r.answered],["settled",4,true]);
   assert.equal(meta.calls.length,1);assert.equal(meta.calls[0].body.message.text,"السعر 1000 دينار");
   assert.equal(openai.chat,4);
   await outboxTick();await outboxTick();
   assert.equal(meta.calls.length,1,"never re-sent");assert.equal(openai.chat,4,"no model call after the answer is stored");

   // (2) five transient failures -> dead_letter / ai_retries_exhausted, never sent; visible in delivery review.
   const c2=await seedAi("7100002");
   openai.plan=[503,429,"timeout",503,502];openai.chat=0;
   for(let i=1;i<=5;i++){
    await outboxTick();
    r=await ai("7100002");
    assert.equal(r.ai_attempts,i);
    assert.equal(r.delivery_status,i<5?"retry_wait":"dead_letter",`attempt ${i}`);
    if(i<5)await makeDue("7100002");
   }
   assert.deepEqual([r.cancel_reason,r.ai_last_error_code,r.due],["ai_retries_exhausted","ai_http_5xx",null]);
   assert.equal(openai.chat,5);assert.equal(meta.calls.length,1,"exhausted effect never sent");
   await outboxTick();assert.equal(openai.chat,5,"dead_letter is final");
   assert.equal((await runOf(c2)).run_status,"completed");
   const review=await loadFlowReview(sb as never,A);
   const item=review.flowFailures.find(f=>f.id===r.id);
   assert.ok(item,JSON.stringify(review.flowFailures));
   assert.deepEqual([item!.delivery_status,item!.cancel_reason,item!.effect_kind],["dead_letter","ai_retries_exhausted","message"]);
   assert.equal(JSON.stringify(review).includes("1000 IQD"),false,"review exposes no content");
   assert.equal((await loadFlowReview(sb as never,B)).flowFailures.some(f=>f.id===r.id),false,"tenant-scoped review");

   // (3) permanent 401 / 400 -> dead_letter / ai_unavailable on the first attempt.
   for(const [p,status] of [["7100003",401],["7100004",400]] as const){
    await seedAi(p);openai.plan=[status];openai.chat=0;
    await outboxTick();
    r=await ai(p);
    assert.deepEqual([r.delivery_status,r.cancel_reason,r.ai_attempts,r.ai_last_error_code],
     ["dead_letter","ai_unavailable",1,"ai_http_"+status],p);
    await outboxTick();assert.equal(openai.chat,1,`${status}: no retry`);
   }
   assert.equal(meta.calls.length,1);

   // (4) no_knowledge -> cancelled, no retry, no send.
   await seedAi("7100005");openai.answer=null;openai.chat=0;
   await outboxTick();
   r=await ai("7100005");
   assert.deepEqual([r.delivery_status,r.cancel_reason,r.ai_attempts,r.due],["cancelled","no_knowledge",1,null]);
   await outboxTick();assert.equal(openai.chat,1);assert.equal(meta.calls.length,1);

   // (5) two workers at once on a fresh effect: one model call, one send.
   openai.answer={answer:"السعر 1000 دينار",quote:"The item price is 1000 IQD"};
   await seedAi("7100006");openai.chat=0;
   const both=await Promise.all([outboxTick(),outboxTick()]);
   assert.ok(both.every(b=>b.status===200));
   await outboxTick();
   r=await ai("7100006");
   assert.deepEqual([r.delivery_status,r.ai_attempts],["settled",1]);
   assert.equal(openai.chat,1,"one model call across concurrent workers");
   assert.equal(meta.calls.length,2,"one send across concurrent workers");
   assert.equal(await val(`SELECT count(*)::int FROM public.automation_flow_delivery_attempts WHERE outbox_id='${r.id}'`),1);

   // dead_letter comes only from the AI path: provider failures after a send attempt are 'uncertain' (step above).
   assert.equal(await val(`SELECT count(*)::int FROM public.automation_flow_outbox WHERE delivery_status='dead_letter'
    AND (payload->>'source' IS DISTINCT FROM 'knowledge_ai' OR cancel_reason NOT IN ('ai_unavailable','ai_retries_exhausted'))`),0);
  });

  await t.step("production-approved tenant without test_only: durable path must not swallow the inbound claim",async()=>{
   await freshDb();resetMeta();await activate("buttons",true);
   await exec(`UPDATE public.automation_flow_tenant_switches SET test_only=false,production_approved=true WHERE tenant_id='${A}';`);
   const c=await conv("8000001");const m=await inbound(c,"mid.prod.1");
   // flow_claim_inbound only routes to 'flow' for test_only tenants. The
   // durable path must leave this inbound to the existing reply path instead
   // of consuming the exclusive claim as legacy_ai and answering nobody.
   assert.equal(await attemptDurableInstagram(sb,ev(c,m,"mid.prod.1",null)),"fallback");
   assert.equal(await val(`SELECT count(*)::int FROM public.automation_message_claims WHERE provider_event_id='mid.prod.1'`),0);
   assert.equal((await runsOf(c)).length,0);
   assert.deepEqual(await rows(`SELECT acquired,route FROM public.flow_claim_inbound('${A}','${ACC}','instagram','mid.prod.1','${c}','${m}',false)`,"service_role"),
    [{acquired:true,route:"legacy_ai"}]);
  });

  await t.step("production canary (20261029170000): registered canary question -> send -> tap resumes branch; non-canary account of the same approved tenant falls back to V2",async()=>{
   await freshDb();resetMeta();await activate("buttons",true);
   // Approved production tenant (test_only=false). The operator registers the
   // canary account in SQL; the env var (ACC) stays as defense in depth.
   await exec(`UPDATE public.automation_flow_tenant_switches SET test_only=false,production_approved=true WHERE tenant_id='${A}';
    INSERT INTO public.automation_flow_canary_accounts(tenant_id,channel_account_id,platform,approved_by)
    VALUES('${A}','${ACC}','instagram','test-operator');
    INSERT INTO public.channel_accounts(id,tenant_id,platform,channel,external_id) VALUES('${ACC2}','${A}','instagram','instagram','17841400000000003');
    INSERT INTO public.automation_flow_publications(tenant_id,flow_key,revision,channel_account_id,platform,document,published_by)
    VALUES('${A}','other',1,'${ACC2}','instagram',${lit(buttonsDoc)},'88888888-8888-4888-8888-888888888888');
    INSERT INTO public.automation_flow_activations(tenant_id,channel_account_id,platform,flow_key,revision,is_active)
    VALUES('${A}','${ACC2}','instagram','other',1,true);`);
   const rpcs=(from:number)=>restLog.slice(from).filter(l=>l.startsWith("POST rpc/flow_claim_inbound"));
   const c=await conv("9000001");const m1=await inbound(c,"mid.canary.1");
   let mark=restLog.length;
   assert.equal(await attemptDurableInstagram(sb,ev(c,m1,"mid.canary.1",null)),"handled");
   assert.deepEqual(rpcs(mark),["POST rpc/flow_claim_inbound_durable"],"production canary never calls the V2 claim");
   assert.deepEqual(await rows(`SELECT route FROM public.automation_message_claims WHERE provider_event_id='mid.canary.1'`),[{route:"flow"}]);
   assert.equal(await val(`SELECT count(*)::int FROM public.automation_flow_canary_claims WHERE provider_event_id='mid.canary.1'`),1);
   let runs=await runsOf(c);
   assert.equal(runs.length,1);assert.equal(runs[0].run_status,"awaiting_input");assert.equal(runs[0].current_node_id,"choose");
   // A re-delivered Meta event stops at the inbound unique index before routing
   // (persistInboundOnce); the canary claim itself is also exclusive.
   const dup=await psql(db,`SELECT it.inbound('${A}','${c}','mid.canary.1');`);
   assert.equal(dup.ok,false);assert.equal(sqlError(dup.err).code,"23505");
   assert.deepEqual(await rows(`SELECT acquired,route FROM public.flow_claim_inbound_durable('${A}','${ACC}','instagram','mid.canary.1','${c}','${m1}')`,"service_role"),
    [{acquired:false,route:"flow"}]);
   assert.equal(await val(`SELECT count(*)::int FROM public.automation_message_claims WHERE provider_event_id='mid.canary.1'`),1);
   assert.equal((await runsOf(c)).length,1);
   let o=await outboxTick();
   assert.equal(o.status,200);assert.equal(o.body.status.settled,1,JSON.stringify(o.body));
   assert.equal(meta.calls.length,1);
   assert.equal(meta.calls[0].auth,"Bearer IGA-token-test");assert.equal(meta.calls[0].body.recipient.id,"9000001");
   assert.deepEqual(meta.calls[0].body.message.quick_replies.map((q:any)=>q.payload),["flow-choice:prices","flow-choice:support"]);
   // The tap resumes the SAME run on the tapped branch, claimed through the canary function.
   const m2=await inbound(c,"mid.canary.2");
   mark=restLog.length;
   assert.equal(await attemptDurableInstagram(sb,ev(c,m2,"mid.canary.2","support")),"handled");
   assert.deepEqual(rpcs(mark),["POST rpc/flow_claim_inbound_durable"]);
   runs=await runsOf(c);
   assert.equal(runs.length,1);assert.equal(runs[0].run_status,"completed");assert.equal(runs[0].current_node_id,"no");
   o=await outboxTick();
   assert.equal(meta.calls.length,2);assert.equal(meta.calls[1].body.message.text,"تواصل معنا");
   await outboxTick();assert.equal(meta.calls.length,2,"exactly one send per effect");
   assert.equal(await val(`SELECT count(*)::int FROM public.automation_flow_canary_claims`),2);
   // Non-canary account of the SAME approved tenant: env gate falls back before any DB access ...
   const c2=await conv("9000002",A,ACC2);const m3=await inbound(c2,"mid.noncanary.1");
   mark=restLog.length;
   assert.equal(await attemptDurableInstagram(sb,ev(c2,m3,"mid.noncanary.1",null,A,ACC2)),"fallback");
   assert.equal(restLog.length,mark,"no database access for a non-canary account");
   // ... and even if the env var pointed at it, SQL refuses (not the registered canary): no claim.
   Deno.env.set("FLOW_DURABLE_CANARY_ACCOUNT_ID",ACC2);
   try{
    assert.equal(await attemptDurableInstagram(sb,ev(c2,m3,"mid.noncanary.1",null,A,ACC2)),"fallback");
   }finally{Deno.env.set("FLOW_DURABLE_CANARY_ACCOUNT_ID",ACC);}
   assert.equal(await val(`SELECT count(*)::int FROM public.automation_message_claims WHERE provider_event_id='mid.noncanary.1'`),0);
   assert.equal((await runsOf(c2)).length,0);
   // V2 then owns the event exactly as before.
   assert.deepEqual(await rows(`SELECT acquired,route FROM public.flow_claim_inbound('${A}','${ACC2}','instagram','mid.noncanary.1','${c2}','${m3}',false)`,"service_role"),
    [{acquired:true,route:"legacy_ai"}]);
   await outboxTick();assert.equal(meta.calls.length,2,"nothing sent for the non-canary account");
  });

  await t.step("multi-step chain: welcome -> button question -> tap -> answer -> delay -> wake -> follow-up; exact order, one send each, replays inert",async()=>{
   await freshDb();resetMeta();await activate("chain",true);
   const c=await conv("9100001");
   const order=async()=>(await rows<{kind:string;seq:number;text:string|null;status:string}>(
    `SELECT o.effect_kind AS kind,(o.payload->>'seq')::int AS seq,o.payload->>'text' AS text,o.delivery_status AS status
     FROM public.automation_flow_outbox o JOIN public.automation_flow_runs r ON r.tenant_id=o.tenant_id AND r.id=o.run_id
     WHERE r.conversation_id='${c}' ORDER BY o.created_at,(o.payload->>'seq')::int`));
   // 1) Trigger: welcome + menu planned together, ONE run, ONE commit.
   const m1=await inbound(c,"mid.chain.1");
   assert.equal(await attemptDurableInstagram(sb,ev(c,m1,"mid.chain.1",null)),"handled");
   let runs=await runsOf(c);
   assert.equal(runs.length,1);
   assert.deepEqual([runs[0].run_status,runs[0].current_node_id],["awaiting_input","menu"]);
   assert.deepEqual((await order()).map(e=>[e.kind,e.seq,e.text,e.status]),
    [["message",0,"أهلاً بك في المتجر","pending"],["question",1,"شنو تحتاج؟","pending"]]);
   assert.equal(await val(`SELECT count(DISTINCT o.created_at)::int FROM public.automation_flow_outbox o
    WHERE o.run_id='${runs[0].id}'`),1,"both effects share one commit timestamp");
   // Replay of the trigger event: no new run, effect or send.
   assert.equal(await attemptDurableInstagram(sb,ev(c,m1,"mid.chain.1",null)),"handled");
   assert.equal((await order()).length,2);
   // 2) One outbox tick sends welcome THEN the question (seq order), once each.
   let o=await outboxTick();
   assert.equal(o.status,200);assert.equal(o.body.status.settled,2,JSON.stringify(o.body));
   assert.deepEqual(meta.calls.map(x=>x.body.message.text),["أهلاً بك في المتجر","شنو تحتاج؟"]);
   assert.equal(meta.calls[0].body.message.quick_replies,undefined);
   assert.deepEqual(meta.calls[1].body.message.quick_replies.map((q:any)=>q.payload),
    ["flow-choice:prices","flow-choice:support"]);
   await outboxTick();assert.equal(meta.calls.length,2,"settled effects never re-sent");
   // 3) Tap: answer + delay in ONE commit; the run sleeps on the delay.
   const m2=await inbound(c,"mid.chain.2");
   assert.equal(await attemptDurableInstagram(sb,ev(c,m2,"mid.chain.2","prices")),"handled");
   runs=await runsOf(c);
   assert.equal(runs.length,1);
   assert.deepEqual([runs[0].run_status,runs[0].current_node_id],["sleeping","wait"]);
   assert.deepEqual(await rows(`SELECT variables FROM public.automation_flow_runs WHERE id='${runs[0].id}'`),
    [{variables:{menu:"prices"}}],"only the tapped button id; never inbound text");
   assert.deepEqual((await order()).slice(2).map(e=>[e.kind,e.seq,e.text]),
    [["message",0,"هذه قائمة الأسعار"],["delay",1,null]]);
   // Duplicate tap delivery: inert.
   assert.equal(await attemptDurableInstagram(sb,ev(c,m2,"mid.chain.2","prices")),"handled");
   assert.equal((await order()).length,4);
   o=await outboxTick();
   assert.equal(meta.calls.length,3);assert.equal(meta.calls[2].body.message.text,"هذه قائمة الأسعار");
   // 4) Not due yet: nothing leased. Then due: the wake plans follow-up -> end.
   let w=await runtimeTick();assert.equal(w.body.leased,0);
   await exec(`UPDATE public.automation_flow_runs SET wake_at=now()-interval '1 second' WHERE id='${runs[0].id}';`);
   w=await runtimeTick();
   assert.equal(w.body.leased,1);assert.equal(w.body.committed,1,JSON.stringify(w.body));
   runs=await runsOf(c);
   assert.deepEqual([runs[0].run_status,runs[0].current_node_id],["completed","done"]);
   assert.deepEqual((await order()).slice(4).map(e=>[e.kind,e.seq,e.text]),
    [["message",0,"هل تحتاج شيئاً آخر؟"]]);
   o=await outboxTick();
   assert.equal(meta.calls.length,4);assert.equal(meta.calls[3].body.message.text,"هل تحتاج شيئاً آخر؟");
   // 5) Everything replayed again: no lease, no new effect, no send.
   w=await runtimeTick();assert.equal(w.body.leased,0);
   assert.equal(await attemptDurableInstagram(sb,ev(c,m1,"mid.chain.1",null)),"handled");
   assert.equal(await attemptDurableInstagram(sb,ev(c,m2,"mid.chain.2","prices")),"handled");
   await outboxTick();
   assert.deepEqual(meta.calls.map(x=>x.body.message.text),
    ["أهلاً بك في المتجر","شنو تحتاج؟","هذه قائمة الأسعار","هل تحتاج شيئاً آخر؟"],"exact order, one send each");
   assert.equal((await runsOf(c)).length,1);
   assert.deepEqual((await order()).filter(e=>e.kind!=="delay").map(e=>e.status),
    ["settled","settled","settled","settled"]);
   assert.equal(await val(`SELECT count(*)::int FROM public.automation_flow_delivery_attempts a
    JOIN public.automation_flow_outbox o ON o.tenant_id=a.tenant_id AND o.id=a.outbox_id
    WHERE o.run_id='${runs[0].id}'`),4,"one provider attempt per effect");
  });

  await t.step("typed answers (a): valid email -> resume SAME run -> stored value in the next message -> condition branches on it",async()=>{
   await freshDb();resetMeta();await activate("collect",true);
   const begin=async(psid:string)=>{
    const c=await conv(psid);const m=await inbound(c,"mid.col."+psid);
    assert.equal(await attemptDurableInstagram(sb,evText(c,m,"mid.col."+psid,"مرحبا")),"handled");
    return c;
   };
   const c=await begin("9200001"),c2=await begin("9200002");
   assert.deepEqual((await runRow(c)).map(r=>[r.run_status,r.current_node_id]),[["awaiting_input","askEmail"]]);
   assert.deepEqual((await effectsOf(c)).sort((x,y)=>x.payload.seq-y.payload.seq)
    .map(e=>[e.effect_kind,e.payload.seq,e.payload.inputMode??null]),
    [["message",0,null],["question",1,"email"]]);
   let o=await outboxTick();
   assert.equal(o.body.status.settled,4,JSON.stringify(o.body));
   assert.deepEqual(sentTexts(),["أهلاً بك","ما بريدك الإلكتروني؟","أهلاً بك","ما بريدك الإلكتروني؟"]);
   assert.ok(meta.calls.every(x=>x.body.message.quick_replies===undefined),"typed question: plain message, no quick replies");
   resetMeta();
   const runId=(await runsOf(c))[0].id;
   const a=await inbound(c,"mid.col.ans1");
   assert.equal(await attemptDurableInstagram(sb,evText(c,a,"mid.col.ans1","  Sara@VIP.Example.com ")),"handled");
   const b=await inbound(c2,"mid.col.ans2");
   assert.equal(await attemptDurableInstagram(sb,evText(c2,b,"mid.col.ans2","ali@shop.example")),"handled");
   assert.equal((await runsOf(c))[0].id,runId,"same run resumed");
   assert.deepEqual((await runRow(c)).map(r=>[r.run_status,r.current_node_id,r.variables]),
    [["completed","vip",{email:"sara@vip.example.com"}]]);
   assert.deepEqual((await runRow(c2)).map(r=>[r.run_status,r.current_node_id,r.variables]),
    [["completed","std",{email:"ali@shop.example"}]]);
   assert.equal(await val(`SELECT count(*)::int FROM public.automation_flow_event_receipts WHERE provider_event_id IN ('mid.col.ans1','mid.col.ans2')`),2);
   o=await outboxTick();
   assert.deepEqual(sentTexts(),["شكراً، سجلنا sara@vip.example.com","عرض VIP لـ sara@vip.example.com",
    "شكراً، سجلنا ali@shop.example","عرض عادي"]);
   await outboxTick();assert.equal(meta.calls.length,4,"never re-sent");
  });

  await t.step("typed answers (b): invalid answer -> exactly one re-ask, run still awaiting; bound -> V2 without cancel; then a valid answer resumes",async()=>{
   await freshDb();resetMeta();await activate("collect",true);
   const c=await conv("9300001");const m=await inbound(c,"mid.inv.0");
   assert.equal(await attemptDurableInstagram(sb,evText(c,m,"mid.inv.0","hi")),"handled");
   await outboxTick();resetMeta();
   const key=reaskField("askEmail");
   const bad=async(n:number)=>{
    const i=await inbound(c,"mid.inv."+n);
    return {i,r:await attemptDurableInstagram(sb,evText(c,i,"mid.inv."+n,"not an email "+n))};
   };
   const first=await bad(1);
   assert.equal(first.r,"handled");
   let r=await runRow(c);
   assert.deepEqual(r.map(x=>[x.run_status,x.current_node_id,x.step_count,x.variables]),
    [["awaiting_input","askEmail",4,{[key]:"1"}]],"run kept at the same node");
   // Redelivery of the SAME invalid answer: no second re-ask.
   assert.equal(await attemptDurableInstagram(sb,evText(c,first.i,"mid.inv.1","not an email 1")),"handled");
   assert.equal((await effectsOf(c)).length,3,"welcome + question + ONE re-ask");
   await outboxTick();
   assert.deepEqual(sentTexts(),["يرجى إرسال بريد إلكتروني صحيح، مثل name@example.com\nما بريدك الإلكتروني؟"]);
   assert.ok(!JSON.stringify(await effectsOf(c)).includes("not an email"),"invalid text never stored");
   // Two more invalid answers reach the bound (3 re-asks)...
   for(const n of [2,3])assert.equal((await bad(n)).r,"handled");
   assert.deepEqual((await runRow(c))[0].variables,{[key]:"3"});
   // ...the 4th is handed to V2: no claim by the durable path, no cancel, no re-ask.
   const fourth=await bad(4);
   assert.equal(fourth.r,"fallback");
   assert.equal(await val(`SELECT count(*)::int FROM public.automation_message_claims WHERE provider_event_id='mid.inv.4'`),0);
   assert.deepEqual(await rows(`SELECT acquired,route FROM public.flow_claim_inbound('${A}','${ACC}','instagram','mid.inv.4','${c}','${fourth.i}',false)`,"service_role"),
    [{acquired:true,route:"legacy_ai"}],"V2/AI owns it");
   r=await runRow(c);
   assert.deepEqual(r.map(x=>[x.run_status,x.current_node_id,x.step_count,x.ended_reason]),[["awaiting_input","askEmail",6,null]]);
   await outboxTick();
   assert.equal(meta.calls.length,3,"three re-asks in total");
   // A valid answer still resumes the run and clears the counter.
   const ok=await inbound(c,"mid.inv.ok");
   assert.equal(await attemptDurableInstagram(sb,evText(c,ok,"mid.inv.ok","late@shop.example")),"handled");
   assert.deepEqual((await runRow(c)).map(x=>[x.run_status,x.current_node_id,x.variables]),
    [["completed","std",{email:"late@shop.example"}]]);
   await outboxTick();
   assert.deepEqual(sentTexts().slice(3),["شكراً، سجلنا late@shop.example","عرض عادي"]);
  });

  await t.step("typed answers (c): duplicate and concurrent redelivery of the same answer -> one resume, one set of sends",async()=>{
   await freshDb();resetMeta();await activate("collect",true);
   const c=await conv("9400001");const m=await inbound(c,"mid.dup.0");
   assert.equal(await attemptDurableInstagram(sb,evText(c,m,"mid.dup.0","hi")),"handled");
   await outboxTick();resetMeta();
   const a=await inbound(c,"mid.dup.1");
   const same=()=>attemptDurableInstagram(sb,evText(c,a,"mid.dup.1","sara@vip.example.com"));
   assert.deepEqual(await Promise.all([same(),same(),same()]),["handled","handled","handled"]);
   assert.equal(await same(),"handled");
   assert.equal(await val(`SELECT count(*)::int FROM public.automation_message_claims WHERE provider_event_id='mid.dup.1'`),1);
   assert.equal(await val(`SELECT count(*)::int FROM public.automation_flow_event_receipts WHERE provider_event_id='mid.dup.1'`),1);
   assert.equal((await effectsOf(c)).length,4,"one resume commit");
   await Promise.all([outboxTick(),outboxTick()]);await outboxTick();
   assert.deepEqual(sentTexts(),["شكراً، سجلنا sara@vip.example.com","عرض VIP لـ sara@vip.example.com"]);
   // Concurrent copies of an INVALID answer: exactly one re-ask.
   const c2=await conv("9400002");const m2=await inbound(c2,"mid.dup.2");
   assert.equal(await attemptDurableInstagram(sb,evText(c2,m2,"mid.dup.2","hi")),"handled");
   const b=await inbound(c2,"mid.dup.3");
   const wrong=()=>attemptDurableInstagram(sb,evText(c2,b,"mid.dup.3","nope"));
   await Promise.all([wrong(),wrong(),wrong()]);await wrong();
   assert.equal((await effectsOf(c2)).length,3,"welcome + question + exactly one re-ask");
   assert.deepEqual((await runRow(c2))[0].variables,{[reaskField("askEmail")]:"1"});
  });

  await t.step("typed answers (d): messages not belonging to the waiting question leave the run intact; button flows unchanged",async()=>{
   await freshDb();resetMeta();await activate("collect",true);
   const c=await conv("9500001");const m=await inbound(c,"mid.unrel.0");
   assert.equal(await attemptDurableInstagram(sb,evText(c,m,"mid.unrel.0","hi")),"handled");
   const before=await runRow(c);const fx=(await effectsOf(c)).length;
   // A (stale) button tap while a typed question waits: V2, run untouched.
   for(const [mid,choice] of [["mid.unrel.1","prices"],["mid.unrel.2","old_option"]]){
    const i=await inbound(c,mid);
    assert.equal(await attemptDurableInstagram(sb,evText(c,i,mid,"الأسعار",choice)),"fallback");
    assert.equal(await val(`SELECT count(*)::int FROM public.automation_message_claims WHERE provider_event_id='${mid}'`),0);
   }
   // Another conversation of the same tenant: starts its own run only.
   const other=await conv("9500002");const om=await inbound(other,"mid.unrel.3");
   assert.equal(await attemptDurableInstagram(sb,evText(other,om,"mid.unrel.3","ali@shop.example")),"handled");
   assert.deepEqual((await runRow(other)).map(r=>[r.run_status,r.current_node_id,r.variables]),[["awaiting_input","askEmail",{}]],
    "a first message is never an answer");
   // A tenant-B event naming this conversation is refused by scope.
   const bm=await inbound(c,"mid.unrel.4");
   assert.equal(await attemptDurableInstagram(sb,{...evText(c,bm,"mid.unrel.4","x@y.example"),tenantId:B,accountId:ACCB}),"fallback");
   assert.deepEqual(await runRow(c),before,"status, node, step and variables unchanged");
   assert.equal((await effectsOf(c)).length,fx);
   // Old durable shape: free text (now carrying text) on a BUTTON question still cancels as free_text.
   await activate("collect",false);await activate("buttons",true);
   const bc=await conv("9500003");const b0=await inbound(bc,"mid.unrel.5");
   assert.equal(await attemptDurableInstagram(sb,evText(bc,b0,"mid.unrel.5","hi")),"handled");
   const b1=await inbound(bc,"mid.unrel.6");
   assert.equal(await attemptDurableInstagram(sb,evText(bc,b1,"mid.unrel.6","ali@shop.example")),"fallback");
   assert.deepEqual((await runsOf(bc)).map(r=>[r.run_status,r.ended_reason]),[["blocked","free_text"]]);
  });

  await t.step("typed answers (e): worker restarts between the answer and its delivery; answer -> delay -> wake; exactly-once sends",async()=>{
   await freshDb();resetMeta();await activate("collectdelay",true);
   const c=await conv("9600001");const m=await inbound(c,"mid.rs.0");
   assert.equal(await attemptDurableInstagram(sb,evText(c,m,"mid.rs.0","hi")),"handled");
   let o=await outboxTick();assert.equal(o.body.status.settled,1);
   assert.deepEqual(sentTexts(),["ما رقم هاتفك؟"]);resetMeta();
   const a=await inbound(c,"mid.rs.1");
   assert.equal(await attemptDurableInstagram(sb,evText(c,a,"mid.rs.1","+964 770-123-4567")),"handled");
   let runs=await runRow(c);
   assert.deepEqual(runs.map(r=>[r.run_status,r.current_node_id,r.variables]),[["sleeping","wait",{phone:"+9647701234567"}]]);
   // The outbox worker "crashed" before delivering: a NEW instance delivers once.
   const outbox2=await freshHandler("../supabase/functions/flow-outbox-worker/index.ts","restart-1");
   assert.notEqual(outbox2,outboxWorker);
   o=await tick(outbox2);
   assert.equal(o.status,200);
   assert.deepEqual(sentTexts(),["تم حفظ رقمك +9647701234567"]);
   await Promise.all([tick(outbox2),outboxTick()]);assert.equal(meta.calls.length,1);
   // Replay of the answer while sleeping: inert.
   assert.equal(await attemptDurableInstagram(sb,evText(c,a,"mid.rs.1","+964 770-123-4567")),"handled");
   const runId=(await runsOf(c))[0].id;
   await exec(`UPDATE public.automation_flow_runs SET wake_at=now()-interval '1 second' WHERE id='${runId}';`);
   // Runtime worker #1 leases the due run and crashes; lease expires; a NEW instance wakes it.
   const lease=await rows<{lease_token:string}>(`SELECT lease_token FROM public.flow_lease_due_runs(20)`,"service_role");
   assert.equal(lease.length,1);
   let w=await runtimeTick();assert.equal(w.body.leased,0);
   await exec(`UPDATE public.automation_flow_run_leases SET expires_at=now()-interval '1 second' WHERE run_id='${runId}';`);
   const runtime2=await freshHandler("../supabase/functions/flow-runtime-worker/index.ts","restart-1");
   w=await tick(runtime2);
   assert.equal(w.body.leased,1);assert.equal(w.body.committed,1,JSON.stringify(w.body));
   runs=await runRow(c);
   assert.deepEqual(runs.map(r=>[r.run_status,r.current_node_id,r.variables]),[["completed","done",{phone:"+9647701234567"}]]);
   w=await tick(runtime2);assert.equal(w.body.leased,0);
   o=await tick(outbox2);await outboxTick();
   assert.deepEqual(sentTexts(),["تم حفظ رقمك +9647701234567","سنتصل بك على +9647701234567"]);
   assert.equal(await val(`SELECT count(*)::int FROM public.automation_flow_delivery_attempts a
    JOIN public.automation_flow_outbox o ON o.tenant_id=a.tenant_id AND o.id=a.outbox_id WHERE o.run_id='${runId}'`),3,
    "question + saved + follow-up: one provider attempt each");
  });

  await t.step("internal actions: welcome -> email -> tag -> notify -> handoff message -> handoff; order, exactly once, takeover, silence, replays, tenant isolation",async()=>{
   await freshDb();resetMeta();await activate("handoff",true);
   const {runInternalEffects}=await import("../supabase/functions/flow-internal-worker/internalEffects.ts");
   const internalTick=()=>runInternalEffects(sb,{canaryAccountId:ACC});
   Deno.env.set("FLOW_INTERNAL_ACTIONS_ENABLED","true");
   try{
    const OWNER_A="99999999-9999-4999-8999-999999999999";
    // One commit shares created_at: order by (created_at, payload.seq) like the workers.
    const ordered=(cv:string)=>rows<{id:string;effect_kind:string;delivery_status:string;cancel_reason:string|null;payload:any}>(
     `SELECT o.id,o.effect_kind,o.delivery_status,o.cancel_reason,o.payload FROM public.automation_flow_outbox o
      JOIN public.automation_flow_runs r ON r.tenant_id=o.tenant_id AND r.id=o.run_id
      WHERE r.conversation_id='${cv}' ORDER BY o.created_at,coalesce((o.payload->>'seq')::int,0),o.id`);
    const c=await conv("9700001");const m1=await inbound(c,"mid.h.1");
    assert.equal(await attemptDurableInstagram(sb,evText(c,m1,"mid.h.1","hi")),"handled");
    let o=await outboxTick();
    assert.equal(o.body.status.settled,2,JSON.stringify(o.body));
    assert.deepEqual(sentTexts(),["أهلاً بك","ما بريدك الإلكتروني؟"]);
    // Answer: tag, notify, handoff message and handoff in ONE commit; the run ends in 'handoff'.
    const m2=await inbound(c,"mid.h.2");
    assert.equal(await attemptDurableInstagram(sb,evText(c,m2,"mid.h.2","Ali@Shop.Example")),"handled");
    assert.deepEqual((await runRow(c)).map(r=>[r.run_status,r.current_node_id,r.variables]),
     [["handoff","human",{email:"ali@shop.example"}]]);
    let fx=await ordered(c);
    assert.deepEqual(fx.map(e=>[e.effect_kind,e.payload.seq??null,e.delivery_status]),[
     ["message",0,"settled"],["question",1,"settled"],["tag",0,"pending"],["staff_notification",1,"pending"],
     ["message",2,"pending"],["handoff",3,"pending"]]);
    // Customer writes again before the handoff is executed: silent (no claim, no run, no V2).
    const m3=await inbound(c,"mid.h.3");
    assert.equal(await attemptDurableInstagram(sb,evText(c,m3,"mid.h.3","hello?")),"handled");
    assert.equal(await val(`SELECT count(*)::int FROM public.automation_message_claims WHERE provider_event_id='mid.h.3'`),0);
    assert.equal((await runsOf(c)).length,1);
    // Internal pass BEFORE the message is sent: tag + notify run, the handoff waits for its message.
    let it=await internalTick();
    assert.equal(it.tag_applied,1,JSON.stringify(it));assert.equal(it.staff_notification_applied,1);
    assert.equal(it.held_order,1);
    assert.deepEqual(await rows(`SELECT transferred,auto_paused_reason FROM public.conversations WHERE id='${c}'`),
     [{transferred:false,auto_paused_reason:null}]);
    // Outbox tick: the handoff message goes out FIRST, then the same tick switches the conversation.
    const before=Date.now();
    o=await outboxTick();
    const after=Date.now();
    assert.equal(o.body.status.settled,1,JSON.stringify(o.body));
    assert.equal(o.body.internal.handoff_applied,1,JSON.stringify(o.body));
    assert.deepEqual(sentTexts(),["أهلاً بك","ما بريدك الإلكتروني؟","سيتواصل معك موظف الآن"]);
    const conv1=(await rows<{transferred:boolean;auto_paused_reason:string;human_agent_expires_at:string}>(
     `SELECT transferred,auto_paused_reason,human_agent_expires_at FROM public.conversations WHERE id='${c}'`))[0];
    assert.equal(conv1.transferred,true);assert.equal(conv1.auto_paused_reason,"ai_handoff");
    const exp=Date.parse(conv1.human_agent_expires_at);
    assert.ok(exp>=before+15*60000-1000&&exp<=after+15*60000+1000,"same 15 min expiry as the existing handoff");
    assert.equal(await val(`SELECT public.flow_conversation_human_takeover('${A}','${c}')`,"service_role"),true,
     "existing takeover helper sees the handoff");
    fx=await ordered(c);
    assert.ok(fx.every(e=>e.delivery_status==="settled"),JSON.stringify(fx.map(e=>e.delivery_status)));
    assert.deepEqual(await rows(`SELECT tag,created_by_outbox::text AS src FROM public.flow_conversation_tags WHERE conversation_id='${c}'`),
     [{tag:"lead",src:fx.find(e=>e.effect_kind==="tag")!.id}]);
    assert.deepEqual(await rows(`SELECT tenant_id::text AS t,recipient_user_id::text AS u,body,status FROM public.flow_staff_notifications WHERE conversation_id='${c}'`),
     [{t:A,u:OWNER_A,body:"عميل جديد ali@shop.example",status:"queued"}]);
    // Exactly once: more ticks (outbox + standalone executor, concurrently) change nothing.
    await Promise.all([outboxTick(),internalTick(),internalTick()]);await outboxTick();
    assert.equal(meta.calls.length,3);
    assert.equal(await val(`SELECT count(*)::int FROM public.flow_conversation_tags`),1);
    assert.equal(await val(`SELECT count(*)::int FROM public.flow_staff_notifications`),1);
    assert.deepEqual(await rows(`SELECT effect_kind,attempts FROM public.automation_flow_outbox WHERE effect_kind IN('tag','staff_notification','handoff') ORDER BY effect_kind`),
     [{effect_kind:"handoff",attempts:1},{effect_kind:"staff_notification",attempts:1},{effect_kind:"tag",attempts:1}]);
    // Duplicate redelivery: replays of the claimed answer/trigger are inert; the inbound index stops them earlier.
    assert.equal(await attemptDurableInstagram(sb,evText(c,m2,"mid.h.2","Ali@Shop.Example")),"handled");
    assert.equal(await attemptDurableInstagram(sb,evText(c,m1,"mid.h.1","hi")),"handled");
    const dup=await psql(db,`SELECT it.inbound('${A}','${c}','mid.h.2');`);
    assert.equal(dup.ok,false);assert.equal(sqlError(dup.err).code,"23505");
    assert.equal((await runsOf(c)).length,1);assert.equal((await effectsOf(c)).length,6);
    // Next inbound after the takeover: milan-api/index.ts returns at `if (conv.transferred)`
    // BEFORE the durable/V2 routing (source order pinned), so no automated reply...
    const server=Deno.readTextFileSync(repo+"supabase/functions/milan-api/index.ts");
    const takeoverReturn=server.indexOf("conversation transferred: ${conv.id}");
    assert.ok(takeoverReturn>0&&takeoverReturn<server.indexOf("const durable=await attemptDurableInstagram(sb,{"));
    assert.ok(takeoverReturn<server.indexOf("const outcome = await processExclusiveEvent({"));
    // ...and even if a run were started anyway, its messages are skipped as human_takeover.
    const m4=await inbound(c,"mid.h.4");
    assert.equal(await attemptDurableInstagram(sb,evText(c,m4,"mid.h.4","still there?")),"handled");
    await outboxTick();
    assert.equal(meta.calls.length,3,"no automated reply after the handoff");
    assert.ok((await effectsOf(c)).filter(e=>e.delivery_status==="cancelled").every(e=>e.cancel_reason==="human_takeover"));
    assert.equal((await rows(`SELECT transferred FROM public.conversations WHERE id='${c}'`))[0].transferred,true);
    // Cross-tenant negative: a tenant-B internal effect (own run/conversation, non-canary account) is
    // never executed and never touches tenant A; a forged tenant-B run on tenant A's conversation is
    // refused by the composite FKs.
    const cb=await conv("9700002",B,ACCB);
    await exec(`INSERT INTO public.automation_flow_event_receipts(tenant_id,channel_account_id,platform,provider_event_id)
     VALUES('${B}','${ACCB}','instagram','mid.hb.1');
     INSERT INTO public.automation_flow_runs(tenant_id,id,flow_key,publication_revision,channel_account_id,platform,conversation_id,provider_event_id,current_node_id,run_status)
     VALUES('${B}','77777777-7777-4777-8777-7777777777b9','bflow',1,'${ACCB}','instagram','${cb}','mid.hb.1','yes','completed');
     INSERT INTO public.automation_flow_outbox(tenant_id,run_id,idempotency_key,effect_kind,payload)
     VALUES('${B}','77777777-7777-4777-8777-7777777777b9','b-tag','tag','{"kind":"tag","tag":"lead","seq":0}'),
           ('${B}','77777777-7777-4777-8777-7777777777b9','b-hand','handoff','{"kind":"handoff","seq":1}');`);
    it=await internalTick();
    assert.equal(it.blocked_canary,1,JSON.stringify(it));
    assert.deepEqual(await rows(`SELECT effect_kind,delivery_status FROM public.automation_flow_outbox WHERE tenant_id='${B}' ORDER BY effect_kind`),
     [{effect_kind:"handoff",delivery_status:"pending"},{effect_kind:"tag",delivery_status:"pending"}]);
    assert.equal(await val(`SELECT count(*)::int FROM public.flow_conversation_tags WHERE tenant_id='${B}'`),0);
    assert.equal((await rows(`SELECT transferred FROM public.conversations WHERE id='${cb}'`))[0].transferred,false);
    // Tenant B's queued handoff never silences tenant A, and A's settled one no longer silences anything.
    const ca=await conv("9700003");const ma=await inbound(ca,"mid.h.5");
    assert.equal(await attemptDurableInstagram(sb,evText(ca,ma,"mid.h.5","hi")),"handled");
    assert.deepEqual((await runRow(ca)).map(r=>[r.run_status,r.current_node_id]),[["awaiting_input","askEmail"]]);
    await exec(`INSERT INTO public.automation_flow_event_receipts(tenant_id,channel_account_id,platform,provider_event_id)
     VALUES('${B}','${ACCB}','instagram','mid.hb.2');`);
    const forged=await psql(db,`INSERT INTO public.automation_flow_runs(tenant_id,flow_key,publication_revision,channel_account_id,platform,conversation_id,provider_event_id,current_node_id,run_status)
     VALUES('${B}','bflow',1,'${ACCB}','instagram','${c}','mid.hb.2','yes','completed');`);
    assert.equal(forged.ok,false);assert.equal(sqlError(forged.err).code,"23503");
   }finally{Deno.env.delete("FLOW_INTERNAL_ACTIONS_ENABLED");}
  });

  await t.step("internal actions reliability on PostgreSQL: crash between write and settle, lease expiry, concurrent executors, final-attempt recovery, bounded failures visible in delivery review, forged scope refused",async()=>{
   await freshDb();resetMeta();await activate("handoff",true);
   const {runInternalEffects}=await import("../supabase/functions/flow-internal-worker/internalEffects.ts");
   // A supabase-js client whose selected update/insert calls never reach the
   // database (process killed / connection lost) and return the given error.
   type Hook=(table:string,op:"update"|"insert",row:Record<string,unknown>)=>null|{code:string;message:string};
   const hooked=(hook:Hook)=>({from(table:string){
    // deno-lint-ignore no-explicit-any
    const q:any=sb.from(table);
    // deno-lint-ignore no-explicit-any
    const failing=(e:unknown)=>{const f:any={eq:()=>f,lte:()=>f,is:()=>f,in:()=>f,select:()=>f,maybeSingle:()=>f,
     then:(res:(v:unknown)=>void)=>res({data:null,error:e})};return f;};
    for(const op of ["update","insert"] as const){const orig=q[op].bind(q);
     q[op]=(row:Record<string,unknown>)=>{const e=hook(table,op,row);return e?failing(e):orig(row);};}
    return q;
   }});
   const tickAt=(ms=0,client:unknown=sb)=>runInternalEffects(client as never,{canaryAccountId:ACC,now:()=>Date.now()+ms});
   let n=0;
   const mkRun=async(fx:Array<[string,Record<string,unknown>]>)=>{
    const c=await conv("98"+String(++n).padStart(5,"0"));
    const run=crypto.randomUUID(),mid="mid.rel."+n;
    await exec(`INSERT INTO public.automation_flow_event_receipts(tenant_id,channel_account_id,platform,provider_event_id)
      VALUES('${A}','${ACC}','instagram','${mid}');
     INSERT INTO public.automation_flow_runs(tenant_id,id,flow_key,publication_revision,channel_account_id,platform,conversation_id,provider_event_id,current_node_id,run_status)
      VALUES('${A}','${run}','handoff',1,'${ACC}','instagram','${c}','${mid}','human','handoff');
     INSERT INTO public.automation_flow_outbox(tenant_id,run_id,idempotency_key,effect_kind,payload) VALUES ${
      fx.map(([k,p],i)=>`('${A}','${run}','${run}:${i}','${k}',${lit({kind:k,...p,seq:i})})`).join(",")};`);
    return {c,run};
   };
   const fxOf=(run:string)=>rows<{id:string;effect_kind:string;delivery_status:string;attempts:number;leased:boolean}>(
    `SELECT id,effect_kind,delivery_status,attempts,lease_token IS NOT NULL AS leased FROM public.automation_flow_outbox
     WHERE run_id='${run}' ORDER BY (payload->>'seq')::int`);
   const st=async(run:string)=>(await fxOf(run)).map(e=>[e.effect_kind,e.delivery_status,e.attempts]);
   const tagsOf=async(c:string)=>(await rows<{tag:string}>(`SELECT tag FROM public.flow_conversation_tags WHERE conversation_id='${c}' ORDER BY tag`)).map(x=>x.tag);
   const notesOf=(c:string)=>val<number>(`SELECT count(*)::int FROM public.flow_staff_notifications WHERE conversation_id='${c}'`);
   const convOf=async(c:string)=>(await rows<{transferred:boolean;auto_paused_reason:string|null;human_agent_expires_at:string|null}>(
    `SELECT transferred,auto_paused_reason,human_agent_expires_at FROM public.conversations WHERE id='${c}'`))[0];
   Deno.env.set("FLOW_INTERNAL_ACTIONS_ENABLED","true");
   try{
    // (1)+(2) crash between write and settle: the committed write survives, the row stays leased,
    // a live lease is never reclaimed, an expired one is reclaimed once and the re-run is a no-op.
    const r1=await mkRun([["tag",{tag:"vip"}],["untag",{tag:"old"}],["staff_notification",{text:"راجع الطلب"}],["handoff",{}]]);
    const untagId=(await fxOf(r1.run))[1].id;
    await exec(`INSERT INTO public.flow_conversation_tags(tenant_id,conversation_id,tag,created_by_outbox) VALUES('${A}','${r1.c}','old','${untagId}')`);
    const loseSettle=hooked((table,op,row)=>table==="automation_flow_outbox"&&op==="update"&&row.delivery_status==="settled"?
     {code:"08006",message:"connection lost"}:null);
    let it=await tickAt(0,loseSettle);
    assert.equal(it.finish_failed,1,JSON.stringify(it));assert.equal(it.held_order,3);
    assert.deepEqual(await st(r1.run),[["tag","leased",1],["untag","pending",0],["staff_notification","pending",0],["handoff","pending",0]]);
    assert.deepEqual(await tagsOf(r1.c),["old","vip"],"the write committed before the crash");
    it=await tickAt(60000);
    assert.deepEqual(await st(r1.run),[["tag","leased",1],["untag","pending",0],["staff_notification","pending",0],["handoff","pending",0]],
     "a live lease is left alone: "+JSON.stringify(it));
    it=await tickAt(125000);
    assert.equal(it.tag_noop,1,JSON.stringify(it));assert.equal(it.untag_applied,1);
    assert.equal(it.staff_notification_applied,1);assert.equal(it.handoff_applied,1);
    assert.deepEqual(await st(r1.run),[["tag","settled",2],["untag","settled",1],["staff_notification","settled",1],["handoff","settled",1]]);
    assert.ok((await fxOf(r1.run)).every(e=>!e.leased),"no lease left behind");
    assert.deepEqual(await tagsOf(r1.c),["vip"]);assert.equal(await notesOf(r1.c),1);
    const conv1=await convOf(r1.c);
    assert.equal(conv1.transferred,true);assert.equal(conv1.auto_paused_reason,"ai_handoff");
    // Same for the notification and the handoff themselves: lost settle -> reclaim -> noop (no 2nd row, same expiry).
    for(const kind of ["staff_notification","handoff"]){
     const r1b=await mkRun([[kind,kind==="handoff"?{}:{text:"x"}]]);
     it=await tickAt(0,loseSettle);assert.equal(it.finish_failed,1,kind+" "+JSON.stringify(it));
     const exp=(await convOf(r1b.c)).human_agent_expires_at;
     it=await tickAt(150000);
     assert.equal(it[kind+"_noop"],1,kind+" "+JSON.stringify(it));
     assert.deepEqual(await st(r1b.run),[[kind,"settled",2]]);
     assert.equal(await notesOf(r1b.c),kind==="handoff"?0:1);
     assert.equal((await convOf(r1b.c)).human_agent_expires_at,exp,"a retry never moves the takeover expiry");
     if(kind==="handoff")assert.equal((await convOf(r1b.c)).transferred,true);
    }

    // (2)+(4) concurrent executors (standalone worker x2 + the outbox worker's internal pass) on pending effects.
    const r2=await mkRun([["tag",{tag:"lead"}],["staff_notification",{text:"عميل"}],["handoff",{}]]);
    await Promise.all([tickAt(),tickAt(),outboxTick()]);
    for(let i=0;i<4;i++)await Promise.all([tickAt(),tickAt()]);
    assert.deepEqual(await st(r2.run),[["tag","settled",1],["staff_notification","settled",1],["handoff","settled",1]],"one claim each");
    assert.deepEqual(await tagsOf(r2.c),["lead"]);assert.equal(await notesOf(r2.c),1);
    assert.equal(meta.calls.length,0,"internal effects never call Meta");

    // (2) the FINAL attempt crashes after its write (attempts=3): verified and settled, not a false dead_letter.
    const r3=await mkRun([["tag",{tag:"final"}]]);
    for(const ms of [0,130000,260000])await tickAt(ms,loseSettle);
    assert.deepEqual(await st(r3.run),[["tag","leased",3]]);
    it=await tickAt(390000);
    assert.equal(it.tag_recovered,1,JSON.stringify(it));
    assert.deepEqual(await st(r3.run),[["tag","settled",3]]);assert.deepEqual(await tagsOf(r3.c),["final"]);

    // (3)+(7) bounded failures: transient x3 -> dead_letter; invalid payload -> dead_letter at once (no claim);
    // a dead-lettered handoff leaves the conversation untouched and the run in its committed status.
    const r4=await mkRun([["staff_notification",{text:"secret note +9647700000001"}],["handoff",{}]]);
    const r5=await mkRun([["tag",{tag:"<b>bad</b>"}]]);
    const transient=hooked((table,op)=>(table==="flow_staff_notifications"||table==="conversations")&&
     (op==="insert"||op==="update")?{code:"57014",message:"canceling statement due to statement timeout"}:null);
    for(let i=0;i<4;i++)await tickAt(i*1000,transient);
    for(let i=0;i<3;i++)await tickAt(10000+i*1000,transient);
    assert.deepEqual(await st(r4.run),[["staff_notification","dead_letter",3],["handoff","dead_letter",3]]);
    assert.deepEqual(await st(r5.run),[["tag","dead_letter",0]]);
    assert.equal(await notesOf(r4.c),0);assert.equal((await convOf(r4.c)).transferred,false);
    assert.equal((await runRow(r4.c))[0].run_status,"handoff");
    assert.deepEqual(await tickAt(20000),{},"terminal rows are never retried");
    const review=await loadFlowReview(sb as never,A);
    const failed=review.flowFailures.filter(f=>[r4.run,r5.run].includes(String(f.run_id)))
     .map(f=>[f.effect_kind,f.delivery_status,f.attempts]).sort();
    assert.deepEqual(failed,[["handoff","dead_letter",3],["staff_notification","dead_letter",3],["tag","dead_letter",0]]);
    const shown=JSON.stringify(review);
    for(const secret of ["secret note","+9647700000001","<b>bad"])assert.equal(shown.includes(secret),false,secret);
    assert.equal((await loadFlowReview(sb as never,B)).flowFailures.length,0,"tenant-scoped review");

    // (6) forged scope: extra payload fields cannot redirect a write; cross-tenant rows are refused by the composite FKs.
    const cb=await conv("9800999",B,ACCB);
    const r6=await mkRun([["tag",{tag:"own",tenant_id:B,conversation_id:cb}]]);
    await tickAt();
    assert.deepEqual(await tagsOf(r6.c),["own"]);assert.deepEqual(await tagsOf(cb),[]);
    const crossOutbox=await psql(db,`INSERT INTO public.automation_flow_outbox(tenant_id,run_id,idempotency_key,effect_kind,payload)
     VALUES('${B}','${r6.run}','forged','tag','{"kind":"tag","tag":"x","seq":0}');`);
    assert.equal(crossOutbox.ok,false);assert.equal(sqlError(crossOutbox.err).code,"23503");
    const r6id=(await fxOf(r6.run))[0].id;
    const crossTag=await psql(db,`INSERT INTO public.flow_conversation_tags(tenant_id,conversation_id,tag,created_by_outbox)
     VALUES('${A}','${cb}','x','${r6id}');`,"service_role");
    assert.equal(crossTag.ok,false);assert.equal(sqlError(crossTag.err).code,"23503");
    const crossNote=await psql(db,`INSERT INTO public.flow_staff_notifications(tenant_id,outbox_id,conversation_id,recipient_user_id,body)
     VALUES('${B}','${r6id}','${cb}','88888888-8888-4888-8888-888888888888','x');`,"service_role");
    assert.equal(crossNote.ok,false);assert.equal(sqlError(crossNote.err).code,"23503");
    assert.equal(await val(`SELECT count(*)::int FROM public.flow_conversation_tags WHERE tenant_id='${B}'`),0);
   }finally{Deno.env.delete("FLOW_INTERNAL_ACTIONS_ENABLED");}
  });

  await t.step("worker endpoints refuse unauthenticated ticks before touching the database",async()=>{
   const before=restLog.length;
   assert.equal((await tick(outboxWorker,"Bearer wrong")).status,401);
   assert.equal((await tick(runtimeWorker,"Bearer wrong")).status,401);
   assert.equal(restLog.length,before);
  });
 }finally{
  globalThis.fetch=realFetch;
  if(started)asServer("pg_ctl",["-D",dir+"/data","-m","fast","-w","stop"]);
  await Deno.remove(dir,{recursive:true}).catch(()=>{});
 }
});
