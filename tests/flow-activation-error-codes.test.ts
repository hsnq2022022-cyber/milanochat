/**
 * Frontend interpretation of flow-publication errors: the server's machine `code`
 * decides the Arabic text BEFORE any HTTP-status rule (409 used to always mean
 * "multiple active revisions"). Diagnostics keep the code, never the server sentence.
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {ServiceError,serviceErrorDetail,activationErrorMessage} from "../src/flow/activationErrors.ts";

const MULTI="يوجد أكثر من إصدار نشط على الحساب";
const SERVER_SENTENCE="هذا الحساب غير مفعّل بعد للمسارات المتقدمة لدى فريق الإدارة";
const msg=(e:ServiceError,en=false)=>activationErrorMessage(e,"التفعيل",en);

test("multiple-active-revisions keeps its message for its original server error (no machine code)",()=>{
 const m=msg(new ServiceError("Conflicting active revisions",409));
 assert.ok(m.includes(MULTI));
 assert.ok(msg(new ServiceError("Conflicting active revisions",409),true).includes("more than one active revision"));
});

test("registry codes get their own Arabic and English explanation (409 and 503)",()=>{
 const cases:Array<[string,number,string,string]>=[
  ["FLOW_DURABLE_REGISTRY_MISSING",409,"حسابك غير مفعّل للمسارات المتقدمة بعد","not enabled for your account"],
  ["FLOW_DURABLE_REGISTRY_OTHER_ACCOUNT",409,"مفعّلة لحساب آخر لديك","another of your accounts"],
  ["FLOW_DURABLE_REGISTRY_UNAVAILABLE",503,"تعذر التحقق من تفعيل الحساب الآن","could not verify"]];
 for(const [code,status,ar,en] of cases){
  const e=new ServiceError(SERVER_SENTENCE,status,code);
  const m=msg(e);assert.ok(m.includes(ar),code);assert.ok(!m.includes(MULTI),"never the multi-revision text: "+code);
  assert.ok(msg(e,true).includes(en),code);
  // Diagnostics: the machine code and HTTP status, not the long server sentence.
  assert.equal(serviceErrorDetail(e),code+" · HTTP "+status);
  assert.ok(m.includes("رمز: "+code),"support can still see the code");
  assert.ok(!m.includes(SERVER_SENTENCE),"no duplicated server sentence");
 }
});

test("unknown 409: safe generic fallback, never the multiple-revisions claim",()=>{
 for(const e of [new ServiceError("something else",409),new ServiceError("x",409,"SOME_FUTURE_CODE")]){
  const m=msg(e);
  assert.ok(m.includes("تعارض في حالة الحساب"));assert.ok(!m.includes(MULTI));
 }
});

test("machine code is accepted only as a plain UPPER_SNAKE token; others are ignored",()=>{
 for(const bad of ["lower_case","HAS SPACE","<script>","","A".repeat(70),123,null,undefined,{}])
  assert.equal(new ServiceError("x",409,bad).code,undefined,String(bad));
 assert.equal(new ServiceError("x",409,"FLOW_DURABLE_REGISTRY_MISSING").code,"FLOW_DURABLE_REGISTRY_MISSING");
 // A registry code never overrides an unrelated status family
 assert.ok(msg(new ServiceError("Account is paused",403)).includes("الحساب أو الرد التلقائي متوقف"));
 assert.ok(msg(new ServiceError("Publication activation is disabled",423)).includes("غير مفعّل على حسابك"));
});

test("existing mappings unchanged",()=>{
 assert.ok(msg(new ServiceError("x",503)).includes("غير متاحة مؤقتًا"));
 assert.ok(msg(new ServiceError("This flow uses unsupported runtime features",422)).includes("الميزة غير مدعومة"));
 assert.equal(serviceErrorDetail(new ServiceError("Conflicting active revisions",409)),"Conflicting active revisions · HTTP 409");
});

test("invokeService forwards body.code (source pin: both the HTTP-error and the ok:false paths)",()=>{
 const src=readFileSync("src/flow/useFlowActivation.ts","utf8");
 assert.match(src,/throw new ServiceError\(message,status,code\)/);
 assert.match(src,/new ServiceError\(result\?\.error\|\|"denied",200,\(result as \{code\?:unknown\}\|null\)\?\.code\)/);
 assert.match(src,/export \{ServiceError,serviceErrorDetail,activationErrorMessage\} from "\.\/activationErrors\.ts"/);
});
