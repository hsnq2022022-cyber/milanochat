#!/usr/bin/env node
// Activation generations (migration 20261123100000): applies ONLY the four TypeScript consumer
// edits to the source that is DEPLOYED in production, not to this repository's HEAD.
//
// Why: the deployed functions are built from older repository states (measured 2026-11-23 on
// flow-runtime-worker v31, flow-outbox-worker v32, milan-api v137: HEAD differs by ~12, ~210 and
// ~1,900 lines of unrelated, never-deployed work). Deploying HEAD would ship all of it with this
// change. This script makes the generation change the ONLY difference.
//
// Every edit is an exact-text replacement that must match EXACTLY ONCE; anything else (a changed or
// duplicated anchor, i.e. production moved) aborts and nothing is written. The anchors are chosen to
// be byte-identical in production and in this repository.
//
//   node scripts/activation-generation-consumers.mjs apply --function <slug> --bundle <in.json> --out <out.json>
//       <in.json>  the production bundle ({files:[{name,content}]}) as returned by get_edge_function
//       <out.json> {name, verify_jwt:false, files:[...]} for deploy_edge_function, plus a review summary
//   node scripts/activation-generation-consumers.mjs check --function <slug> --root <dir>
//       verifies every anchor on a source tree on disk (exit 0 = would apply)
//   node scripts/activation-generation-consumers.mjs materialize --bundle <file.json> --out <dir>
//       writes ANY bundle (the generated <out.json>, or a saved production bundle for a rollback) as a project
//       tree <dir>/supabase/functions/<slug>/... , <dir>/src/... so that `supabase functions deploy <slug>
//       --no-verify-jwt --project-ref <ref>` run from <dir> deploys exactly those files
//
// Tests: tests/flow-activation-generation-consumers.test.mjs (the table reproduces this repository's
// working-tree files exactly, and fails closed).
import {readFileSync,writeFileSync,existsSync,mkdirSync} from "node:fs";
import {createHash} from "node:crypto";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";

const REPO=resolve(dirname(fileURLToPath(import.meta.url)),"..");
export const SHARED_KEY="functions/_shared/activationGeneration.ts";
export const SHARED_REPO_PATH="supabase/functions/_shared/activationGeneration.ts";

const IMPORT_REVISION_LIVE='import {revisionLive} from "../_shared/activationGeneration.ts";\n';
const IMPORT_MATCHES='import {generationMatches} from "../_shared/activationGeneration.ts";\n';

