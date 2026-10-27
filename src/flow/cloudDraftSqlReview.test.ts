import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source=readFileSync(new URL("../../supabase/proposals/automation_flow_drafts.review.sql",import.meta.url),"utf8");

test("stage 7 SQL proposal is not a deployment and restricts Data API privileges",()=>{
 assert.match(source,/REVIEW PROPOSAL ONLY/);
 assert.match(source,/enable row level security/i);
 assert.match(source,/grant select, insert on table public\.automation_flow_drafts to authenticated/i);
 assert.match(source,/grant update \(name, document, draft_revision\)/i);
 assert.doesNotMatch(source,/^\s*grant\s+[^;]*\bdelete\b/im);
 assert.doesNotMatch(source,/^\s*create\s+.*security definer/im);
});

test("canonical draft SQL review has bounded document, stable id and server revision checks",()=>{
 assert.match(source,/id uuid primary key default gen_random_uuid\(\)/);
 assert.match(source,/unique \(tenant_id, flow_key\)/);
 assert.match(source,/octet_length\(document::text\) <= 4194304/);
 assert.match(source,/jsonb_array_length\(document->'nodes'\) <= 100/);
 assert.match(source,/jsonb_array_length\(document->'edges'\) <= 250/);
 assert.match(source,/new\.draft_revision <> old\.draft_revision \+ 1/);
 assert.match(source,/new\.updated_at = now\(\)/);
 assert.match(source,/for select to authenticated/);
 assert.match(source,/for insert to authenticated/);
 assert.match(source,/for update to authenticated/);
});

test("RLS review explicitly scopes all grants to owning tenant",()=>{
 const ownerChecks=source.match(/t\.id=tenant_id and t\.user_id=\(select auth\.uid\(\)\)/g)||[];
 assert.equal(ownerChecks.length,4);
});
// Static proposal checks DO NOT substitute for actual Postgres RLS tests with two users.
