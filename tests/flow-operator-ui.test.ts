import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync,statSync} from "node:fs";
import {join} from "node:path";
import {classifyOperatorStatus} from "../src/flow/operatorStatus.ts";
import {classifyStopError,classifyStopReply,STOP_TEXT} from "../src/flow/emergencyStop.ts";

const read=(f:string)=>readFileSync(f,"utf8");
const code=(src:string)=>src.replace(/^\s*\/\/.*$/gm,""); // drop whole-line comments

test("operator only for an object with ok===true and operator===true exactly",()=>{
 assert.equal(classifyOperatorStatus({ok:true,operator:true}),"operator");
 assert.equal(classifyOperatorStatus({ok:true,operator:true,extra:1}),"operator");
});
test("every other reply is customer (fail closed)",()=>{
 for(const v of [{ok:true,operator:false},{ok:false,operator:true},{ok:true},{operator:true},{ok:"true",operator:true},
  {ok:true,operator:"true"},{ok:true,operator:1},{ok:1,operator:1},{ok:true,operator:null},{ok:true,operator:{}},
  {ok:false,error:"Operator access required"},null,undefined,"operator",true,1,[],[{ok:true,operator:true}],
  Object.create(null)])
  assert.equal(classifyOperatorStatus(v),"customer",JSON.stringify(v));
});

test("emergency stop: success only for {ok:true,active:false}",()=>{
 assert.equal(classifyStopReply({ok:true,active:false}),"stopped");
 for(const v of [{ok:true},{ok:true,active:true},{ok:true,active:"false"},{ok:false,active:false},{active:false},null,undefined,"ok",[],[{ok:true,active:false}]])
  assert.equal(classifyStopReply(v),"failed",JSON.stringify(v));
});
test("emergency stop errors: only the server's 404 'No active publication found' means not running",()=>{
 assert.equal(classifyStopError(Object.assign(new Error("No active publication found"),{status:404})),"not_running");
 for(const e of [Object.assign(new Error("No active publication found"),{status:500}),Object.assign(new Error("other"),{status:404}),
  Object.assign(new Error("Account not authorized"),{status:403}),Object.assign(new Error("unavailable"),{status:0}),
  new Error("No active publication found"),null,undefined,"x",{status:"404",message:"No active publication found"}])
  assert.equal(classifyStopError(e),"failed",String(e));
});
test("emergency stop texts are plain: no digits, codes, revisions or engine words; failure claims nothing",()=>{
 const FORBIDDEN=/\d|revision|engine|canary|operator|flag|code|HTTP|إصدار|محرك|رمز|تجريبي/i;
 for(const [k,t] of Object.entries(STOP_TEXT)){
  assert.match(t.ar,/[؀-ۿ]/,k);
  assert.doesNotMatch(t.ar,FORBIDDEN,k);assert.doesNotMatch(t.en,FORBIDDEN,k);
 }
 assert.doesNotMatch(STOP_TEXT.failed.ar,/^تم /);assert.doesNotMatch(STOP_TEXT.failed.en,/was stopped/);
 assert.doesNotMatch(STOP_TEXT.not_running.ar,/تم إيقاف/);
});

test("operator status never comes from env flags, roles, metadata or localStorage",()=>{
 for(const f of ["src/flow/operatorStatus.ts","src/flow/useOperatorStatus.ts"]){
  const src=read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm,"");
  assert.doesNotMatch(src,/import\.meta|localStorage|sessionStorage|metadata|tenant_staff|role|VITE_/,f);
 }
 assert.match(read("src/flow/useOperatorStatus.ts"),/invokeService<[^>]*>\(\{action:"operator_status"\}\)/);
 assert.match(read("src/flow/useOperatorStatus.ts"),/\(\)=>\{if\(!cancelled\)setStatus\("customer"\);\}/);
 assert.match(read("src/flow/useOperatorStatus.ts"),/useState<OperatorStatus>\("loading"\)/);
});

