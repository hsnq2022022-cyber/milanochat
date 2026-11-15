import {test} from "node:test";
import assert from "node:assert/strict";
import {classifyMessageScope,messageScopeAllowsFlow,type MessageScopeClass} from "../supabase/functions/milan-api/flowMessageScope.ts";
import {MESSAGE_SCOPES} from "../src/flow/model.ts";

const CLASSES:MessageScopeClass[]=["every_message","conversation_start","invalid"];
const INVALID_VALUES:unknown[]=[null,""," conversation_start","conversation_start ","Conversation_Start","EVERY_MESSAGE","Every_Message",
 "always",0,1,Number.NaN,true,false,{},[]];

test("missing key or explicit undefined is legacy every_message",()=>{
 assert.equal(classifyMessageScope({kind:"trigger"}),"every_message");
 assert.equal(classifyMessageScope({}),"every_message");
 assert.equal(classifyMessageScope({messageScope:undefined}),"every_message");
});
test("exact valid values classify to themselves",()=>{
 assert.equal(classifyMessageScope({messageScope:"every_message"}),"every_message");
 assert.equal(classifyMessageScope({messageScope:"conversation_start"}),"conversation_start");
 for(const s of MESSAGE_SCOPES) assert.equal(classifyMessageScope({messageScope:s}),s);
});
test("anything else is invalid (no trim, case folding, or coercion)",()=>{
 for(const v of INVALID_VALUES) assert.equal(classifyMessageScope({messageScope:v}),"invalid",String(v));
 assert.equal(classifyMessageScope({messageScope:Symbol("conversation_start")}),"invalid");
 assert.equal(classifyMessageScope({messageScope:()=>"conversation_start"}),"invalid");
});
test("inherited messageScope is ignored (treated as absent)",()=>{
 assert.equal(classifyMessageScope(Object.create({messageScope:"conversation_start"})),"every_message");
 assert.equal(classifyMessageScope(Object.create({messageScope:"bogus"})),"every_message");
});
test("non-object input fails safe to invalid",()=>{
 for(const v of [null,undefined,"x",5,[],true]) assert.equal(classifyMessageScope(v),"invalid",String(v));
});
test("throwing getter returns invalid instead of throwing",()=>{
 const d=Object.defineProperty({},"messageScope",{enumerable:true,get(){throw new Error("boom");}});
 assert.equal(classifyMessageScope(d),"invalid");
 const p=new Proxy({},{has(){throw new Error("x");},getOwnPropertyDescriptor(){throw new Error("x");},get(){throw new Error("x");}});
 assert.equal(classifyMessageScope(p),"invalid");
});
test("classify does not mutate input",()=>{
 const d=Object.freeze({kind:"trigger",messageScope:"conversation_start"});
 assert.equal(classifyMessageScope(d),"conversation_start");
 assert.deepEqual(d,{kind:"trigger",messageScope:"conversation_start"});
 const m={messageScope:" every_message"};
 classifyMessageScope(m);
 assert.deepEqual(m,{messageScope:" every_message"});
});
test("messageScopeAllowsFlow full truth table",()=>{
 const starts=[true,false,null,undefined] as const;
 const expected:Record<MessageScopeClass,boolean[]>={
  every_message:[true,true,true,true],
  conversation_start:[true,false,false,false],
  invalid:[false,false,false,false],
 };
 for(const c of CLASSES) starts.forEach((s,i)=>assert.equal(messageScopeAllowsFlow(c,s),expected[c][i],`${c}/${String(s)}`));
});
test("invalid never allows the flow and never equals a valid class",()=>{
 for(const s of [true,false,null,undefined]) assert.equal(messageScopeAllowsFlow("invalid",s),false);
 for(const v of INVALID_VALUES){
  const c=classifyMessageScope({messageScope:v});
  assert.notEqual(c,"every_message");
  assert.notEqual(c,"conversation_start");
 }
});
test("result is always one of the three literals (fuzz)",()=>{
 const odd:unknown[]=[...INVALID_VALUES,undefined,-0,Infinity,-1,10n,"null","undefined","conversation-start","every message",
  "conversation_start\n","​conversation_start",new String("conversation_start"),new Date(0),/x/,new Map(),
  {messageScope:"conversation_start"},["conversation_start"],Object.create(null)];
 for(const v of odd){
  assert.ok(CLASSES.includes(classifyMessageScope({messageScope:v})));
  assert.ok(CLASSES.includes(classifyMessageScope(v)));
 }
 const nullProto=Object.create(null);nullProto.messageScope="conversation_start";
 assert.equal(classifyMessageScope(nullProto),"conversation_start");
});
