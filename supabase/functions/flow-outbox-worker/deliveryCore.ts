// Server-only Meta transport. No browser import and no implicit retry.
export type Provider="facebook"|"instagram"|"whatsapp";
export type ProviderRequest={
 platform:Provider;token:string;externalId:string;recipient:string;text:string;
};
export type Sender=(input:ProviderRequest,perform?:typeof fetch)=>Promise<string|null>;
function valid(text:string,max:number){return typeof text==="string"&&text.length>0&&text.length<=max;}
export async function sendProviderMessage(input:ProviderRequest,perform:typeof fetch=fetch):Promise<string|null>{
 if(!input||!["facebook","instagram","whatsapp"].includes(input.platform)||
  !valid(input.token,4096)||!valid(input.recipient,128)||!valid(input.text,4000)||
  !/^[0-9]{1,30}$/.test(input.recipient))
  throw Error("Invalid provider message or account");
 let url="",headers:Record<string,string>={"content-type":"application/json"};
 let payload:Record<string,unknown>={};
 if(input.platform==="whatsapp"){
  if(!/^[0-9]{5,30}$/.test(input.externalId))throw Error("Missing WhatsApp phone ID");
  url="https://graph.facebook.com/v21.0/"+input.externalId+"/messages";
  headers.authorization="Bearer "+input.token;
  payload={messaging_product:"whatsapp",to:input.recipient,type:"text",text:{body:input.text}};
 }else{
  const envelope={recipient:{id:input.recipient},message:{text:input.text}};
  if(input.platform==="instagram"&&input.token.startsWith("IG")){
   url="https://graph.instagram.com/v21.0/me/messages";
   headers.authorization="Bearer "+input.token;
   payload=envelope;
  }else{
   if(input.platform==="instagram"&&!/^[0-9]{5,30}$/.test(input.externalId))
    throw Error("Invalid Instagram account ID");
   url=input.platform==="instagram"?
    "https://graph.facebook.com/v21.0/"+input.externalId+"/messages":
    "https://graph.facebook.com/v21.0/me/messages";
   // Match live milan-api's existing API payload.
   payload={...envelope,access_token:input.token};
  }
 }
 const res=await perform(url,{method:"POST",headers,body:JSON.stringify(payload),
  signal:AbortSignal.timeout(15000)});
 if(!res.ok)throw Error("Provider HTTP "+res.status);
 const data:unknown=await res.json().catch(()=>null);
 if(!data||typeof data!=="object")return null;
 const body=data as Record<string,unknown>;
 const first=Array.isArray(body.messages)?body.messages[0]:null;
 const candidate=input.platform==="whatsapp"&&first&&typeof first==="object"?
  (first as Record<string,unknown>).id:body.message_id??body.id;
 return valid(candidate as string,255)?candidate as string:null;
}
/** v101 field format: enc:v1:iv_hex:tag_hex:ciphertext_hex */
export async function decryptAccountToken(value:string,fieldKey:string):Promise<string>{
 if(!value.startsWith("enc:v1:"))throw Error("Account token is not encrypted");
 if(!fieldKey)throw Error("FIELD_ENCRYPTION_KEY missing");
 const parts=value.split(":");
 if(parts.length!==5||!/^([0-9a-f]{2})+$/i.test(parts[2])||
    !/^([0-9a-f]{2})+$/i.test(parts[3])||
    !/^([0-9a-f]{2})+$/i.test(parts[4])||
    parts[2].length!==24||parts[3].length!==32)throw Error("Invalid encrypted account token");
 const binary=(hex:string)=>Uint8Array.from(hex.match(/../g)!.map(v=>parseInt(v,16)));
 const material=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(fieldKey));
 const aes=await crypto.subtle.importKey("raw",material,{name:"AES-GCM"},false,["decrypt"]);
 const cipher=binary(parts[4]),tag=binary(parts[3]);
 const combined=new Uint8Array(cipher.length+tag.length);
 combined.set(cipher);combined.set(tag,cipher.length);
 const plaintext=await crypto.subtle.decrypt({name:"AES-GCM",iv:binary(parts[2])},
   aes,combined);
 return new TextDecoder().decode(plaintext);
}
export async function encryptMessageBody(value:string,fieldKey:string):Promise<string>{
 if(!fieldKey)throw Error("FIELD_ENCRYPTION_KEY missing");
 const material=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(fieldKey));
 const aes=await crypto.subtle.importKey("raw",material,{name:"AES-GCM"},false,["encrypt"]);
 const iv=crypto.getRandomValues(new Uint8Array(12));
 const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv},aes,new TextEncoder().encode(value)));
 const hex=(b:Uint8Array)=>Array.from(b,x=>x.toString(16).padStart(2,"0")).join("");
 return "enc:v1:"+hex(iv)+":"+hex(encrypted.slice(-16))+":"+hex(encrypted.slice(0,-16));
}
