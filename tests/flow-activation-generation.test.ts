// Activation generations (20261123100000), TypeScript side: the shared predicate and
// the contract that every consumer applies it. The SQL behaviour is proven in
// tests/flow-activation-generation.test.mjs; the real handlers on PostgreSQL in
// tests/flow-lifecycle-integration.test.ts (step "activation generations").
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {parseGeneration,generationMatches,revisionLive}
 from "../supabase/functions/_shared/activationGeneration.ts";

test("parseGeneration accepts only non-negative safe integers (number or digit string)",()=>{
 assert.equal(parseGeneration(3),3);
 assert.equal(parseGeneration("12"),12);
 assert.equal(parseGeneration(0),0);
 for(const bad of [-1,1.5,NaN,Infinity,"-1","1.5","abc","","1e3","9999999999999999",null,undefined,{},[],true])
  assert.equal(parseGeneration(bad),null,String(bad));
});

test("a stamped run matches ONLY the same generation; legacy NULL keeps the old behaviour; 0 and garbage never match",()=>{
 assert.equal(generationMatches(2,2),true);
 assert.equal(generationMatches("2",2),true);
 assert.equal(generationMatches(2,"2"),true);
 assert.equal(generationMatches(2,3),false,"older generation");
 assert.equal(generationMatches(3,2),false,"never a newer one either");
 // legacy: NULL / missing column
 assert.equal(generationMatches(null,5),true);
 assert.equal(generationMatches(undefined,5),true);
 assert.equal(generationMatches(null,undefined),true);
 // dead stamp from the migration
 assert.equal(generationMatches(0,0),false);
 assert.equal(generationMatches(0,1),false);
 // fail closed
 assert.equal(generationMatches(2,undefined),false,"activation without a readable generation");
 assert.equal(generationMatches(2,null),false);
 assert.equal(generationMatches("x",2),false,"malformed stamp");
 assert.equal(generationMatches(-1,-1),false);
});

test("revisionLive requires active + same revision + same generation",()=>{
 const run={publication_revision:1,activation_generation:4};
 assert.equal(revisionLive({revision:1,is_active:true,activation_generation:4},run),true);
 assert.equal(revisionLive({revision:"1",is_active:true,activation_generation:"4"},{publication_revision:"1",activation_generation:"4"}),true);
 assert.equal(revisionLive({revision:1,is_active:true,activation_generation:5},run),false,"same revision, new generation (off/on)");
 assert.equal(revisionLive({revision:2,is_active:true,activation_generation:4},run),false,"other revision");
 assert.equal(revisionLive({revision:1,is_active:false,activation_generation:4},run),false,"inactive");
 assert.equal(revisionLive({revision:1,is_active:"true",activation_generation:4},run),false,"is_active must be exactly true");
 assert.equal(revisionLive(null,run),false);
 assert.equal(revisionLive(undefined,run),false);
 assert.equal(revisionLive({revision:1,is_active:true,activation_generation:4},null),false);
 // legacy run (no stamp) on an active matching revision: previous behaviour
 assert.equal(revisionLive({revision:1,is_active:true,activation_generation:9},{publication_revision:1}),true);
 assert.equal(revisionLive({revision:1,is_active:true},{publication_revision:1,activation_generation:null}),true);
 // A -> B -> A: the first A generation (1) is dead when the third (3) is current
 assert.equal(revisionLive({revision:1,is_active:true,activation_generation:3},{publication_revision:1,activation_generation:1}),false);
});

const read=(f:string)=>readFileSync(f,"utf8");
const F={
 runtime:"supabase/functions/flow-runtime-worker/index.ts",
 outbox:"supabase/functions/flow-outbox-worker/index.ts",
 internal:"supabase/functions/flow-internal-worker/internalEffects.ts",
 ingress:"supabase/functions/milan-api/flowDurableIngress.ts"
};
test("every consumer that decides eligibility imports the shared predicate and reads the generation",()=>{
 for(const [name,f] of Object.entries(F)){
  const s=read(f);
  assert.match(s,/from "\.\.\/_shared\/activationGeneration\.ts"/,name);
  assert.ok(s.includes("activation_generation"),name+" selects activation_generation");
 }
 // The activation reads of the three workers select the column.
 assert.match(read(F.runtime),/\.select\("revision,is_active,activation_generation"\)/);
 assert.match(read(F.outbox),/\.select\("revision,is_active,activation_generation"\)/);
 assert.match(read(F.internal),/\.select\("revision,is_active,activation_generation"\)/);
 assert.match(read(F.ingress),/\.select\("flow_key,revision,is_active,activation_generation"\)/);
 // The run reads carry the stamp (select("*") already does for the two workers).
 assert.match(read(F.internal),/publication_revision,activation_generation"\)/);
 assert.match(read(F.ingress),/step_count,variables,wake_at,activation_generation"\)/);
});
test("no consumer accepts a bare is_active any more",()=>{
 assert.doesNotMatch(read(F.runtime),/revisionIsActive:activation\.data\?\.is_active/);
 assert.doesNotMatch(read(F.outbox),/revisionActive:activationResult\.data\?\.is_active/);
 assert.doesNotMatch(read(F.internal),/activation\.data\?\.is_active!==true/);
 assert.match(read(F.runtime),/revisionLive\(activation\.data,run\)/);
 assert.equal((read(F.outbox).match(/revisionLive\(activationResult\.data,run\)/g)??[]).length,2);
 assert.match(read(F.internal),/revisionLive\(activation\.data,r as/);
 assert.match(read(F.ingress),/generationMatches\(run\.activation_generation,a\.activation_generation\)/);
});
test("the pure eligibility helpers keep their contract (they take an already-combined boolean)",()=>{
 for(const f of ["supabase/functions/flow-runtime-worker/eligibility.ts","supabase/functions/flow-outbox-worker/skipPolicy.ts",
  "supabase/functions/flow-outbox-worker/productionGate.ts"])
  assert.doesNotMatch(read(f),/activation_generation|activationGeneration/,f);
});
