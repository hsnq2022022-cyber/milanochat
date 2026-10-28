#!/usr/bin/env node
/**
 * Future protected CI execution ONLY. Does not run on checkout or import.
 * Destructive operations strictly limited to generated flowtest rows.
 * No third-party Meta API sends. No production actions authorized by file.
 */
import {createClient} from "@supabase/supabase-js";
import {randomBytes,createHmac,randomUUID} from "node:crypto";
import {readFile,writeFile,chmod} from "node:fs/promises";
import assert from "node:assert/strict";

const PROJECT="nmhefwvhoholcjrbbila";
const URL="https://"+PROJECT+".supabase.co";
const STATE=process.env.FLOW_TEST_STATE;
const anonKey=process.env.SUPABASE_ANON_KEY;
const service=process.env.SUPABASE_SERVICE_ROLE_KEY;
const jwtSecret=process.env.SUPABASE_JWT_SECRET;
const origin="https://hsnq2022022-cyber.github.io";
assert.equal(process.env.SUPABASE_URL,URL,"Refuse wrong Supabase project");
assert(STATE&&anonKey&&service&&jwtSecret,"Required protected secrets/state path missing");
const admin=createClient(URL,service,{auth:{persistSession:false,autoRefreshToken:false}});
const publicClient=()=>createClient(URL,anonKey,{auth:{persistSession:false,autoRefreshToken:false}});
const state=await readFile(STATE,"utf8").then(JSON.parse).catch(()=>({users:[],tenants:[],accounts:[],widgets:[],sessions:[],messages:[],timestamp:new Date().toISOString()}));
async function save(){await writeFile(STATE,JSON.stringify(state),{mode:0o600});await chmod(STATE,0o600);}
function hard(result,label){if(result.error)throw Error(label+" "+(result.error.code??"db_error")+" "+result.error.message);return result.data;}
async function count(table,filter=null){
 let q=admin.from(table).select("id",{count:"exact",head:true});
 if(table==="reply_ledger")q=admin.from(table).select("id",{count:"exact",head:true});
 if(filter){for(const [k,v] of Object.entries(filter))q=q.eq(k,v);}
 const r=await q;hard(r,"count "+table);return r.count;
}
async function snapshot(){
 const [tenants,accounts,conversations,widgetMessages,ledger,widgetLedger,delivery,outbox,flows,windows]=await Promise.all([
  count("tenants"),count("channel_accounts"),count("conversations"),count("widget_messages"),
  count("reply_ledger"),count("widget_reply_ledger"),count("automation_delivery_attempts"),
  count("automation_flow_outbox"),count("automation_flow_activations",{is_active:true}),
  count("flow_publication_rate_windows")
 ]);
 const historicalAnswers=await count("widget_messages",{direction:"out",kind:"answer"});
 const global=hard(await admin.from("automation_flow_global_switch").select("enabled").eq("singleton",true).single(),"global");
 const enabledTenant=await count("automation_flow_tenant_switches",{enabled:true});
 return {tenants,accounts,conversations,widgetMessages,ledger,widgetLedger,delivery,outbox,flows,windows,historicalAnswers,globalOff:global.enabled===false,enabledTenant};
}
const expected={tenants:10,accounts:4,conversations:4,widgetMessages:12,ledger:3,widgetLedger:0,delivery:0,outbox:0,flows:0,historicalAnswers:5,globalOff:true,enabledTenant:0};
function coreMatches(s){for(const [key,v] of Object.entries(expected))assert.equal(s[key],v,"Unexpected production baseline drift "+key);}
async function newUser(letter){
 const label="flowtest-"+letter+"-"+Date.now().toString(36)+"-"+randomBytes(5).toString("hex");
 const email=label+"@example.test",password=randomBytes(32).toString("base64url");
 const created=hard(await admin.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{purpose:"flow-release-smoke"}}),"createUser");
 assert(created?.user?.id,"Missing Auth ID");
 const user={id:created.user.id,email,password};state.users.push(user);await save();
 const tenant=hard(await admin.from("tenants").insert({
  user_id:user.id,business_name:label,source_type:"manual",
  is_active:false,credits_remaining:0
 }).select("id").single(),"create tenant");
 state.tenants.push(tenant.id);await save();
 const account=hard(await admin.from("channel_accounts").insert({
  tenant_id:tenant.id,platform:"instagram",channel:"instagram",
  account_name:label,is_active:false,agent_enabled:false,auto_reply:false,
  platform_account_id:label,external_id:label
 }).select("id").single(),"create channel account");
 state.accounts.push(account.id);await save();
 return {user,tenantId:tenant.id,accountId:account.id};
}
async function request(path,body,token,extra={}){
 const headers={"content-type":"application/json","apikey":anonKey,"origin":origin,...extra};
 if(token)headers.authorization="Bearer "+token;
 const res=await fetch(URL+"/functions/v1/"+path,{method:"POST",headers,body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
 const data=await res.json().catch(()=>null);
 return {status:res.status,data,headers:res.headers};
}
async function widgetSmoke(phase){
 const token=state.widgets[0]?.public_token;
 assert(token,"No disposable Widget");
 const meta=await request("milan-api?action=widget_public",{token},anonKey);
 assert.equal(meta.status,200,"Widget public HTTP");
 assert.equal(meta.data?.enabled,true);
 const session=await request("milan-api?action=widget_session",{
  token,visitorId:"flowtest-visitor-"+state.users[0].id
 },anonKey);
 assert.equal(session.status,200,"Widget session HTTP");
 assert(typeof session.data?.sessionId==="string","Missing sessionId");
 if(!state.sessions.includes(session.data.sessionId)){
  state.sessions.push(session.data.sessionId);await save();
 }
 const reply=await request("milan-api?action=widget_message",{
  token,sessionId:session.data.sessionId,message:"flowtest: independent Widget smoke "+phase
 },anonKey);
 assert.equal(reply.status,200,"Widget message HTTP");
 assert.equal(typeof reply.data?.reply,"string","Widget response missing");
 assert(reply.data.reply.length>0);
 assert.equal(reply.data.kind,"error","Inactive test store must use legacy safe refusal");
 // Explicit non-billing parity. Feature flags must remain OFF, and 0 credits.
 assert.equal(await count("widget_reply_ledger",{tenant_id:state.tenants[0]}),0,
  "Widget charged even though billing flag OFF");
 assert.equal(await count("reply_ledger",{tenant_id:state.tenants[0]}),0);
 const result={reply:reply.data.reply,kind:reply.data.kind};
 if(phase==="before")state.oldBehavior=result;
 else assert.deepEqual(result,state.oldBehavior,"Source 101 behavior differs after deploy");
 await save();console.log("PASS Widget "+phase+": HTTP 200; old response parity; ledger=0 (flags OFF)");
}
function expiredJWT(sub){
 const b64=x=>Buffer.from(JSON.stringify(x)).toString("base64url");
 const first=b64({alg:"HS256",typ:"JWT"});
 const body=b64({sub,role:"authenticated",iss:URL+"/auth/v1",aud:"authenticated",
   exp:Math.floor(Date.now()/1000)-60,iat:Math.floor(Date.now()/1000)-3600});
 const message=first+"."+body;
 return message+"."+createHmac("sha256",jwtSecret).update(message).digest("base64url");
}
async function authJwt(user){
 const result=hard(await publicClient().auth.signInWithPassword({email:user.email,password:user.password}),"sign in");
 assert(result?.session?.access_token,"Missing true Auth session");
 return result.session.access_token;
}
async function liveAB(){
 const [a,b]=await Promise.all(state.users.map(authJwt));
 const aAccount=state.accounts[0],bAccount=state.accounts[1];
 const noJwt=await request("flow-publication",{action:"accounts"});
 const expired=await request("flow-publication",{action:"accounts"},expiredJWT(state.users[0].id));
 assert.equal(noJwt.status,401,"no JWT must return 401");
 assert.equal(expired.status,401,"signed expired JWT must return 401");
 const ownB=await request("flow-publication",{action:"accounts"},b);
 assert.equal(ownB.status,200,"B's own authenticated accounts should be 200");
 assert(ownB.data.accounts?.some(x=>x.id===bAccount),"B channel account missing");
 for(const action of ["publish","activate","deactivate"]){
  const attempt=await request("flow-publication",{
   action,tenantId:state.tenants[1],accountId:bAccount,
   flowKey:"flowtest_private",revision:1,
   document:{version:3,name:"unsafe foreign",nodes:[],edges:[]}
  },a);
  assert.equal(attempt.status,403,"Cross-store "+action+" rejected");
 }
 const ownList=await request("flow-publication",{
  action:"list",accountId:bAccount,flowKey:"flowtest_private"
 },b);
 assert.equal(ownList.status,200,"B own list should be 200, no publication written");
 // Never publish an immutable test revision: publication's BEFORE DELETE trigger
 // would block fixture cleanup. This is a deliberate limitation of live smoke.
 assert.equal(await count("automation_flow_publications",{tenant_id:state.tenants[1]}),0);
 const disable=await request("flow-publication",{
  action:"activate",accountId:bAccount,flowKey:"flowtest_private",revision:1
 },b);
 assert([403,423].includes(disable.status),"inactive/canary-OFF B activation must not succeed");
 // 30/min fixed limiter. Execute rapidly and fail if crossing the UTC boundary.
 let got429=false;
 for(let i=0;i<40;i++){
  const response=await request("flow-publication",{action:"accounts"},a);
  if(response.status===429){got429=true;break;}
  assert.equal(response.status,200,"A limiter test before 429");
 }
 assert(got429,"A 30/min limiter failed");
 assert.equal((await request("flow-publication",{action:"accounts"},b)).status,200,
  "B's independent rate budget");
 console.log("PASS Auth A/B: 401 anonymous/expired; A->B publish/activate/deactivate 403; B 200; A 429; B still 200; canary OFF");
}
async function cleanup(){
 const issues=[];
 async function remove(table,column,values){
  for(const id of [...values].reverse()){
   try{
    const result=await admin.from(table).delete().eq(column,id).select(column);
    hard(result,"delete "+table);
    console.log("DELETED "+table+" rows="+(result.data?.length??0));
    if(result.data?.length!==1)issues.push("Missing "+table+" fixture");
   }catch(e){issues.push(table+":"+(e instanceof Error?e.message:"unknown"));}
  }
 }
 // Only test-created IDs are ever passed to delete.
 try{
  for(const tid of state.tenants){
   const del=await admin.from("flow_publication_rate_windows").delete().eq("tenant_id",tid).select("tenant_id");
   hard(del,"rate windows cleanup");
   console.log("DELETED rate windows rows="+(del.data?.length??0));
  }
 }catch(e){issues.push("rate windows: "+String(e));}
 for(const tenantId of state.tenants){
  for(const [table,column] of [["widget_messages","tenant_id"],["widget_reply_ledger","tenant_id"],
    ["automation_delivery_attempts","tenant_id"],["widget_sessions","tenant_id"],
    ["widgets","tenant_id"],["channel_accounts","tenant_id"]]){
   try{
    const result=await admin.from(table).delete().eq(column,tenantId).select(column);
    hard(result,table);
    console.log("DELETED "+table+" rows="+(result.data?.length??0));
   }catch(e){issues.push(table+":"+String(e));}
  }
 }
 await remove("tenants","id",state.tenants);
 for(const u of [...state.users].reverse()){
  try{hard(await admin.auth.admin.deleteUser(u.id),"delete Auth");
   console.log("DELETED auth.users rows=1");
  }catch(e){issues.push("Auth:"+String(e));}
 }
 await save();
 if(issues.length)throw Error("Fixture cleanup FAILED: "+issues.join("; "));
 const after=await snapshot();
 coreMatches(after);
 assert.deepEqual(after,state.baseline,"After cleanup does not match pretest snapshot");
 console.log("PASS CLEANUP: pre/post table counts equal; no test Auth users/tenants/widget/rate rows left");
}
const command=process.argv[2];
switch(command){
 case "preflight":{
  const base=await snapshot();coreMatches(base);
  state.baseline=base;await save();
  console.log("PASS baseline: 10 tenants, 4 accounts, 4 conversations, 12 Widget messages, 3 ledger, 5 old answers; switches OFF, outbox 0");
  break;
 }
 case "setup":{
  assert(state.baseline,"Run preflight first");
  const a=await newUser("a");
  await newUser("b");
  const widget=hard(await admin.from("widgets").insert({
   tenant_id:a.tenantId,name:"flowtest-widget",enabled:true,is_active:true
  }).select("id,public_token").single(),"create test Widget");
  state.widgets.push(widget);await save();
  console.log("PASS isolated setup: A/B Auth, tenants and inert channels, one Widget; secret values never logged");
  break;
 }
 case "before":case "after":await widgetSmoke(command);break;
 case "ab":await liveAB();break;
 case "cleanup":await cleanup();break;
 default:throw Error("Unsupported command");
}
