// HTTP integration of the actual Deno Edge handler, using a disposable
// signed-JWT Auth/PostgREST stand-in. No production credentials or network.
import {assert,assertEquals} from "jsr:@std/assert@1";
import {handleFlowPublication} from "../supabase/functions/flow-publication/index.ts";
import {makeNode,edgeFor} from "../src/flow/model.ts";
import type {createClient} from "npm:@supabase/supabase-js@2";

const ORIGIN="https://hsnq2022022-cyber.github.io";
const userA="99999999-9999-4999-8999-999999999999";
const userB="88888888-8888-4888-8888-888888888888";
const tenantA="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const tenantB="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const accountA="11111111-1111-4111-8111-111111111111";
const accountB="22222222-2222-4222-8222-222222222222";
const secret="disposable-http-test-hs256-secret-not-production";
const encoder=new TextEncoder();

function base64url(b:Uint8Array):string{
 return btoa(Array.from(b,x=>String.fromCharCode(x)).join(""))
  .replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
}
async function signature(message:string):Promise<string>{
 const key=await crypto.subtle.importKey("raw",encoder.encode(secret),
  {name:"HMAC",hash:"SHA-256"},false,["sign"]);
 return base64url(new Uint8Array(await crypto.subtle.sign("HMAC",key,encoder.encode(message))));
}
async function issue(sub:string,exp:number):Promise<string>{
 const input=base64url(encoder.encode(JSON.stringify({alg:"HS256",typ:"JWT"})))+"."+
  base64url(encoder.encode(JSON.stringify({sub,exp,role:"authenticated"})));
 return input+"."+await signature(input);
}
async function validate(jwt:string):Promise<string|null>{
 const parts=jwt.split(".");
 if(parts.length!==3||parts[2]!==await signature(parts.slice(0,2).join(".")))
  return null;
 try{
  const body=JSON.parse(atob(parts[1].replace(/-/g,"+").replace(/_/g,"/")));
  if(typeof body.sub!=="string"||typeof body.exp!=="number"||
    body.exp<=Math.floor(Date.now()/1000))return null;
  return body.sub;
 }catch{return null;}
}
type Row=Record<string,unknown>;
const tenants:Row[]=[
 {id:tenantA,user_id:userA,is_active:true},
 {id:tenantB,user_id:userB,is_active:true}
];
const accounts:Row[]=[
 {id:accountA,tenant_id:tenantA,platform:"instagram",is_active:true,agent_enabled:true,auto_reply:true},
 {id:accountB,tenant_id:tenantB,platform:"facebook",is_active:true,agent_enabled:true,auto_reply:true}
];
const publications:Row[]=[];
const activations:Row[]=[{tenant_id:tenantB,channel_account_id:accountB,
 platform:"facebook",flow_key:"b_flow",revision:1,is_active:true}];
const counters=new Map<string,number>();

function tableRows(table:string):Row[]{
 if(table==="tenants")return tenants;
 if(table==="channel_accounts")return accounts;
 if(table==="automation_flow_publications")return publications;
 if(table==="automation_flow_activations")return activations;
 throw Error("Unexpected table "+table);
}
function query(table:string){
 const constraints=new Map<string,unknown>();
 const execute=()=>tableRows(table).filter(row=>
  Array.from(constraints).every(([key,value])=>row[key]===value));
 const q={
  select(_s:string){return q;},
  eq(key:string,value:unknown){constraints.set(key,value);return q;},
  order(_s:string,_options?:unknown){return q;},
  limit(_n:number){return Promise.resolve({data:execute(),error:null});},
  maybeSingle(){return Promise.resolve({data:execute()[0]??null,error:null});}
 };
 return q;
}
const factory=((_url:string,_serviceKey:string,_options:unknown)=>({
 auth:{async getUser(token:string){
  const sub=await validate(token);
  return sub?{data:{user:{id:sub}},error:null}
   :{data:{user:null},error:{message:"JWT expired or invalid"}};
 }},
 from:query,
 async rpc(name:string,args:Record<string,unknown>){
  if(name==="flow_publication_rate_allow"){
   const key=String(args.p_tenant_id)+"|"+Math.floor(Date.now()/60000);
   const used=(counters.get(key)??0)+1;
   if(used<=30)counters.set(key,used);
   return {data:used<=30,error:null};
  }
  if(name==="flow_publish_revision"){
   const owned=tenants.some(t=>t.id===args.p_tenant_id&&t.user_id===args.p_actor_id);
   const account=accounts.some(a=>a.id===args.p_account_id&&a.tenant_id===args.p_tenant_id&&a.platform===args.p_platform);
   if(!owned||!account)return {data:null,error:null};
   const revision=1+publications.filter(p=>p.tenant_id===args.p_tenant_id&&p.flow_key===args.p_flow_key).length;
   publications.push({tenant_id:args.p_tenant_id,channel_account_id:args.p_account_id,
    platform:args.p_platform,flow_key:args.p_flow_key,revision,
    document:args.p_document,created_at:new Date().toISOString()});
   return {data:revision,error:null};
  }
  if(name==="flow_deactivate_revision"){
   const owned=tenants.some(t=>t.id===args.p_tenant_id&&t.user_id===args.p_actor_id);
   const a=activations.find(a=>a.tenant_id===args.p_tenant_id&&
    a.channel_account_id===args.p_account_id&&a.flow_key===args.p_flow_key);
   if(owned&&a){a.is_active=false;return {data:true,error:null};}
   return {data:false,error:null};
  }
  if(name==="flow_activate_revision")return {data:false,error:null};
  return {data:null,error:{code:"UNKNOWN_RPC"}};
 }
})) as unknown as typeof createClient;

