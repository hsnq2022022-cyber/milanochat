/**
 * Pure Meta payload adapter. The send worker owns token/recipient and MUST
 * persist its outbox attempt before calling the provider.
 * Not an authorization boundary; incoming events need HMAC + tenant/run checks.
 */
export type QuickOption={id:string;label:string};
export type WebOption={label:string;url:string};
const validText=(x:unknown,max:number):x is string=>
 typeof x==="string"&&x.trim().length>0&&x.length<=max;
const validId=(x:unknown):x is string=>
 typeof x==="string"&&/^[a-zA-Z0-9_-]{1,128}$/.test(x);
export function metaQuickReplies(options:unknown,platform:string){
 if(platform!=="facebook"&&platform!=="instagram")throw Error("Unsupported quick-reply channel");
 if(!Array.isArray(options)||options.length<1||options.length>13)
  throw Error("Quick replies must contain 1 to 13 options");
 const used=new Set<string>();
 return options.map((item:QuickOption)=>{
  if(!item||!validId(item.id)||!validText(item.label,20)||used.has(item.id))
   throw Error("Invalid quick-reply option");
  used.add(item.id);
  return {content_type:"text" as const,title:item.label,payload:"flow-choice:"+item.id};
 });
}
export function messengerWebsiteButtons(text:string,buttons:unknown){
 if(!validText(text,80)||!Array.isArray(buttons)||buttons.length<1||buttons.length>3)
  throw Error("Invalid website card");
 const rows=buttons.map((button:WebOption)=>{
  if(!validText(button?.label,20)||!validText(button?.url,2048))
   throw Error("Invalid website button");
  let url:URL;
  try{url=new URL(button.url);}catch{throw Error("Website URL invalid");}
  if(url.protocol!=="https:"||url.username||url.password||
     !url.hostname||["localhost","127.0.0.1","::1"].includes(url.hostname))
   throw Error("Website URL not allowed");
  return {type:"web_url" as const,title:button.label,url:url.toString()};
 });
 return {attachment:{type:"template",payload:{template_type:"generic",
  elements:[{title:text,buttons:rows}]}}};
}
/** Extract candidate only; validated HMAC, active run and option list REQUIRED. */
export function metaSelectedQuickReply(message:unknown):string|null{
 if(!message||typeof message!=="object")return null;
 const raw=(message as {quick_reply?:{payload?:unknown}}).quick_reply?.payload;
 if(typeof raw!=="string"||!raw.startsWith("flow-choice:"))return null;
 const id=raw.slice("flow-choice:".length);
 return validId(id)?id:null;
}
