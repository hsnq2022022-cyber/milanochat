import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {metaConnectErrorMessage,metaLegacyErrorMessage} from "../src/lib/metaConnectErrors.ts";

const ARABIC=/[؀-ۿ]/;
const sources=["supabase/functions/meta-auth/index.ts","supabase/functions/meta-auth/facebook.ts"].map(f=>readFileSync(f,"utf8")).join("\n");
// Every static code meta-auth can put into channel_error must have its own Arabic message (drift guard).
const emitted=new Set<string>();
for(const m of sources.matchAll(/fail\(\s*"([a-z_]+)/g))emitted.add(m[1]);
for(const m of sources.matchAll(/code:\s*"([a-z_]+)"/g))emitted.add(m[1]);
for(const m of sources.matchAll(/ok:\s*false,\s*code:\s*"([a-z_]+)"/g))emitted.add(m[1]);

test("the drift guard found the codes meta-auth really emits",()=>{
 for(const c of ["account_already_linked","config_missing","db_save_failed","graph_error","no_pages","no_eligible_instagram","missing_params","oauth_token_exchange","unknown"])
  assert.ok(emitted.has(c),`expected meta-auth to emit ${c}`);
});
test("every code meta-auth emits has a specific Arabic message and never shows the raw code",()=>{
 for(const c of emitted){
  const msg=metaConnectErrorMessage(c);
  assert.match(msg,ARABIC,c);
  assert.ok(!msg.includes(c),`${c} leaked into the customer message`);
  assert.ok(!msg.startsWith("تعذر إتمام ربط Meta — أعد المحاولة، وإن تكرر الأمر"),`${c} fell to the generic message`);
 }
});
test("dynamic codes: oauth_state reasons, user_cancelled, and the old Arabic-suffixed code",()=>{
 for(const c of ["user_cancelled","oauth_denied","oauth_state","oauth_state:state_signature","oauth_state:state_expired","oauth_state:state_reused"])
  assert.match(metaConnectErrorMessage(c),ARABIC);
 assert.equal(metaConnectErrorMessage("no_eligible_instagram — الحساب يجب أن يكون Business أو Creator"),metaConnectErrorMessage("no_eligible_instagram"));
});
test("unknown codes get a generic Arabic message with a sanitised support code only",()=>{
 const m=metaConnectErrorMessage("server_error");
 assert.match(m,ARABIC);assert.match(m,/\(رمز: server_error\)/);
 const hostile=metaConnectErrorMessage("<img src=x onerror=alert(1)>");
 assert.ok(!hostile.includes("<")&&!hostile.includes("onerror=")&&!hostile.includes("alert("));
 assert.match(metaConnectErrorMessage(""),ARABIC);
 assert.ok(metaConnectErrorMessage("a".repeat(500)).length<200);
});
test("legacy ?error= codes keep their messages and unknown ones are Arabic",()=>{
 assert.equal(metaLegacyErrorMessage("oauth_missing"),"لم يكتمل تفويض Meta.");
 assert.match(metaLegacyErrorMessage("zzz"),ARABIC);
});
