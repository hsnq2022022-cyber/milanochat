/**
 * Golden compatibility fixtures are generated from the actual git main importer.
 * Run only intentionally: node --experimental-strip-types tests/generate-flow-main-fixtures.ts
 * CI tests only READ the committed golden JSON and never regenerate it.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const source=execFileSync("git",["show","origin/main:src/flow/model.ts"],{encoding:"utf8"});
const temp=resolve("src/flow/__flow_main_fixture_tmp.ts");
writeFileSync(temp,source);
const node=(id:string,kind:string,changes:Record<string,unknown>={})=>({
  id,position:{x:10,y:15},type:"flowNode",data:{kind,title:id,text:"رسالة اختبار",image:"",
    options:[],contentBlocks:[],platform:"instagram",triggerMode:"message",keywords:"",
    inputMode:"buttons",inputField:"response",conditionField:"message",operator:"contains",conditionValue:"",
    delayValue:1,delayUnit:"minutes",actionType:"tag",actionValue:"",gotoNode:"",
    requestMethod:"GET",requestUrl:"",...changes}
});
const edge=(source:string,sourceHandle:string,target:string,id:string)=>({id,type:"flowEdge",source,sourceHandle,target,targetHandle:"in",data:{label:"التالي"}});
const v3=(name:string,nodes:unknown[],edges:unknown[])=>({version:3,name,nodes,edges});
const examples=[
  {name:"v2-simple",input:{version:2,name:"legacy",nodes:[
    {id:"old-start",type:"trigger",x:0,y:0,title:"بداية",text:"",keyword:"hi",image:"",choices:[]},
    {id:"old-message",type:"message",x:400,y:300,title:"رسالة",text:"مرحباً",image:"",choices:[]}],
    edges:[{id:"legacy-edge",from:"old-start",port:"next",to:"old-message"}]}},
  {name:"v3-simple",input:v3("basic",[node("s","trigger",{text:""}),node("m","message")],[edge("s","next","m","e1")])},
  {name:"v3-buttons-actions",input:v3("buttons",[node("s","trigger",{text:""}),node("m","message",{
    options:[{id:"plain",label:"التالي"},{id:"website",label:"افتح موقع",action:"website",url:"https://example.com"},
      {id:"quick",label:"رد سريع",buttonType:"quick_reply",action:"step"}]})],[edge("s","next","m","e1")])},
  {name:"v3-image-pdf",input:v3("media",[node("s","trigger",{text:""}),node("m","message",{
    image:"https://example.com/photo.jpg",contentBlocks:[{id:"b1",type:"image",url:"https://example.com/img.png"},
      {id:"b2",type:"pdf",url:"https://example.com/file.pdf"}]})],[edge("s","next","m","e1")])},
  {name:"v3-randomizer",input:v3("randomizer",[node("s","trigger",{text:""}),node("r","randomizer",{
    text:"",options:[{id:"half",label:"A",weight:50},{id:"second",label:"B",weight:50}]})],[edge("s","next","r","e1")])},
  {name:"v3-multiple-flows-primary",input:v3("primary",[node("s","trigger",{text:""}),node("m","message",{
    options:[{id:"jump",label:"تدفق آخر",action:"flow",targetFlowId:"second-flow"}]})],[edge("s","next","m","e1")])},
  {name:"v3-multiple-flows-secondary",input:v3("secondary",[node("s","trigger",{text:""}),node("m","message",{
    contentBlocks:[{id:"c",type:"collection",field:"email",inputMode:"email",text:"بريدك؟"}]})],[edge("s","next","m","e1")])}
];
try{
  const model=await import(pathToFileURL(temp).href);
  const cases=examples.map(({name,input})=>{
    const expected=model.importFlow(input);
    if(!expected)throw new Error("main importer rejected: "+name);
    return {name,input,expected};
  });
  mkdirSync("tests/fixtures",{recursive:true});
  writeFileSync("tests/fixtures/flow-main-compat.json",JSON.stringify({source:"origin/main:src/flow/model.ts",cases},null,2)+"\n");
  console.log("Generated "+cases.length+" golden fixtures from main importer.");
}finally{unlinkSync(temp);}