/** key = path below supabase/ ; each edit: exact `old` (once) -> `new`. */
export const EDITS={
 "functions/flow-runtime-worker/index.ts":[
  {old:'import {aiStepEnabled} from "../flow-outbox-worker/aiStep.ts";\n',
   new:'import {aiStepEnabled} from "../flow-outbox-worker/aiStep.ts";\n'+IMPORT_REVISION_LIVE},
  {old:'     .select("revision,is_active").eq("tenant_id",tenantId)',
   new:'     .select("revision,is_active,activation_generation").eq("tenant_id",tenantId)'},
  {old:'    revisionIsActive:activation.data?.is_active\n   };',
   new:'    // Active AND on the generation this run was created under (20261123100000).\n'+
       '    revisionIsActive:activation.data?revisionLive(activation.data,run):undefined\n   };'}
 ],
 "functions/flow-outbox-worker/index.ts":[
  {old:'import {plainInputQuestion} from "./questionMode.ts";\n',
   new:'import {plainInputQuestion} from "./questionMode.ts";\n'+IMPORT_REVISION_LIVE},
  {old:'    sb.from("automation_flow_activations").select("revision,is_active")\n',
   new:'    sb.from("automation_flow_activations").select("revision,is_active,activation_generation")\n'},
  {old:'    revisionActive:activationResult.data?.is_active\n   },Date.now());',
   new:'    // Active, on the run\'s revision AND on the generation the run was created\n'+
       '    // under (20261123100000): effects of an older generation are never sent.\n'+
       '    revisionActive:activationResult.data?revisionLive(activationResult.data,run):undefined\n   },Date.now());'},
  {old:'       revisionActive:activationResult.data?.is_active,\n       humanTakeover:takeover,',
   new:'       revisionActive:activationResult.data?revisionLive(activationResult.data,run):undefined,\n       humanTakeover:takeover,'}
 ],
 "functions/flow-internal-worker/internalEffects.ts":[
  {old:'import {compareOutbox,effectSeq,type OrderRow} from "../flow-outbox-worker/effectOrder.ts";\n',
   new:'import {compareOutbox,effectSeq,type OrderRow} from "../flow-outbox-worker/effectOrder.ts";\n'+IMPORT_REVISION_LIVE},
  {old:'     .select("id,tenant_id,channel_account_id,platform,conversation_id,flow_key,publication_revision")',
   new:'     .select("id,tenant_id,channel_account_id,platform,conversation_id,flow_key,publication_revision,activation_generation")'},
  {old:'    sb.from("automation_flow_activations").select("revision,is_active")\n',
   new:'    sb.from("automation_flow_activations").select("revision,is_active,activation_generation")\n'},
  {old:'   if(activation.data?.is_active!==true){\n',
   new:'   // Active, on the run\'s revision AND on the generation the run was created\n'+
       '   // under (20261123100000): an older generation\'s effect is ended, never applied.\n'+
       '   if(!revisionLive(activation.data,r as {publication_revision?:unknown;activation_generation?:unknown})){\n'}
 ],
 "functions/milan-api/flowDurableIngress.ts":[
  {old:'import {aiStepEnabled} from "../flow-outbox-worker/aiStep.ts";\n',
   new:'import {aiStepEnabled} from "../flow-outbox-worker/aiStep.ts";\n'+IMPORT_MATCHES},
  {old:'run_status,step_count,variables,wake_at")\n   .eq("tenant_id",event.tenantId).eq("channel_account_id",event.accountId)',
   new:'run_status,step_count,variables,wake_at,activation_generation")\n   .eq("tenant_id",event.tenantId).eq("channel_account_id",event.accountId)'},
  {old:'    .select("flow_key,revision,is_active").eq("tenant_id",event.tenantId)\n',
   new:'    .select("flow_key,revision,is_active,activation_generation").eq("tenant_id",event.tenantId)\n'},
  {old:'   if(!Array.isArray(live.data)||!live.data.some(a=>record(a)&&a.is_active===true&&\n'+
       '      a.flow_key===run.flow_key&&Number(a.revision)===Number(run.publication_revision)))\n',
   new:'   // Active, on the run\'s revision AND on the generation the run was created\n'+
       '   // under (20261123100000): a stale awaiting run is ended and V2 answers.\n'+
       '   if(!Array.isArray(live.data)||!live.data.some(a=>record(a)&&a.is_active===true&&\n'+
       '      a.flow_key===run.flow_key&&Number(a.revision)===Number(run.publication_revision)&&\n'+
       '      generationMatches(run.activation_generation,a.activation_generation)))\n'}
 ]
};
/** function slug -> the source files (keys of EDITS) it is built from that this change touches. */
export const FUNCTIONS={
 "flow-runtime-worker":["functions/flow-runtime-worker/index.ts"],
 "flow-outbox-worker":["functions/flow-outbox-worker/index.ts","functions/flow-internal-worker/internalEffects.ts"],
 "flow-internal-worker":["functions/flow-internal-worker/internalEffects.ts"],
 "milan-api":["functions/milan-api/flowDurableIngress.ts"]
};

const count=(text,needle)=>text.split(needle).length-1;
const sha=t=>createHash("sha256").update(t).digest("hex");

/** Apply one file's edits. Throws (nothing returned) unless every anchor matches exactly once. */
export function applyFileEdits(key,text){
 let out=text;
 EDITS[key].forEach((e,i)=>{
  const n=count(out,e.old);
  if(n!==1)throw new Error(`${key}: edit ${i+1} anchor found ${n} times (expected exactly 1); production moved or differs - stop and review`);
  if(out.includes(e.new)&&!e.new.includes(e.old))throw new Error(`${key}: edit ${i+1} already applied`);
  out=out.replace(e.old,()=>e.new);
 });
 return out;
}
/** The inverse (used by the tests to reconstruct the pre-change file from the working tree). */
export function revertFileEdits(key,text){
 let out=text;
 for(const e of [...EDITS[key]].reverse()){
  const n=count(out,e.new);
  if(n!==1)throw new Error(`${key}: revert anchor found ${n} times`);
  out=out.replace(e.new,()=>e.old);
 }
 return out;
}
const sharedSource=()=>readFileSync(join(REPO,SHARED_REPO_PATH),"utf8");

