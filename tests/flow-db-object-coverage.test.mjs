/**
 * Database object coverage contract (static, no database).
 *
 * Every table and SQL function the Edge Functions use must be DEFINED somewhere in the repository SQL
 * (migrations, the baseline schema files, or the installed-shape fixtures that mirror production-resident
 * objects). The few that are not are listed here with their origin. The list is exact in BOTH directions:
 *  - a NEW undefined reference fails (it would deploy code that calls a function nobody can review);
 *  - a listed object that GETS a definition fails until it is removed from the list (the list stays honest).
 * Proposals (supabase/proposals) and rollbacks are review material, never a definition.
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync,statSync} from "node:fs";
import {join} from "node:path";

const walk=(d,keep)=>readdirSync(d).flatMap(n=>{const p=join(d,n);return statSync(p).isDirectory()?walk(p,keep):keep(p)?[p]:[];});
const fnSrc=walk("supabase/functions",p=>p.endsWith(".ts")&&!/\.test\./.test(p));
const used={rpc:new Map(),table:new Map()};
for(const f of fnSrc){
 const t=readFileSync(f,"utf8");
 for(const m of t.matchAll(/\.rpc\(\s*"([a-z_0-9]+)"/g))used.rpc.set(m[1],[...(used.rpc.get(m[1])??[]),f]);
 for(const m of t.matchAll(/\.from\(\s*"([a-z_0-9]+)"/g))used.table.set(m[1],[...(used.table.get(m[1])??[]),f]);
}
const sqlFiles=[...walk("supabase",p=>p.endsWith(".sql")),...walk("tests/sql",p=>p.endsWith(".sql"))]
 .filter(p=>!p.includes("/proposals/")&&!p.includes("/rollbacks/"));
const definedFn=new Set(),definedTable=new Set();
for(const f of sqlFiles){
 const t=readFileSync(f,"utf8").replace(/--[^\n]*/g,"");
 for(const m of t.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([a-z_0-9]+)\s*\(/gi))definedFn.add(m[1]);
 for(const m of t.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-z_0-9]+)/gi))definedTable.add(m[1]);
}

// Production-resident objects that NO repository SQL defines. Owner action: verify the production definition
// read-only (pg_get_functiondef / \d), then add a reviewed migration or fixture and delete the entry.
const UNDEFINED_RPCS={
 flow_publish_revision:"flow-publication: immutable revision. Only on unmerged branches (20261028190000_flow_publication_server_rpcs.sql @285c9521); that text predates production's approved-activation gate, so it is NOT a safe definition.",
 flow_activate_revision:"flow-publication: signature (uuid,uuid,text,text,bigint,uuid) is pinned by supabase/proposals/automation_flow_production_approval.sql; body unverified.",
 flow_deactivate_revision:"flow-publication: deactivation. Only on unmerged branches; body unverified.",
 flow_publication_rate_allow:"flow-publication: per-tenant rate limiter. Only on unmerged branches (20261028200000_flow_publication_rate_limit.sql @abdda831); body unverified.",
 consume_flow_reply:"billing debit used by the outbox worker and milan-api: supabase/proposals/consume_flow_reply_v2.sql is a proposal; the lifecycle test uses a constant stub.",
 consume_widget_reply:"widget credit debit (milan-api/widgetCredit.ts); production-resident, outside the Flow engine."
};
const UNDEFINED_TABLES={orders:"payments (create-payment, wayl-webhook); production-resident, outside the Flow engine."};

test("Edge Functions reference no SQL function without a repository definition, except the documented production-resident ones",()=>{
 const missing=[...used.rpc.keys()].filter(n=>!definedFn.has(n)).sort();
 assert.deepEqual(missing,Object.keys(UNDEFINED_RPCS).sort(),
  "new undefined RPC (add a reviewed definition) or a documented one gained a definition (remove it from UNDEFINED_RPCS)");
 assert.ok(used.rpc.size>=40,"the scan really sees the Edge Function RPCs: "+used.rpc.size);
});
test("Edge Functions reference no table without a repository definition, except the documented production-resident one",()=>{
 const missing=[...used.table.keys()].filter(n=>!definedTable.has(n)).sort();
 assert.deepEqual(missing,Object.keys(UNDEFINED_TABLES).sort());
 assert.ok(used.table.size>=30,"the scan sees the tables: "+used.table.size);
});
test("every Flow runtime RPC and table used by the workers and the publication function is defined (the old '12 functions / 5 tables missing' report is stale)",()=>{
 const flowRpc=[...used.rpc.keys()].filter(n=>/^flow_/.test(n)&&!(n in UNDEFINED_RPCS));
 assert.ok(flowRpc.length>=25,"flow_* RPCs defined in the repository: "+flowRpc.length);
 for(const n of flowRpc)assert.ok(definedFn.has(n),n);
 const flowTables=[...used.table.keys()].filter(n=>/^automation_/.test(n));
 assert.ok(flowTables.length>=14,"automation_* tables: "+flowTables.length);
 for(const n of flowTables)assert.ok(definedTable.has(n),n);
 // the publication RPCs are the ONLY flow_* gap, and they are called only by flow-publication
 for(const n of Object.keys(UNDEFINED_RPCS).filter(n=>/^flow_/.test(n)))
  assert.deepEqual([...new Set(used.rpc.get(n))],["supabase/functions/flow-publication/index.ts"],n);
});
test("proposals and rollbacks are never counted as definitions",()=>{
 const proposal=readFileSync("supabase/proposals/consume_flow_reply_v2.sql","utf8");
 assert.match(proposal,/CREATE FUNCTION public\.consume_flow_reply/);
 assert.ok(!sqlFiles.some(f=>f.includes("consume_flow_reply_v2")));
});
