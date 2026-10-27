import {test} from "node:test";
import assert from "node:assert/strict";
import {useFlowStore} from "./store.ts";
import {blankFlow, FLOW_LIBRARY_KEY, loadLibrary, getLibraryRecoveryReport} from "./library.ts";
import {copySelection,pasteSelection} from "./clipboard.ts";
import {edgeFor, importFlow, makeNode, SAVE_KEY} from "./model.ts";

function fresh(){
 const d=blankFlow("test");
 useFlowStore.setState({doc:d,activeFlowId:"test",
  flows:[{id:"test",doc:d,enabled:false}],selectedId:null,
  past:[],future:[],pastEnabled:[],futureEnabled:[],lastEdit:null});
 return d;
}
test("store rejects a second trigger regardless of shortcut or menu",()=>{
 const doc=fresh(),store=useFlowStore.getState();
 assert.equal(store.addNode(makeNode("trigger",{x:500,y:500})),"duplicate_trigger");
 assert.equal(useFlowStore.getState().doc.nodes.filter(n=>n.data.kind==="trigger").length,1);
 assert.equal(useFlowStore.getState().past.length,0);
 assert.equal(store.addNode(makeNode("message",{x:500,y:500})),"added");
 assert.equal(useFlowStore.getState().doc.nodes.length,doc.nodes.length+1);
});
test("120 keystrokes create one undo item per field burst, then a second after 500ms",t=>{
 const doc=fresh();let now=1000;
 t.mock.method(Date,"now",()=>now);
 for(let i=0;i<120;i++){useFlowStore.getState().changeNode(doc.nodes[1].id,{text:"x".repeat(i+1)});now+=2;}
 assert.equal(useFlowStore.getState().past.length,1);
 assert.equal(useFlowStore.getState().doc.nodes[1].data.text.length,120);
 now+=501;
 useFlowStore.getState().changeNode(doc.nodes[1].id,{text:"after idle"});
 assert.equal(useFlowStore.getState().past.length,2);
 useFlowStore.getState().undo();
 assert.equal(useFlowStore.getState().doc.nodes[1].data.text.length,120);
 useFlowStore.getState().undo();
 assert.equal(useFlowStore.getState().doc.nodes[1].data.text,doc.nodes[1].data.text);
});
test("drag creates one undo snapshot despite intermediate positions",()=>{
 const doc=fresh(),store=useFlowStore.getState();
 store.pushHistory();
 for(let i=0;i<5;i++)store.nodesChanged([{type:"position",id:doc.nodes[1].id,position:{x:i*20,y:200+i*10},dragging:i<4}]);
 assert.equal(useFlowStore.getState().past.length,1);
 store.undo();
 assert.deepEqual(useFlowStore.getState().doc.nodes[1].position,doc.nodes[1].position);
});
test("multi-node clipboard keeps internal edges, remaps button IDs and excludes trigger",()=>{
 const doc=fresh();const t=doc.nodes[0],a=doc.nodes[1];
 const b=makeNode("question",{x:600,y:600},{options:[{id:"opt-a",label:"A"}]});
 const c=makeNode("message",{x:900,y:800},{text:"selected"});
 doc.nodes.push(b,c);
 doc.edges.push(edgeFor({source:b.id,sourceHandle:"opt-a",target:c.id,targetHandle:"in"}));
 const clip=copySelection(doc,[t.id,b.id,c.id]);
 const output=pasteSelection(doc,clip);
 assert.equal(output.ok,true);
 if(!output.ok)throw Error("expected clone");
 assert.equal(output.skippedTriggers,1);
 assert.equal(output.nodes.length,2);
 assert.equal(output.edges.length,1);
 assert.notEqual(output.nodes[0].id,b.id);
 assert.notEqual(output.nodes[0].data.options[0].id,"opt-a");
 assert.equal(output.edges[0].sourceHandle,output.nodes[0].data.options[0].id);
 assert.equal(output.edges[0].target,output.nodes[1].id);
 assert.equal(pasteSelection(doc,copySelection(doc,[t.id])).ok,false);
});
test("legacy version two condition keyword survives migration",()=>{
 const imported=importFlow({version:2,name:"legacy",nodes:[
  {id:"trigger",type:"trigger",keyword:"hi",x:0,y:0},
  {id:"condition",type:"condition",keyword:"اشتراك",x:0,y:200}
 ],edges:[{id:"e",from:"trigger",to:"condition",port:"next"}]});
 assert.ok(imported);
 assert.equal(imported.nodes[1].data.conditionValue,"اشتراك");
});
test("corrupt library/draft is preserved under an ISO-stamped backup key",()=>{
 const oldWindow=(globalThis as any).window,oldStorage=(globalThis as any).localStorage;
 const raw="{broken library",draft="{broken draft";
 const data=new Map<string,string>([[FLOW_LIBRARY_KEY,raw],[SAVE_KEY,draft]]);
 (globalThis as any).window={};
 (globalThis as any).localStorage={
  getItem:(k:string)=>data.get(k)??null,
  setItem:(k:string,v:string)=>{data.set(k,v);}
 };
 try{
  const fallback=loadLibrary(),report=getLibraryRecoveryReport();
  assert.equal(fallback.flows.length,1);
  assert.equal(data.get(FLOW_LIBRARY_KEY),raw);
  assert.equal(data.get(SAVE_KEY),draft);
  assert.equal(report.backups.length,2);
  for(const backup of report.backups){
   assert.match(backup.key,/^social_flow_backup_\\d{4}-/);
   assert.equal(data.get(backup.key),backup.raw);
   assert.equal(backup.raw,backup.sourceKey===SAVE_KEY?draft:raw);
  }
 }finally{(globalThis as any).window=oldWindow;(globalThis as any).localStorage=oldStorage;}
});