/**
 * files: [{name,content}] of a deployed function. Returns {files, summary}; throws on any drift.
 * Names are matched with or without a leading "supabase/" and the same prefix is used for the new file.
 */
export function applyToBundle(slug,files){
 if(!FUNCTIONS[slug])throw new Error(`unknown function ${slug}`);
 const prefix=files.some(f=>f.name.startsWith("supabase/functions/"))?"supabase/":"";
 const find=key=>files.findIndex(f=>f.name===prefix+key);
 if(files.some(f=>f.name===prefix+SHARED_KEY))throw new Error("the bundle already contains activationGeneration.ts");
 const out=files.map(f=>({...f}));
 const changed=[];
 for(const key of FUNCTIONS[slug]){
  const i=find(key);
  if(i<0)throw new Error(`${slug}: production bundle has no ${prefix+key}`);
  const before=out[i].content;
  out[i].content=applyFileEdits(key,before);
  changed.push({file:prefix+key,sha256_before:sha(before),sha256_after:sha(out[i].content),edits:EDITS[key].length});
 }
 const shared=sharedSource();
 out.push({name:prefix+SHARED_KEY,content:shared});
 changed.push({file:prefix+SHARED_KEY,sha256_before:null,sha256_after:sha(shared),edits:"new file"});
 return {files:out,summary:{function:slug,changed,untouched:files.length-FUNCTIONS[slug].length}};
}

/** The entrypoint, in the bundle's own naming style ("supabase/functions/<slug>/index.ts" or "functions/<slug>/index.ts"). */
export function entrypointPath(slug,files){
 const hit=files.map(f=>f.name).find(n=>n==="supabase/functions/"+slug+"/index.ts"||n==="functions/"+slug+"/index.ts");
 if(!hit)throw new Error(`${slug}: the bundle has no functions/${slug}/index.ts entrypoint`);
 return hit;
}
/** Project-tree path of a bundle file: names without a leading supabase/ or src/ live below supabase/. */
export function treePath(name){return name.startsWith("supabase/")||name.startsWith("src/")?name:"supabase/"+name;}
export function materialize(files,outDir){
 const written=[];
 for(const f of files){
  const rel=treePath(f.name);
  if(rel.split("/").includes(".."))throw new Error("refusing a path with ..: "+f.name);
  const p=join(outDir,rel);
  mkdirSync(dirname(p),{recursive:true});writeFileSync(p,f.content);written.push(rel);
 }
 return written;
}
function arg(argv,name){const i=argv.indexOf(name);return i>=0?argv[i+1]:undefined;}
function main(argv){
 const [cmd]=argv;const slug=arg(argv,"--function");
 try{
  if(cmd==="apply"){
   const bundle=JSON.parse(readFileSync(arg(argv,"--bundle"),"utf8"));
   const {files,summary}=applyToBundle(slug,bundle.files);
   writeFileSync(arg(argv,"--out"),JSON.stringify({name:slug,verify_jwt:false,entrypoint_path:entrypointPath(slug,files),files,summary},null,1));
   console.log(JSON.stringify(summary,null,1));
   return 0;
  }
  if(cmd==="check"){
   const root=arg(argv,"--root");
   if(!FUNCTIONS[slug])throw new Error(`unknown function ${slug}`);
   for(const key of FUNCTIONS[slug]){
    const p=existsSync(join(root,"supabase",key))?join(root,"supabase",key):join(root,key);
    applyFileEdits(key,readFileSync(p,"utf8"));
    console.log("ok  "+key);
   }
   return 0;
  }
  if(cmd==="materialize"){
   const bundle=JSON.parse(readFileSync(arg(argv,"--bundle"),"utf8"));
   const written=materialize(bundle.files,arg(argv,"--out"));
   console.log(`wrote ${written.length} files under ${arg(argv,"--out")}`);
   return 0;
  }
  console.error("usage: apply --function <slug> --bundle <in.json> --out <out.json> | check --function <slug> --root <dir> | materialize --bundle <file.json> --out <dir>");
  return 2;
 }catch(e){console.error("REFUSED: "+(e instanceof Error?e.message:String(e)));return 1;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exit(main(process.argv.slice(2)));
