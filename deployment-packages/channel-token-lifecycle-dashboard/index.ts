/**
 * channel-token-lifecycle: service-authenticated daily tick (verify_jwt=false, same Bearer contract as the Flow
 * workers: the service-role key or the independent cron key). Instagram tokens are refreshed inside their
 * window; Facebook tokens are verified; confirmed failures become status 'needs_reauth'. See lifecycle.ts.
 * NOT deployed and not scheduled until separately approved (see supabase/proposals/channel_token_lifecycle_cron.review.sql).
 */
import {createClient} from "npm:@supabase/supabase-js@2";
import {acceptsFlowWorkerBearer} from "./flowWorkerAuth.ts";
import {decryptAccountToken,encryptMessageBody} from "./deliveryCore.ts";
import {runLifecycle} from "./lifecycle.ts";

const env=(k:string)=>Deno.env.get(k)??"";
const reply=(status:number,body:unknown)=>new Response(JSON.stringify(body),
 {status,headers:{"content-type":"application/json","cache-control":"no-store"}});

export async function handle(req:Request):Promise<Response>{
 if(req.method!=="POST")return reply(405,{error:"Method not allowed"});
 if(!acceptsFlowWorkerBearer(req.headers.get("authorization"),env("SUPABASE_SERVICE_ROLE_KEY"),env("flow_worker_service_role_key")))
  return reply(401,{error:"Unauthorized"});
 const url=env("SUPABASE_URL"),key=env("SUPABASE_SERVICE_ROLE_KEY"),fieldKey=env("FIELD_ENCRYPTION_KEY");
 if(!url||!key||!fieldKey)return reply(503,{error:"Configuration unavailable"});
 try{const b=await req.json();if(!b||typeof b!=="object"||(b as {mode?:unknown}).mode!=="tick")return reply(400,{error:"Unsupported mode"});}
 catch{return reply(400,{error:"Invalid JSON"});}
 const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
 const out=await runLifecycle({db,fetch,nowMs:()=>Date.now(),fieldKey,
  appId:env("META_APP_ID"),appSecret:env("META_APP_SECRET"),
  decrypt:decryptAccountToken,encrypt:encryptMessageBody});
 return "checked" in out?reply(200,out):reply(503,out); // counts only: no ids, no tokens
}
Deno.serve(handle); // unconditional: the module has no other top-level side effects and nothing in the repo imports it
