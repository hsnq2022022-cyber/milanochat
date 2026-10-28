import {readFileSync} from "node:fs";
import {test} from "node:test";
import assert from "node:assert/strict";

test("flow responders use the versioned debit without replacing legacy callers",()=>{
 const main=readFileSync("supabase/functions/milan-api/index.ts","utf8");
 const outbox=readFileSync("supabase/functions/flow-outbox-worker/index.ts","utf8");
 const sql=readFileSync("supabase/proposals/consume_flow_reply_v2.sql","utf8");
 assert.match(main,/\.rpc\("consume_flow_reply",/);
 assert.match(outbox,/\.rpc\("consume_flow_reply",/);
 assert.match(sql,/CREATE FUNCTION public\.consume_flow_reply\(/);
 assert.doesNotMatch(sql,/CREATE OR REPLACE FUNCTION public\.consume_reply\(/);
 assert.match(sql,/REVOKE ALL ON FUNCTION public\.consume_flow_reply/);
});
