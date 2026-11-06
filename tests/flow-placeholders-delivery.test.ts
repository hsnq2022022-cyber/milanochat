import {test} from "node:test";
import assert from "node:assert/strict";
import {simpleMessageFromDocument} from "../supabase/functions/milan-api/flowPrepareMessage.ts";
import {readFileSync} from "node:fs";
import {sendProviderMessage,scrubPlaceholders,deliveredText,encryptMessageBody,decryptAccountToken,
 type ProviderRequest} from "../supabase/functions/flow-outbox-worker/deliveryCore.ts";

const LEAK=/\{\{[^{}\r\n]*\}\}/;
const msg=(id:string,text:string)=>({id,data:{kind:"message",text,options:[],contentBlocks:[],image:""}});
function simple(text:string){
 return {version:3,name:"t",nodes:[{id:"in",data:{kind:"trigger",platform:"instagram",triggerMode:"message",keywords:""}},
  msg("out",text)],edges:[{source:"in",sourceHandle:"next",target:"out",targetHandle:"in"}]};
}
function conditional(yes:string,no:string){
 return {version:3,name:"c",nodes:[{id:"in",data:{kind:"trigger",platform:"instagram",triggerMode:"message",keywords:""}},
  {id:"if",data:{kind:"condition",conditionField:"message",operator:"contains",conditionValue:"سعر"}},
  msg("y",yes),msg("n",no)],
  edges:[{source:"in",sourceHandle:"next",target:"if",targetHandle:"in"},
   {source:"if",sourceHandle:"yes",target:"y",targetHandle:"in"},
   {source:"if",sourceHandle:"no",target:"n",targetHandle:"in"}]};
}
test("V2 simple reply: no placeholder is ever returned literally",()=>{
 const out=simpleMessageFromDocument(simple("أهلاً {{first_name}} {{رقم الهاتف}} {{ اسم العميل }} {{age}}"),"instagram");
 assert.equal(out,"أهلاً عميلنا العزيز [غير متوفر] [غير متوفر] [غير متوفر]");
 assert.doesNotMatch(out!,LEAK);
 assert.equal(simpleMessageFromDocument(simple("بدون متغيرات"),"instagram"),"بدون متغيرات");
 assert.equal(simpleMessageFromDocument(simple("{{"),"instagram"),"{{","lone braces are not placeholders");
});
test("V2 conditional reply: both branches are sanitised",()=>{
 const d=conditional("السعر لـ {{first_name}}","{{age}} غير معروف");
 assert.equal(simpleMessageFromDocument(d,"instagram","كم السعر"),"السعر لـ عميلنا العزيز");
 assert.equal(simpleMessageFromDocument(d,"instagram","مرحبا"),"[غير متوفر] غير معروف");
});
test("V2: fallback growth stays within the 1000-byte bound",()=>{
 const enc=new TextEncoder();
 const raw="ع".repeat(496)+"{{age}}"; // 999 bytes
 const out=simpleMessageFromDocument(simple(raw),"instagram")!;
 assert.ok(enc.encode(out).byteLength<=1000);
 assert.doesNotMatch(out,LEAK);
});

function recorder(){
 const bodies:string[]=[];
 const fake=(async(_url:string,init:RequestInit)=>{
  bodies.push(String(init.body));
  return new Response(JSON.stringify({message_id:"mid"}),{status:200});
 }) as typeof fetch;
 return {bodies,fake};
}
const base={platform:"instagram" as const,token:"IG-token",externalId:"",recipient:"123456"};
test("worker: a stored effect with placeholders is scrubbed in text, quick replies and button titles",async()=>{
 const r=recorder();
 await sendProviderMessage({...base,text:"مرحباً {{first_name}} {{رقم الهاتف}}",
  quickReplies:[{id:"a",label:"{{first_name}}"},{id:"b",label:"عادي"}]},r.fake);
 const body=JSON.parse(r.bodies[0]);
 assert.equal(body.message.text,"مرحباً عميلنا العزيز [غير متوفر]");
 assert.deepEqual(body.message.quick_replies.map((q:{title:string;payload:string})=>[q.title,q.payload]),
  [["عميلنا العزيز","flow-choice:a"],["عادي","flow-choice:b"]]);
 assert.doesNotMatch(r.bodies[0],LEAK);
 const url="https://example.org/p?q={{age}}";
 const w=recorder();
 await sendProviderMessage({...base,text:"تفضل {{age}}",websiteButtons:[{label:"{{اسم العميل}}",url}]},w.fake);
 const card=JSON.parse(w.bodies[0]).message.attachment.payload;
 assert.equal(card.text,"تفضل [غير متوفر]");
 assert.equal(card.buttons[0].title,"[غير متوفر]");
 assert.equal(card.buttons[0].url,new URL(url).href,"button URL is never scrubbed");
 // Messenger card title clamped to 80 after scrubbing.
 const f=recorder();
 await sendProviderMessage({platform:"facebook",token:"EAApage",externalId:"",recipient:"123456",
  text:"م".repeat(75)+"{{x}}",websiteButtons:[{label:"متجر",url:"https://example.org"}]},f.fake);
 assert.equal(JSON.parse(f.bodies[0]).message.attachment.payload.elements[0].title.length,80);
});
test("worker: payloads without placeholders are byte-identical and the same object",async()=>{
 const reqs:ProviderRequest[]=[
  {...base,text:"اهلا { } }} {{"},
  {...base,text:"اختر",quickReplies:[{id:"a",label:"A"}]},
  {...base,text:"تفضل",websiteButtons:[{label:"متجرنا",url:"https://example.org/p"}]},
  {...base,text:"",imageUrl:"https://x.supabase.co/storage/v1/object/public/flow-media/a/{{b}}.jpg",
   imageHost:"https://x.supabase.co"}
 ];
 for(const req of reqs)assert.equal(scrubPlaceholders(req),req);
 const a=recorder(),b=recorder();
 await sendProviderMessage(reqs[1],a.fake);
 assert.equal(a.bodies[0],JSON.stringify({recipient:{id:"123456"},
  message:{text:"اختر",quick_replies:[{content_type:"text",title:"A",payload:"flow-choice:a"}]}}));
 await sendProviderMessage({...base,text:"plain"},b.fake);
 assert.equal(b.bodies[0],JSON.stringify({recipient:{id:"123456"},message:{text:"plain"}}));
});

