// S9 interim anti-squatting control: wa_bindings rows route WhatsApp webhook
// traffic only when an operator verified them (20261029290000).
// Module: supabase/functions/milan-api/waBinding.ts (bindingIsVerified,
// readBindingVerified); call sites in index.ts. SQL semantics (default
// unverified, grandfathering, client roles cannot flip, idempotent re-bind)
// are in tests/security-tenant-isolation-sql.test.mjs.
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {bindingIsVerified, readBindingVerified, bindWhatsappNumber, type BindStore} from "../supabase/functions/milan-api/waBinding.ts";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("bindingIsVerified: only is_verified === true counts", () => {
  assert.equal(bindingIsVerified({tenant_id: A, is_verified: true}), true);
  for (const r of [null, undefined, {}, {tenant_id: A}, {is_verified: false}, {is_verified: "true"}, {is_verified: 1}, {is_verified: null}])
    assert.equal(bindingIsVerified(r), false, JSON.stringify(r));
});

type Row = {phone_id: string; tenant_id: string; is_verified: boolean};
/** wa_bindings with INSERT .. ON CONFLICT DO NOTHING; new rows default unverified (migration default). */
function table(seed: Row[] = []) {
  const rows = new Map(seed.map((r) => [r.phone_id, {...r}]));
  const from = (t: string) => {
    assert.equal(t, "wa_bindings");
    const f: Record<string, unknown> = {};
    let cols = "";
    const q: any = {
      select: (c: string) => { cols = c; return q; },
      eq: (k: string, v: unknown) => { f[k] = v; return q; },
      maybeSingle: async () => {
        const r = [...rows.values()].find((x: any) => Object.entries(f).every(([k, v]) => x[k] === v));
        return {data: r ? Object.fromEntries(cols.split(",").map((c) => [c.trim(), (r as any)[c.trim()]])) : null, error: null};
      },
    };
    return q;
  };
  const store: BindStore = {
    foreignWhatsappAccount: async () => false,
    insertIfAbsent: async (p, t) => { if (!rows.has(p)) rows.set(p, {phone_id: p, tenant_id: t, is_verified: false}); },
    ownerOf: async (p) => rows.get(p)?.tenant_id ?? null,
  };
  return {rows, from, store};
}
/** The whatsapp_webhook account resolution of index.ts (wa_bindings, then channel_accounts). */
async function resolve(db: ReturnType<typeof table>, phoneId: string, channelAccounts: Array<{external_id: string; tenant_id: string}> = []) {
  const {data: bindingRow} = await db.from("wa_bindings").select("tenant_id, phone_id, is_verified").eq("phone_id", phoneId).maybeSingle();
  const binding = bindingIsVerified(bindingRow) ? bindingRow : null;
  if (binding) return {tenant_id: binding.tenant_id, via: "binding"};
  const acc = channelAccounts.find((a) => a.external_id === phoneId);
  return acc ? {tenant_id: acc.tenant_id, via: "channel_accounts"} : null;
}

test("OLD resolution answered for any binding row (proof): a fresh squatted row routed traffic", async () => {
  const db = table([{phone_id: "1000001", tenant_id: B, is_verified: false}]);
  const {data} = await db.from("wa_bindings").select("tenant_id, phone_id").eq("phone_id", "1000001").maybeSingle();
  assert.equal(data?.tenant_id, B);
});

test("webhook: unverified binding ignored (not answered), verified works, OAuth channel_accounts unaffected", async () => {
  const db = table([{phone_id: "1000001", tenant_id: A, is_verified: true}, {phone_id: "2000002", tenant_id: B, is_verified: false}]);
  assert.deepEqual(await resolve(db, "1000001"), {tenant_id: A, via: "binding"});
  assert.equal(await resolve(db, "2000002"), null, "unverified -> no account -> no auto-reply");
  // a squatted unverified row no longer shadows the real owner's OAuth account
  assert.deepEqual(await resolve(db, "2000002", [{external_id: "2000002", tenant_id: A}]), {tenant_id: A, via: "channel_accounts"});
});

test("bind_number: new binding returns verified:false; same-tenant re-bind is idempotent and keeps the flag", async () => {
  const db = table([{phone_id: "1000001", tenant_id: A, is_verified: true}]);
  assert.deepEqual(await bindWhatsappNumber(db.store, B, "3000003"), {status: "bound"});
  assert.equal(await readBindingVerified(db, "3000003", B), false);
  assert.deepEqual(await bindWhatsappNumber(db.store, B, "3000003"), {status: "bound"});
  assert.equal(db.rows.get("3000003")!.is_verified, false);
  assert.deepEqual(await bindWhatsappNumber(db.store, A, "1000001"), {status: "bound"});
  assert.equal(db.rows.get("1000001")!.is_verified, true, "re-bind never resets a verified binding");
  assert.equal(await readBindingVerified(db, "1000001", A), true);
  assert.equal(await readBindingVerified(db, "1000001", B), false, "another tenant never sees it as its own");
  assert.equal(await readBindingVerified({from: () => { throw new Error("x"); }}, "1", A), false, "fail closed");
  assert.equal(await readBindingVerified({from: () => ({select: () => ({eq: () => ({eq: () => ({maybeSingle: async () => ({data: null, error: {code: "42703"}})})})})})}, "1", A), false);
});

const IDX = readFileSync("supabase/functions/milan-api/index.ts", "utf8");
test("index.ts: webhook gates wa_bindings on is_verified; bind_number / wa_status expose verified; TODO(security) documented", () => {
  const w = IDX.slice(IDX.indexOf("تحديد الحساب/المستأجر عبر wa_bindings"), IDX.indexOf("no account for phone_number_id"));
  assert.match(w, /\.select\("tenant_id, phone_id, is_verified"\)/);
  assert.match(w, /const binding = bindingIsVerified\(bindingRow\) \? bindingRow : null;/);
  assert.match(w, /console\.warn\("\[whatsapp_webhook\] binding ignored", \{ code: "wa_binding_unverified" \}\);/);
  assert.match(w, /UPDATE public\.wa_bindings SET is_verified = true,/);
  assert.match(w, /\.from\("channel_accounts"\)/, "channel_accounts fallback kept");
  const b = IDX.slice(IDX.indexOf('case "bind_number": {'), IDX.indexOf('case "qa_extract": {'));
  assert.match(b, /TODO\(security\): permanent fix/);
  assert.match(b, /GET https:\/\/graph\.facebook\.com\/<ver>\/\{phone_number_id\}/);
  assert.match(b, /ok: true,\n\s+verified: await readBindingVerified\(sb, phoneId, tenant\.id\),/);
  // wa_status: true/false for the caller's own bound row, null when unbound.
  const st = IDX.slice(IDX.indexOf('case "wa_status": {'), IDX.indexOf('case "qa_extract": {'));
  assert.match(st, /const phoneId =\s+await boundPhone\(\s+sb,\s+tenant\.id\s+\);/, "bound row resolved from the claim tenant only");
  assert.match(st, /bound:\s+Boolean\(phoneId\),\s+phoneId,/);
  assert.match(st, /verified: phoneId \? await readBindingVerified\(sb, phoneId, tenant\.id\) : null,/);
  assert.doesNotMatch(st, /body\.tenantId/, "never trusts the body tenant id");
  assert.ok(b.indexOf("return json(BIND_CONFLICT_BODY, 409);") < b.indexOf("verified: await readBindingVerified"));
});
