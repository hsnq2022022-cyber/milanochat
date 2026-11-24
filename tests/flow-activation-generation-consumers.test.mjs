// scripts/activation-generation-consumers.mjs: applies ONLY the activation-generation consumer edits to
// the source that is deployed in production (which is far behind this repository's HEAD). The edit table
// must reproduce this repository's files exactly, and must fail closed on any drift.
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {dirname,join} from "node:path";
import {EDITS,FUNCTIONS,SHARED_KEY,SHARED_REPO_PATH,applyFileEdits,revertFileEdits,applyToBundle,entrypointPath,treePath,materialize}
 from "../scripts/activation-generation-consumers.mjs";

const SCRIPT="scripts/activation-generation-consumers.mjs";
const repoFile=key=>readFileSync(join("supabase",key),"utf8");

test("the edit table reproduces every working-tree consumer exactly (revert -> apply is the identity)",()=>{
 assert.deepEqual(Object.keys(EDITS).sort(),[
  "functions/flow-internal-worker/internalEffects.ts","functions/flow-outbox-worker/index.ts",
  "functions/flow-runtime-worker/index.ts","functions/milan-api/flowDurableIngress.ts"]);
 for(const key of Object.keys(EDITS)){
  const now=repoFile(key);
  const pre=revertFileEdits(key,now);
  assert.notEqual(pre,now,key);
  assert.ok(!pre.includes("activationGeneration")&&!pre.includes("activation_generation"),`${key}: the pre-change text has no trace of the change`);
  assert.equal(applyFileEdits(key,pre),now,`${key}: applying the table to the pre-change text gives the working-tree file`);
 }
});
test("every function lists exactly the files that import the shared predicate (and nothing else)",()=>{
 const importing=Object.keys(EDITS).filter(k=>repoFile(k).includes("_shared/activationGeneration.ts"));
 assert.deepEqual(importing.sort(),Object.keys(EDITS).sort());
 const union=[...new Set(Object.values(FUNCTIONS).flat())].sort();
 assert.deepEqual(union,Object.keys(EDITS).sort());
 assert.deepEqual(Object.keys(FUNCTIONS).sort(),["flow-internal-worker","flow-outbox-worker","flow-runtime-worker","milan-api"]);
 // internalEffects.ts is shared code: the outbox worker bundles it too.
 assert.deepEqual(FUNCTIONS["flow-outbox-worker"].sort(),["functions/flow-internal-worker/internalEffects.ts","functions/flow-outbox-worker/index.ts"]);
});
test("fails closed: a missing, duplicated or already-applied anchor writes nothing",()=>{
 const key="functions/flow-runtime-worker/index.ts";
 const pre=revertFileEdits(key,repoFile(key));
 const first=EDITS[key][1].old;
 assert.throws(()=>applyFileEdits(key,pre.replace(first,"X")),/anchor found 0 times/);
 assert.throws(()=>applyFileEdits(key,pre+"\n"+first),/anchor found 2 times/);
 assert.throws(()=>applyFileEdits(key,repoFile(key)),/anchor found 0 times|already applied/);
 // a bundle that differs where an anchor lives is refused as a whole
 const bad=[{name:"supabase/"+key,content:pre.replace(first,"drifted")}];
 assert.throws(()=>applyToBundle("flow-runtime-worker",bad),/production moved or differs/);
 assert.throws(()=>applyToBundle("flow-runtime-worker",[]),/has no supabase\/functions\/flow-runtime-worker|has no functions\/flow-runtime-worker/);
 assert.throws(()=>applyToBundle("nope",[]),/unknown function/);
});
test("applyToBundle: changes only the listed files, adds the shared predicate with the bundle's own path style",()=>{
 for(const [prefix,slug] of [["supabase/","flow-outbox-worker"],["","flow-internal-worker"],["supabase/","milan-api"],["supabase/","flow-runtime-worker"]]){
  const files=[{name:prefix+"functions/other/untouched.ts",content:"export const keep=1;\n"},
   {name:"src/flow/model.ts",content:"// unrelated production file\n"},
   ...FUNCTIONS[slug].map(k=>({name:prefix+k,content:revertFileEdits(k,repoFile(k))}))];
  const {files:out,summary}=applyToBundle(slug,files);
  assert.equal(out.length,files.length+1);
  assert.equal(out.find(f=>f.name==="src/flow/model.ts").content,"// unrelated production file\n","unrelated production files are byte-identical");
  assert.equal(out.find(f=>f.name.endsWith("untouched.ts")).content,"export const keep=1;\n");
  for(const k of FUNCTIONS[slug])assert.equal(out.find(f=>f.name===prefix+k).content,repoFile(k),`${slug}: ${k}`);
  assert.equal(out.at(-1).name,prefix+SHARED_KEY);
  assert.equal(out.at(-1).content,readFileSync(SHARED_REPO_PATH,"utf8"),"the shared predicate is the repository's file");
  assert.equal(summary.untouched,2);
  assert.throws(()=>applyToBundle(slug,out),/already contains/);
 }
});
test("CLI: check passes on the pre-change tree, refuses a drifted one, apply writes a deployable bundle",()=>{
 const dir=mkdtempSync(join(tmpdir(),"actgen-cli-"));
 try{
  const put=(root,key,text)=>{const p=join(root,"supabase",key);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,text);};
  const good=join(dir,"good"),drift=join(dir,"drift");
  for(const k of FUNCTIONS["milan-api"]){put(good,k,revertFileEdits(k,repoFile(k)));put(drift,k,revertFileEdits(k,repoFile(k)).replace(EDITS[k][2].old,"changed"));}
  let r=spawnSync("node",[SCRIPT,"check","--function","milan-api","--root",good],{encoding:"utf8"});
  assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/ok  functions\/milan-api\/flowDurableIngress\.ts/);
  r=spawnSync("node",[SCRIPT,"check","--function","milan-api","--root",drift],{encoding:"utf8"});
  assert.equal(r.status,1);assert.match(r.stderr,/^REFUSED: .*production moved or differs/);
  const bundle=join(dir,"bundle.json"),out=join(dir,"out.json");
  writeFileSync(bundle,JSON.stringify({files:[...FUNCTIONS["milan-api"].map(k=>({name:"supabase/"+k,content:revertFileEdits(k,repoFile(k))})),
   {name:"supabase/functions/milan-api/index.ts",content:"// entry\n"}]}));
  r=spawnSync("node",[SCRIPT,"apply","--function","milan-api","--bundle",bundle,"--out",out],{encoding:"utf8"});
  assert.equal(r.status,0,r.stderr);
  const o=JSON.parse(readFileSync(out,"utf8"));
  assert.equal(o.name,"milan-api");assert.equal(o.verify_jwt,false);assert.equal(o.files.length,3);
  assert.equal(o.entrypoint_path,"supabase/functions/milan-api/index.ts");
  const tree=join(dir,"tree");
  r=spawnSync("node",[SCRIPT,"materialize","--bundle",out,"--out",tree],{encoding:"utf8"});
  assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/wrote 3 files/);
  assert.equal(readFileSync(join(tree,"supabase/functions/milan-api/index.ts"),"utf8"),"// entry\n");
  assert.equal(spawnSync("node",[SCRIPT,"apply","--function","milan-api","--bundle",out,"--out",join(dir,"x.json")],{encoding:"utf8"}).status,1,"re-applying is refused");
  assert.equal(spawnSync("node",[SCRIPT],{encoding:"utf8"}).status,2);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