// Stored body (messages.body_encrypted) must equal what the provider received.
function sentText(platform:string,body:string):string{
 const p=JSON.parse(body);
 if(platform==="whatsapp")return p.text.body;
 const m=p.message;
 if(typeof m.text==="string")return m.text;
 if(m.attachment?.payload?.text!==undefined)return m.attachment.payload.text;
 return m.attachment.payload.elements[0].title;
}
const KEY="test-secret";
test("worker store: placeholder effects are stored scrubbed and equal to the sent text",async()=>{
 const raw="أهلاً {{first_name}} رقمك {{رقم الهاتف}} وعمرك {{age}}";
 const cases:ProviderRequest[]=[
  {...base,text:raw},
  {platform:"facebook",token:"EAApage",externalId:"",recipient:"123456",text:raw},
  {platform:"whatsapp",token:"wa",externalId:"100001",recipient:"9647712345678",text:raw},
  {...base,text:raw,quickReplies:[{id:"a",label:"{{first_name}}"}]},
  {...base,text:raw,websiteButtons:[{label:"متجر",url:"https://example.org/p"}]},
  {platform:"facebook",token:"EAApage",externalId:"",recipient:"123456",text:raw,
   websiteButtons:[{label:"متجر",url:"https://example.org/p"}]}
 ];
 for(const req of cases){
  const r=recorder();
  await sendProviderMessage(req,r.fake);
  const stored=deliveredText({platform:req.platform,text:req.text,websiteButtons:req.websiteButtons});
  assert.doesNotMatch(stored,LEAK);
  assert.equal(stored,sentText(req.platform,r.bodies[0]),req.platform+" stored body == sent text");
  // Scrubbed BEFORE encryption: the encrypted input decrypts to the scrubbed text.
  assert.equal(await decryptAccountToken(await encryptMessageBody(stored,KEY),KEY),stored);
 }
 assert.equal(deliveredText({platform:"instagram",text:raw}),
  "أهلاً عميلنا العزيز رقمك [غير متوفر] وعمرك [غير متوفر]");
});
test("worker store: text without placeholders is stored byte-identical",async()=>{
 for(const text of ["مرحبا بك","اهلا { } }} {{","a{{b\nc}}"]){
  assert.equal(deliveredText({platform:"instagram",text}),text);
  const r=recorder();
  await sendProviderMessage({...base,text},r.fake);
  assert.equal(sentText("instagram",r.bodies[0]),text);
 }
});
test("worker store: persistAndBill encrypts the delivered body; images keep their URL",()=>{
 const code=readFileSync("supabase/functions/flow-outbox-worker/index.ts","utf8");
 const stored=code.indexOf("const storedBody=imageUrl!==undefined?messageText:\n    deliveredText({platform:account.platform,text:messageText,websiteButtons});");
 const persist=code.indexOf("const persistAndBill=async(providerId:string)");
 const enc=code.indexOf("const encrypted=await encryptMessageBody(storedBody,fieldKey);");
 const insert=code.indexOf('sb.from("messages").insert({');
 assert(stored>0&&persist>stored&&enc>persist&&insert>enc);
 // messageText is final here (knowledge/recovery assignments happen earlier).
 assert.equal(code.slice(stored).search(/\bmessageText=/),-1);
 // Exactly one messages insert, and it never encrypts the raw messageText.
 assert.equal((code.match(/from\("messages"\)\.insert/g)??[]).length,1);
 assert.doesNotMatch(code,/encryptMessageBody\(messageText/);
 // The provider still receives the raw text (single scrub inside sendProviderMessage)
 // with the same platform and websiteButtons used for the stored body.
 assert.match(code,/token,recipient,text:messageText,quickReplies,websiteButtons/);
 assert.match(code,/token,recipient,text:"",imageUrl,imageHost:base/);
});
