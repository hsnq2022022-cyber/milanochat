/**
 * tenant-admin: manual commercial administration (launch without a payment gateway).
 * An authenticated, ALLOWLISTED operator (env TENANT_ADMIN_USER_IDS, same strict parser as the Flow operator
 * allowlist) can list customers, activate / suspend them, grant or deduct credits and read the ledger.
 * Every write goes through the service-role-only SQL functions admin_adjust_credits / admin_set_tenant_active
 * (atomic, idempotent, audited). Nothing here sends messages or contacts a payment provider.
 * Identity is ONLY the verified auth user id; body fields never grant access. Non-admins get one generic 403.
 */
import {parseOperatorAllowlist,isOperator} from "../flow-publication/operatorAuth.ts";

export const ORIGIN="https://hsnq2022022-cyber.github.io";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY=/^[A-Za-z0-9_.:-]{8,100}$/;
const MAX_BODY=4096,MAX_DELTA=1_000_000;
const headers={
 "content-type":"application/json; charset=utf-8","cache-control":"no-store",
 "access-control-allow-origin":ORIGIN,"access-control-allow-headers":"authorization,apikey,content-type",
 "access-control-allow-methods":"POST,OPTIONS","vary":"Origin"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers});

export type Db={
 auth:{getUser:(jwt:string)=>Promise<{data:{user:{id:string}|null},error:unknown}>};
 from:(t:string)=>any;
 rpc:(fn:string,args:Record<string,unknown>)=>Promise<{data:any,error:any}>;
};
export type Deps={env:(k:string)=>string|undefined;db:(url:string,key:string)=>Db};

const text=(v:unknown,min:number,max:number)=>typeof v==="string"&&v.trim().length>=min&&v.trim().length<=max;

export async function handleTenantAdmin(req:Request,deps:Deps):Promise<Response>{
 if(req.headers.get("origin")!==ORIGIN)return json({error:"Origin not permitted"},403);
 if(req.method==="OPTIONS")return new Response(null,{status:204,headers});
 if(req.method!=="POST")return json({error:"Method not allowed"},405);
 const bearer=req.headers.get("authorization")??"";
 if(!bearer.startsWith("Bearer ")||bearer.length>8192)return json({error:"Authentication required"},401);
 const url=deps.env("SUPABASE_URL")??"",key=deps.env("SUPABASE_SERVICE_ROLE_KEY")??"";
 if(!url||!key)return json({error:"Configuration unavailable"},503);
 let body:Record<string,unknown>;
 try{
  const raw=await req.text();
  if(raw.length>MAX_BODY)return json({error:"Payload too large"},413);
  const p=JSON.parse(raw);
  if(!p||typeof p!=="object"||Array.isArray(p))return json({error:"Invalid JSON"},400);
  body=p as Record<string,unknown>;
 }catch{return json({error:"Invalid JSON"},400);}
 const db=deps.db(url,key);
 const {data:auth,error:authError}=await db.auth.getUser(bearer.slice(7));
 if(authError||!auth?.user)return json({error:"Authentication required"},401);
 const operatorId=auth.user.id;
 const list=parseOperatorAllowlist(deps.env("TENANT_ADMIN_USER_IDS"));
 const admin=isOperator(operatorId,list);
 const action=body.action;
 // Any signed-in user may ask whether they are an admin (the UI hides the panel otherwise); nothing else.
 if(action==="whoami")return json({ok:true,admin});
 if(!admin)return json({error:"Admin access required"},403);

 if(action==="list_tenants"){
  const limit=Number.isSafeInteger(body.limit)&&(body.limit as number)>=1&&(body.limit as number)<=100?body.limit as number:50;
  let q=db.from("tenants").select("id,business_name,is_active,credits_remaining,created_at");
  if(typeof body.search==="string"&&body.search.trim()){
   const s=body.search.trim().slice(0,80).replace(/[\\%_,()]/g," ");
   q=q.ilike("business_name",`%${s}%`);
  }
  const {data,error}=await q.order("created_at",{ascending:false}).limit(limit);
  if(error)return json({error:"Tenant list unavailable"},503);
  return json({ok:true,tenants:data??[]});
 }
 if(typeof body.tenantId!=="string"||!UUID.test(body.tenantId))return json({error:"Invalid tenant"},400);
 const tenantId=body.tenantId;

 if(action==="ledger"){
  const {data,error}=await db.from("tenant_admin_actions")
   .select("id,action,amount,balance_after,reason,operator_id,created_at")
   .eq("tenant_id",tenantId).order("created_at",{ascending:false}).limit(100);
  if(error)return json({error:"Ledger unavailable"},503);
  return json({ok:true,actions:data??[]});
 }
 if(action==="adjust_credits"){
  const d=body.delta;
  if(typeof d!=="number"||!Number.isSafeInteger(d)||d===0||Math.abs(d)>MAX_DELTA)return json({error:"Invalid amount"},400);
  if(!text(body.reason,3,500))return json({error:"A reason of 3-500 characters is required"},400);
  if(typeof body.idempotencyKey!=="string"||!KEY.test(body.idempotencyKey))return json({error:"Invalid idempotency key"},400);
  return rpcResult(await db.rpc("admin_adjust_credits",{p_tenant:tenantId,p_operator:operatorId,p_delta:d,
   p_reason:(body.reason as string).trim(),p_key:body.idempotencyKey}));
 }
 if(action==="set_active"){
  if(typeof body.active!=="boolean")return json({error:"Invalid state"},400);
  if(!text(body.reason,3,500))return json({error:"A reason of 3-500 characters is required"},400);
  if(typeof body.idempotencyKey!=="string"||!KEY.test(body.idempotencyKey))return json({error:"Invalid idempotency key"},400);
  return rpcResult(await db.rpc("admin_set_tenant_active",{p_tenant:tenantId,p_operator:operatorId,p_active:body.active,
   p_reason:(body.reason as string).trim(),p_key:body.idempotencyKey}));
 }
 return json({error:"Unknown action"},400);
}

function rpcResult(r:{data:any,error:any}):Response{
 if(r.error||!r.data||typeof r.data!=="object")return json({error:"Operation unavailable"},503);
 if(r.data.ok===true)return json(r.data);
 const code=String(r.data.error??"");
 const status=code==="tenant_not_found"?404:code==="insufficient_balance"||code==="idempotency_conflict"?409:400;
 return json({ok:false,error:code,...(typeof r.data.balance==="number"?{balance:r.data.balance}:{})},status);
}