const lineDelta=(a,b)=>{
 const cnt=t=>{const m=new Map();for(const l of t.split("\n"))m.set(l,(m.get(l)??0)+1);return m;};
 const A=cnt(a),B=cnt(b);let add=0,rem=0;
 for(const [l,n] of B)add+=Math.max(0,n-(A.get(l)??0));
 for(const [l,n] of A)rem+=Math.max(0,n-(B.get(l)??0));
 return [add,rem];
};
test("entrypoint_path and materialize: both naming styles, exact round trip, no path escape",()=>{
 assert.equal(entrypointPath("milan-api",[{name:"supabase/functions/milan-api/index.ts"}]),"supabase/functions/milan-api/index.ts");
 assert.equal(entrypointPath("flow-internal-worker",[{name:"functions/flow-internal-worker/index.ts"}]),"functions/flow-internal-worker/index.ts");
 assert.throws(()=>entrypointPath("milan-api",[{name:"supabase/functions/milan-api/other.ts"}]),/no functions\/milan-api\/index\.ts/);
 assert.equal(treePath("functions/a/b.ts"),"supabase/functions/a/b.ts");
 assert.equal(treePath("supabase/functions/a/b.ts"),"supabase/functions/a/b.ts");
 assert.equal(treePath("src/flow/model.ts"),"src/flow/model.ts");
 const dir=mkdtempSync(join(tmpdir(),"actgen-mat-"));
 try{
  for(const slug of Object.keys(FUNCTIONS)){
   const style=slug==="flow-internal-worker"?"":"supabase/";
   const base=[...new Set(FUNCTIONS[slug])].map(k=>({name:style+k,content:revertFileEdits(k,repoFile(k))}));
   if(!base.some(f=>f.name===style+"functions/"+slug+"/index.ts"))base.push({name:style+"functions/"+slug+"/index.ts",content:"// entry\n"});
   base.push({name:"src/flow/x.ts",content:"export const x=1;\n"});
   const {files}=applyToBundle(slug,base);
   const out=join(dir,slug);
   const written=materialize(files,out);
   assert.equal(written.length,files.length);
   for(const f of files)assert.equal(readFileSync(join(out,treePath(f.name)),"utf8"),f.content,`${slug}: ${f.name} round-trips`);
   // The shared predicate lands where "../_shared/activationGeneration.ts" resolves for every importer.
   assert.ok(written.includes("supabase/functions/_shared/activationGeneration.ts"),slug);
  }
  assert.throws(()=>materialize([{name:"supabase/../../etc/x.ts",content:"x"}],join(dir,"bad")),/refusing a path with \.\./);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("the runbook's per-function change table matches the real edits",()=>{
 const doc=readFileSync("docs/ACTIVATION_GENERATION_DEPLOYMENT.md","utf8");
 const rows=Object.fromEntries([...doc.matchAll(/^  \| `([a-z-]+)` \| [^|]+ \| (\d+) \| \+(\d+) \/ -(\d+) \|$/gm)].map(m=>[m[1],{unchanged:+m[2],add:+m[3],rem:+m[4]}]));
 assert.deepEqual(Object.keys(rows).sort(),Object.keys(FUNCTIONS).sort());
 for(const [slug,keys] of Object.entries(FUNCTIONS)){
  let add=0,rem=0;
  for(const k of keys){const [a,r]=lineDelta(revertFileEdits(k,repoFile(k)),repoFile(k));add+=a;rem+=r;}
  assert.deepEqual([rows[slug].add,rows[slug].rem],[add,rem],`${slug}: +/- lines in the runbook equal the edits`);
 }
 // Measured production file counts (v31 / v32 / v6 / v137): changed + unchanged = bundle size.
 const size={"flow-runtime-worker":14,"flow-outbox-worker":20,"flow-internal-worker":3,"milan-api":32};
 for(const [slug,n] of Object.entries(size))assert.equal(rows[slug].unchanged+FUNCTIONS[slug].length,n,slug);
 assert.match(doc,/\(15, 21, 4 and 33 files; the originals give 14, 20, 3 and 32/);
});