function document(platform:"instagram"|"messenger"){
 const start=makeNode("trigger",{x:0,y:0},{platform,triggerMode:"message",keywords:""});
 const msg=makeNode("message",{x:0,y:180},{text:"Hello",options:[]});
 return {version:3,name:"Test",nodes:[start,msg],edges:[
  edgeFor({source:start.id,sourceHandle:"next",target:msg.id,targetHandle:"in"})
 ]};
}
Deno.test("HTTP: signed A/B JWT, foreign tenant blocked, expired token 401, per-tenant 429",async()=>{
 Deno.env.set("SUPABASE_URL","http://localhost:54321");
 Deno.env.set("SUPABASE_SERVICE_ROLE_KEY","fake-disposable-test-key");
 Deno.env.delete("FLOW_PUBLICATION_CANARY_READY");
 const server=Deno.serve({hostname:"127.0.0.1",port:0,onListen:()=>{}},
  (req)=>handleFlowPublication(req,factory));
 const endpoint=`http://127.0.0.1:${(server.addr as Deno.NetAddr).port}/flow-publication`;
 const tokenA=await issue(userA,Math.floor(Date.now()/1000)+600);
 const tokenB=await issue(userB,Math.floor(Date.now()/1000)+600);
 const expired=await issue(userA,Math.floor(Date.now()/1000)-60);
 async function post(token:string|undefined,body:Row,origin=ORIGIN){
  return await fetch(endpoint,{method:"POST",headers:{
   "origin":origin,"content-type":"application/json",
   ...(token?{authorization:"Bearer "+token}:{})
  },body:JSON.stringify(body)});
 }
 try{
  assertEquals((await post(undefined,{action:"accounts"})).status,401);
  assertEquals((await post(expired,{action:"accounts"})).status,401);
  const foreign=await post(tokenA,{action:"accounts"},"https://evil.example");
  assertEquals(foreign.status,403);
  assertEquals(foreign.headers.get("access-control-allow-origin"),null);

  // B can publish its own flow.
  const ownB=await post(tokenB,{action:"publish",accountId:accountB,flowKey:"b_flow",
    document:document("messenger")});
  assertEquals(ownB.status,200);
  // A cannot publish, activate or deactivate B, even with forged tenantId.
  for(const action of ["publish","activate","deactivate"]){
   const res=await post(tokenA,{action,tenantId:tenantB,accountId:accountB,
    flowKey:"b_flow",revision:1,document:document("messenger")});
   assertEquals(res.status,403,"cross-tenant "+action);
  }
  assertEquals(publications.filter(p=>p.tenant_id===tenantB).length,1);
  assert(activations.some(a=>a.tenant_id===tenantB&&a.is_active===true));

  // A can publish only A's document.
  assertEquals((await post(tokenA,{action:"publish",tenantId:tenantB,
   accountId:accountA,flowKey:"a_flow",document:document("instagram")})).status,200);
  // Canary remains OFF even when B is the authenticated owner.
  assertEquals((await post(tokenB,{action:"activate",accountId:accountB,
   flowKey:"b_flow",revision:1})).status,423);

  // Shared counter returns HTTP 429 after 30 accepted requests per tenant.
  let exceeded=false;
  for(let i=0;i<35;i++){
   const res=await post(tokenA,{action:"accounts"});
   if(res.status===429){
    assert(res.headers.has("retry-after"));
    exceeded=true;break;
   }
   assertEquals(res.status,200);
  }
  assert(exceeded,"Expected tenant A to receive HTTP 429");
  // B's budget is independent from A's.
  assertEquals((await post(tokenB,{action:"accounts"})).status,200);
  console.log("PASS HTTP: no JWT 401; expired JWT 401; cross-tenant publish/activate/deactivate 403; canary 423; A 429; B 200");
 }finally{await server.shutdown();}
});
