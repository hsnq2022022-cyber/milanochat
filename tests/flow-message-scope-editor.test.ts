/**
 * T4 step 3: NodeEditor control for a message trigger's `messageScope`.
 * Bundles the real NodeEditor with esbuild and drives it in headless Chromium
 * (skipped when esbuild or the browser is unavailable). No network, no server.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {existsSync,readdirSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname,resolve} from "node:path";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const chromeCandidates=["/opt/pw-browsers/chromium/chrome-linux/chrome","/opt/pw-browsers/chromium/chrome-linux64/chrome"];
function findChrome():string|undefined{
 for(const c of chromeCandidates)if(existsSync(c))return c;
 try{const base="/opt/pw-browsers";for(const d of readdirSync(base).filter(x=>/^chromium-\d+$/.test(x))){
  for(const sub of ["chrome-linux/chrome","chrome-linux64/chrome"]){const p=base+"/"+d+"/"+sub;if(existsSync(p))return p;}}}catch{}
 return undefined;
}
const chrome=findChrome();
let esbuild:any,pw:any;
try{esbuild=await import("esbuild");pw=await import("@playwright/test");}catch{}
const skip=!chrome||!esbuild||!pw?"esbuild/playwright/chromium unavailable":false;

const entry=`
import React from "react";
import {createRoot} from "react-dom/client";
import NodeEditor from "./src/flow/NodeEditor.tsx";
import {useFlowStore} from "./src/flow/store.ts";
import {makeNode,edgeFor} from "./src/flow/model.ts";
function App(){const s=useFlowStore();const n=s.doc.nodes.find(x=>x.data.kind==="trigger")||null;return <NodeEditor node={n} onClose={()=>{}}/>;}
(window as any).__setup=(mode:string,scope:string|undefined,next:string)=>{
  const t=makeNode("trigger",{x:0,y:0},{triggerMode:mode as any,platform:"instagram" as any,...(scope?{messageScope:scope as any}:{})});
  const nx=makeNode(next as any,{x:300,y:0},{});
  useFlowStore.getState().replace({version:3,name:"t",nodes:[t,nx],edges:[edgeFor({source:t.id,sourceHandle:"next",target:nx.id,targetHandle:"in"},"التالي")]} as any);
};
(window as any).__trigger=()=>JSON.parse(JSON.stringify(useFlowStore.getState().doc.nodes.find(x=>x.data.kind==="trigger")!.data));
createRoot(document.getElementById("root")!).render(<App/>);
`;
async function launch(){
 const out=await esbuild.build({stdin:{contents:entry,resolveDir:root,sourcefile:"entry.tsx",loader:"tsx"},bundle:true,write:false,format:"iife",
  jsx:"automatic",loader:{".css":"empty",".svg":"dataurl",".png":"dataurl"},define:{"process.env.NODE_ENV":'"development"',"import.meta.env":"{}"},logLevel:"silent"});
 const browser=await pw.chromium.launch({executablePath:chrome,args:["--no-sandbox"]});
 const page=await browser.newPage();
 await page.setContent('<div id="root"></div>');
 // setup must run before first render of the app; the bundle renders immediately with an empty doc, then we load a doc.
 await page.addScriptTag({content:out.outputFiles[0].text});
 return {browser,page};
}
const SCOPE="[data-testid='trigger-message-scope']",NOTE="[data-testid='trigger-message-scope-note']",DELAY="[data-testid='trigger-message-scope-delay-warning']";
const load=async(page:any,mode:string,scope:string|undefined,next:string)=>{await page.evaluate(([m,s,n]:any)=>(window as any).__setup(m,s,n),[mode,scope,next]);};

test("select writes messageScope, empty option removes the key, warning only for conversation_start",{skip},async()=>{
 const {browser,page}=await launch();
 try{
  await load(page,"message",undefined,"message");
  assert.equal(await page.locator(SCOPE).inputValue(),"");
  assert.equal(await page.locator(NOTE).count(),0);
  assert.equal(await page.locator("label[for^='msg-scope-']").innerText(),"متى يعمل هذا المشغّل؟");
  assert.deepEqual(await page.locator(SCOPE+" option").allInnerTexts(),["غير محدد (يُعامل ككل رسالة)","كل رسالة","بداية المحادثة فقط"]);
  await page.selectOption(SCOPE,"every_message");
  assert.equal((await page.evaluate(()=>(window as any).__trigger())).messageScope,"every_message");
  assert.equal(await page.locator(NOTE).count(),0);
  await page.selectOption(SCOPE,"conversation_start");
  assert.equal((await page.evaluate(()=>(window as any).__trigger())).messageScope,"conversation_start");
  assert.equal(await page.locator(NOTE).getAttribute("role"),"note");
  assert.match(await page.locator(NOTE).innerText(),/يعمل مع أول رسالة خاصة فقط؛ التعليقات لا تُحتسب، ولا يبدأ بانتظار/);
  assert.equal(await page.locator(DELAY).count(),0,"message next node: no delay warning");
  await page.selectOption(SCOPE,"");
  const d=await page.evaluate(()=>(window as any).__trigger());
  assert.equal(Object.prototype.hasOwnProperty.call(d,"messageScope"),false);
  assert.equal(await page.locator(NOTE).count(),0);
 }finally{await browser.close();}
});

test("delay warning only for conversation_start with an immediate delay",{skip},async()=>{
 const {browser,page}=await launch();
 try{
  await load(page,"message","conversation_start","delay");
  assert.equal(await page.locator(DELAY).count(),1);
  await load(page,"message","every_message","delay");
  assert.equal(await page.locator(DELAY).count(),0);
  assert.equal(await page.locator(NOTE).count(),0);
  await load(page,"message",undefined,"delay");
  assert.equal(await page.locator(DELAY).count(),0);
 }finally{await browser.close();}
});

test("changing the trigger mode away from message clears messageScope; control hidden",{skip},async()=>{
 const {browser,page}=await launch();
 try{
  await load(page,"message","conversation_start","message");
  await page.selectOption("select:has(option[value='comment'])","comment");
  const d=await page.evaluate(()=>(window as any).__trigger());
  assert.notEqual(d.triggerMode,"message");
  assert.equal(Object.prototype.hasOwnProperty.call(d,"messageScope"),false);
  assert.equal(await page.locator(SCOPE).count(),0);
  // back to message: control returns unset, no stale value
  await page.selectOption("select:has(option[value='message'])","message");
  assert.equal(await page.locator(SCOPE).inputValue(),"");
 }finally{await browser.close();}
});
