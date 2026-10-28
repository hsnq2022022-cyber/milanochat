import {assertEquals} from "jsr:@std/assert@1";
import {prepareSimpleFlowReply} from "../supabase/functions/milan-api/flowPrepareMessage.ts";

const doc={version:3,nodes:[
 {id:"start",data:{kind:"trigger",platform:"instagram",triggerMode:"message"}},
 {id:"reply",data:{kind:"message",text:"أهلًا بك",options:[],contentBlocks:[],image:""}}
],edges:[{source:"start",target:"reply",sourceHandle:"next"}]};
function db(approved:boolean,globalOn=true,tenantOn=true){
 const queries:string[]=[];
 const from=(name:string)=>{
  queries.push(name);
  const chain:{
   select:(cols:string)=>typeof chain;
   eq:(col:string,v:unknown)=>typeof chain;
   maybeSingle:()=>Promise<{data:unknown;error:null}>;
   limit:(n:number)=>Promise<{data:unknown;error:null}>;
  }={
   select:()=>chain,eq:()=>chain,
   maybeSingle:async()=>({data:name==="automation_flow_global_switch"?{enabled:globalOn}:
    name==="automation_flow_tenant_switches"?{enabled:tenantOn,production_approved:approved}:
    name==="automation_flow_publications"?{document:doc}:null,error:null}),
   limit:async()=>({data:[{flow_key:"main",revision:1}],error:null})
  };
  return chain;
 };
 return {client:{from},queries};
}
Deno.test("production Instagram text only when independently approved",async()=>{
 const previous=Deno.env.get("FLOW_RUNTIME_MODE");
 try{
  Deno.env.delete("FLOW_RUNTIME_MODE");
  for(const [approved,globalOn,tenantOn,expected] of [
   [true,true,true,"أهلًا بك"],[false,true,true,null],
   [true,false,true,null],[true,true,false,null]
  ] as const){
   const fixture=db(approved,globalOn,tenantOn);
   const result=await prepareSimpleFlowReply(fixture.client as never,"tenant","account","instagram");
   assertEquals(result,expected);
  }
  const other=db(true);
  assertEquals(await prepareSimpleFlowReply(other.client as never,"tenant","account","facebook"),null);
  assertEquals(other.queries.length,0);
  Deno.env.set("FLOW_RUNTIME_MODE","off");
  const blocked=db(true);
  assertEquals(await prepareSimpleFlowReply(blocked.client as never,"tenant","account","instagram"),null);
  assertEquals(blocked.queries.length,0);
 }finally{
  if(previous===undefined)Deno.env.delete("FLOW_RUNTIME_MODE");
  else Deno.env.set("FLOW_RUNTIME_MODE",previous);
 }
});