test("useFlowActivation: customers resolve the account from `accounts` only; operator actions are guarded",()=>{
 const hook=read("src/flow/useFlowActivation.ts");
 const load=hook.slice(hook.indexOf("const load=useCallback"),hook.indexOf("// A different comment platform"));
 const customer=load.indexOf("if(!operator){");
 assert.ok(customer>load.indexOf('invokeService({action:"accounts"})'));
 assert.ok(customer<load.indexOf('action:"catalog"')&&customer<load.indexOf('action:"list"'));
 const branch=code(load.slice(customer,load.indexOf("return;\n   }",customer)));
 assert.match(branch,/accountId:acc\.id/);
 assert.doesNotMatch(branch,/invokeService|catalog|"list"|readiness/);
 assert.match(hook,/access:ActivationAccess="customer"/,"fail closed default");
 for(const fn of ["const toggle=useCallback","const updateToLatest=useCallback","const activateRevision=useCallback"]){
  const body=hook.slice(hook.indexOf(fn),hook.indexOf(fn)+200);
  assert.match(body,/^const \w+=useCallback\(async\([^)]*\):Promise<ToggleResult>=>\{\n  if\(!operator\)return OPERATOR_ONLY;/,fn);
 }
 // Customer-facing failure reason carries no code.
 assert.match(hook,/reason:operator\?UNAVAILABLE_REASON\+" \(رمز: "\+serviceErrorDetail\(e\)\+"\)":CUSTOMER_UNAVAILABLE_REASON/);
 assert.doesNotMatch(hook.match(/const CUSTOMER_UNAVAILABLE_REASON="[^"]*"/)![0],/رمز|\d|HTTP/);
});

test("panel: the customer view renders no operator UI and calls no operator action",()=>{
 const ui=read("src/flow/FlowPublicationPanel.tsx");
 const start=ui.indexOf(" if(!operator){\n  // Customer view");
 assert.ok(start>0);
 const view=code(ui.slice(start,ui.indexOf("\n return <div",start)));
 assert.doesNotMatch(view,/call\(|action:|CANARY_UI|showActivationControls|productionReady|codeSuffix|serviceErrorDetail|revision|readiness|catalog|managedFlowKey|change\(|load\(/);
 assert.match(view,/data-testid="flow-publish" onClick=\{\(\)=>void publish\(\)\}/);
 assert.match(view,/data-testid="flow-stop" onClick=\{\(\)=>void stop\(\)\}/);
 assert.match(ui,/operator=false\}:Props\)/,"fail closed default");
 // Every operator-only call path refuses in customer mode (defense in depth).
 for(const guard of ['if(!operator||!accountId){setCatalog([]);setActiveServerFlows([]);return;}',
  "if(!operator||!onPreviewRevision||busy||!accountId)return;","if(!operator||!accountId||busy)return;\n  setReadiness(null);",
  "if(!operator||!onImportRevision||busy||!accountId)return;","if(!operator)return; // list is operator-only",
  "if(!operator||!accountId||busy)return;\n  setBusy(true);setNotice(\"\");setLoaded(false);","if(!operator||!loaded||!accountId||busy)return;"])
  assert.ok(ui.includes(guard),guard);
 const stop=ui.slice(ui.indexOf("const stop=async"),ui.indexOf(" if(!operator){\n  // Customer view"));
 assert.match(stop,/call\(\{action:"deactivate",accountId,flowKey\}\)/,"local flow key, no revision");
 assert.match(stop,/stopInFlight\.current=true/);
 assert.doesNotMatch(stop,/serviceErrorDetail|codeSuffix|activationErrorMessage/);
});

test("editor: operator controls only inside the isOperator block; opener and panel get the server status",()=>{
 const ui=read("src/pages/FlowBuilder.tsx");
 const open=ui.indexOf("{isOperator&&<>");
 const close=ui.indexOf("</>}\n        </>}",open);
 assert.ok(open>0&&close>open);
 const block=ui.slice(open,close);
 for(const id of ["flow-enabled-toggle","flow-live-revision","flow-update-latest","flow-revision-select","flow-activate-selected","flow-revision-stale"]){
  assert.ok(block.includes('data-testid="'+id+'"'),id);
  assert.equal(ui.split('data-testid="'+id+'"').length,2,id+" rendered only once");
 }
 assert.match(ui,/const isOperator=operatorStatus==="operator";/);
 assert.match(ui,/useFlowActivation\(activeFlowId,showPublications,localCommentPlatform,operatorStatus\)/);
 assert.match(ui,/useFlowCapabilities\(activation\.accountId,activeFlowId\)/);
 assert.match(ui,/<FlowPublicationPanel key=\{activeFlowId\+":"\+operatorStatus\} operator=\{isOperator\}/);
 assert.doesNotMatch(ui,/VITE_ENABLE_FLOW_CANARY_CONTROLS/);
});

test("only operator-mode code in src calls operator-only flow-publication actions",()=>{
 const files:string[]=[];
 const walk=(d:string)=>{for(const n of readdirSync(d)){const p=join(d,n);if(statSync(p).isDirectory())walk(p);else if(/\.tsx?$/.test(n)&&!/\.test\.ts$/.test(n))files.push(p);}};
 walk("src");
 const hits=files.filter(f=>/action:"(readiness|catalog|read|list|activate|rollback|publish)"|\{action,accountId/.test(read(f))).sort();
 assert.deepEqual(hits,["src/flow/FlowPublicationPanel.tsx","src/flow/useFlowActivation.ts"]);
});
