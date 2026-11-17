import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {classifyPublishLive,SAVED_NOT_LIVE_FALLBACK_AR,PUBLISH_LIVE_TEXT} from "../src/flow/publishLiveResult.ts";

const ui=readFileSync("src/flow/FlowPublicationPanel.tsx","utf8");
const FB={kind:"saved_not_live",message:SAVED_NOT_LIVE_FALLBACK_AR};

test("live only for ok:true + status live",()=>{
 assert.deepEqual(classifyPublishLive({ok:true,status:"live",revision:7}),{kind:"live"});
 assert.deepEqual(classifyPublishLive({ok:true,status:"live",revision:7,extra:1,reason:"x"}),{kind:"live"});
});
test("saved_not_live uses a safe Arabic server message",()=>{
 const m="تم حفظ التدفق، لكن الحساب غير جاهز للتفعيل.";
 assert.deepEqual(classifyPublishLive({ok:true,status:"saved_not_live",revision:3,reason:"flag_off",message:m}),{kind:"saved_not_live",message:m});
});
test("unsafe or missing message falls back",()=>{
 for(const message of ["Flow saved","تم الحفظ 123","تم الحفظ https://x.y","تم الحفظ www.x.com","ا".repeat(201),"",  "   ",42,null,{},["تم"],"123","!!!"])
  assert.deepEqual(classifyPublishLive({ok:true,status:"saved_not_live",message}),FB,String(message));
 assert.deepEqual(classifyPublishLive({ok:true,status:"saved_not_live"}),FB);
 const out=classifyPublishLive({ok:true,status:"saved_not_live",revision:9,reason:"code_x",message:"x"});
 assert.doesNotMatch(JSON.stringify(out),/9|code_x|revision|reason/);
});
test("everything else is unexpected",()=>{
 for(const v of [{ok:false,status:"live"},{ok:true},{status:"live"},{ok:true,status:"saved"},{ok:true,status:"LIVE"},
  {ok:"true",status:"live"},{ok:true,status:"unknown"},null,undefined,[],"live",1,true,[{ok:true,status:"live"}]])
  assert.deepEqual(classifyPublishLive(v),{kind:"unexpected"},JSON.stringify(v));
});
test("neutral failure text claims neither saved nor active",()=>{
 assert.doesNotMatch(PUBLISH_LIVE_TEXT.failed.ar,/تم (حفظ|نشر)|يعمل الآن/);
 assert.doesNotMatch(PUBLISH_LIVE_TEXT.failed.en,/was saved|is live/i);
});

const pub=ui.slice(ui.indexOf("const publishInFlight"),ui.indexOf("const reasonText"));
test("panel publish uses publish_live as one action",()=>{
 assert.match(pub,/action:"publish_live",accountId,flowKey,document/);
 assert.doesNotMatch(pub,/action:"publish"[,}]/);
 assert.doesNotMatch(pub,/activate|rollback/);
 assert.match(pub,/!isEditingLocalFlow/);
 assert.match(ui,/data-testid="flow-publish"/);
});
test("in-flight ref guard is set before the first await",()=>{
 assert.match(pub,/useRef|publishInFlight\.current\)return/);
 assert.match(ui,/const publishInFlight=useRef\(false\)/);
 assert.ok(pub.indexOf("publishInFlight.current=true")<pub.indexOf("await "));
 assert.match(pub,/finally\{publishInFlight\.current=false/);
});
test("no code suffix or raw error on the publish path; live text only on kind live",()=>{
 assert.doesNotMatch(pub,/codeSuffix|serviceErrorDetail|console\./);
 assert.match(pub,/result\.kind==="live"\?\(en\?PUBLISH_LIVE_TEXT\.live\.en/);
 assert.equal((pub.match(/PUBLISH_LIVE_TEXT\.live/g)??[]).length,2);
 assert.match(pub,/if\(result\.kind!=="unexpected"\)\{try\{await refresh/);
});
