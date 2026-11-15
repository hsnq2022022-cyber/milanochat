/**
 * Instagram / Messenger events WITHOUT a provider message id (Meta normally
 * always sends `message.mid`; milan-api/index.ts used to substitute the
 * non-deterministic `ig_${Date.now()}`, so a redelivery of such an event got a
 * NEW id: a second inbound row and possibly a second reply).
 *
 * Policy (B-5):
 *  (i)  derive a DETERMINISTIC id from stable, signed payload fields
 *       (entry id, recipient id, sender id, the event's own timestamp and a
 *       SHA-256 of the text; the raw text is never stored in the id) so a
 *       redelivery maps to the same messages.wa_message_id and the existing
 *       de-dup / claim key apply. Without a valid event timestamp no
 *       deterministic id is possible (two identical texts of one sender would
 *       collide) -> null, and the caller keeps the old `ig_${Date.now()}`.
 *  (ii) such ids are NEVER provider ids: providerEventIdGenuine stays false
 *       (the durable engine refuses them, unchanged) and an unknown flow
 *       eligibility is recorded as immediately 'exhausted' (attempt cap 1,
 *       observable in automation_inbound_routing_retries) instead of a
 *       retryable 503 (index.ts keepRetryable).
 */
const SAFE=(v:unknown)=>typeof v==="string"&&v.length>0&&v.length<=256;

export async function syntheticEventId(p:{entryId:unknown;recipientId:unknown;senderId:unknown;
 timestamp:unknown;text:unknown}):Promise<string|null>{
 const ts=typeof p.timestamp==="number"?p.timestamp:typeof p.timestamp==="string"?Number(p.timestamp):NaN;
 if(!Number.isSafeInteger(ts)||ts<=0||!SAFE(p.senderId)||typeof p.text!=="string")return null;
 const material=JSON.stringify(["v1",SAFE(p.entryId)?p.entryId:"",SAFE(p.recipientId)?p.recipientId:"",
  p.senderId,ts,p.text]);
 try{
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(material));
  const hex=Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,"0")).join("");
  return "ig_syn_"+hex.slice(0,40);
 }catch{return null;}
}
