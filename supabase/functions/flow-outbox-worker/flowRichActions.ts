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
/**
 * Instagram button template limits (Meta): 1..3 buttons, title <= 20, text <= 640.
 * Lengths are counted in code points (same rule as src/flow/model.ts).
 */
export const IG_BUTTONS_MAX=3,IG_BUTTON_TITLE_MAX=20,IG_BUTTON_TEXT_MAX=640,IG_BUTTON_URL_MAX=2000;
export type InstagramButtonProblem=
 "ig_buttons_text_invalid"|"ig_buttons_text_too_long"|"ig_buttons_count_invalid"|
 "ig_button_title_invalid"|"ig_button_url_invalid";
const CONTROL=/[\u0000-\u001F\u007F-\u009F]/;
const codePoints=(s:string)=>[...s].length;
/** Pre-send validation (no IO): null = representable as an Instagram button template. */
export function instagramButtonTemplateProblem(text:unknown,buttons:unknown):InstagramButtonProblem|null{
 if(typeof text!=="string"||!text.trim())return "ig_buttons_text_invalid";
 if(codePoints(text)>IG_BUTTON_TEXT_MAX)return "ig_buttons_text_too_long";
 if(!Array.isArray(buttons)||buttons.length<1||buttons.length>IG_BUTTONS_MAX)return "ig_buttons_count_invalid";
 for(const b of buttons as unknown[]){
  const button=b&&typeof b==="object"?b as Record<string,unknown>:null;
  const label=button?.label,raw=button?.url;
  if(typeof label!=="string"||!label.trim()||codePoints(label)>IG_BUTTON_TITLE_MAX||CONTROL.test(label))
   return "ig_button_title_invalid";
  if(typeof raw!=="string"||!raw||raw.length>IG_BUTTON_URL_MAX||/\s/.test(raw))return "ig_button_url_invalid";
  let url:URL;
  try{url=new URL(raw);}catch{return "ig_button_url_invalid";}
  if(url.protocol!=="https:"||url.username||url.password||
     !url.hostname||["localhost","127.0.0.1","[::1]","::1"].includes(url.hostname))
   return "ig_button_url_invalid";
 }
 return null;
}
/**
 * Instagram button template: {attachment:{type:"template",payload:{template_type:"button",
 * text,buttons:[{type:"web_url",url,title}]}}}. Buttons keep their order. Throws
 * (no request) when not representable; the worker checks the same rule BEFORE reserving.
 */
export function instagramWebsiteButtons(text:string,buttons:unknown){
 const problem=instagramButtonTemplateProblem(text,buttons);
 if(problem)throw Error("Invalid Instagram button template: "+problem);
 return {attachment:{type:"template",payload:{template_type:"button",text,
  buttons:(buttons as WebOption[]).map(b=>({type:"web_url" as const,url:new URL(b.url).href,title:b.label}))}}};
}
/** Extract candidate only; validated HMAC, active run and option list REQUIRED. */
export function metaSelectedQuickReply(message:unknown):string|null{
 if(!message||typeof message!=="object")return null;
 const raw=(message as {quick_reply?:{payload?:unknown}}).quick_reply?.payload;
 if(typeof raw!=="string"||!raw.startsWith("flow-choice:"))return null;
 const id=raw.slice("flow-choice:".length);
 return validId(id)?id:null;
}
