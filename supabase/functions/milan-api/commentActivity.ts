/**
 * SERVER ONLY. Read contract of the Inbox comment-activity view
 * (milan-api claim action "comment_activity").
 *
 * Request body: { tenantId, limit?: 1..100 (default 50), cursor?: string|null }
 * Response 200: {
 *   ok: true,
 *   items: [{ id, customerName, commentText, createdAt,
 *             publicReplyStatus: 'pending'|'sent'|'failed',
 *             publicReplyText,
 *             dmStatus: 'pending'|'sent'|'failed'|'skipped' }],
 *   nextCursor: string|null      // opaque; pass back as `cursor`
 * }
 * Errors: { ok:false, error:<code> } with 400 (invalid_cursor / invalid_limit)
 * or 503 (unavailable). Never includes comment text, SQL messages or ids of
 * other tenants. Every query is keyed by the claim-verified tenant id; the
 * comment text is decrypted server-side only for that tenant's rows.
 */
import type {SupabaseClient} from "npm:@supabase/supabase-js@2";

type Db=Pick<SupabaseClient,"from">;
type Rec=Record<string,unknown>;
export const COMMENT_ACTIVITY_MAX=100;
export const COMMENT_ACTIVITY_DEFAULT=50;
export type CommentActivityItem={
 id:string;customerName:string|null;commentText:string|null;createdAt:string;
 publicReplyStatus:"pending"|"sent"|"failed";publicReplyText:string;
 dmStatus:"pending"|"sent"|"failed"|"skipped";
};
export type CommentActivityResult=
 {ok:true;items:CommentActivityItem[];nextCursor:string|null}|
 {ok:false;error:"invalid_cursor"|"invalid_limit"|"unavailable";status:400|503};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
/** Internal states 'attempting'/'uncertain' are still pending for the Inbox. */
export const publicReplyStatusOf=(s:unknown):"pending"|"sent"|"failed"=>
 s==="sent"?"sent":s==="failed"?"failed":"pending";
const dmStatusOf=(s:unknown):CommentActivityItem["dmStatus"]=>
 s==="sent"||s==="failed"||s==="skipped"?s:"pending";
export const encodeCursor=(createdAt:string,id:string)=>
 btoa(JSON.stringify([createdAt,id])).replace(/=+$/,"");
/** Strict cursor decode: only [ISO timestamp, uuid]; anything else is refused. */
export function decodeCursor(raw:unknown):{createdAt:string;id:string}|null|"invalid"{
 if(raw===undefined||raw===null||raw==="")return null;
 if(typeof raw!=="string"||raw.length>200||!/^[A-Za-z0-9+/]+$/.test(raw))return "invalid";
 try{
  const v=JSON.parse(atob(raw+"=".repeat((4-raw.length%4)%4)));
  if(Array.isArray(v)&&v.length===2&&typeof v[0]==="string"&&ISO.test(v[0])&&
     typeof v[1]==="string"&&UUID.test(v[1]))return {createdAt:v[0],id:v[1]};
 }catch{/* invalid */}
 return "invalid";
}
export async function readCommentActivity(db:Db,tenantId:string,
 input:{limit?:unknown;cursor?:unknown},decrypt:(enc:string)=>Promise<string>):Promise<CommentActivityResult>{
 if(!UUID.test(tenantId))return {ok:false,error:"unavailable",status:503};
 const limit=input.limit===undefined||input.limit===null?COMMENT_ACTIVITY_DEFAULT:input.limit;
 if(typeof limit!=="number"||!Number.isSafeInteger(limit)||limit<1||limit>COMMENT_ACTIVITY_MAX)
  return {ok:false,error:"invalid_limit",status:400};
 const cursor=decodeCursor(input.cursor);
 if(cursor==="invalid")return {ok:false,error:"invalid_cursor",status:400};
 let q=db.from("automation_comment_replies")
  .select("id,tenant_id,from_name,comment_text_encrypted,created_at,reply_status,public_reply_text,dm_status")
  .eq("tenant_id",tenantId);
 // Validated values only (ISO timestamp + uuid): no filter injection.
 if(cursor)q=q.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
 const {data,error}=await q.order("created_at",{ascending:false}).order("id",{ascending:false}).limit(limit+1);
 if(error||!Array.isArray(data)){
  console.error("[comment_activity] read failed",{code:error?.code??"shape"});
  return {ok:false,error:"unavailable",status:503};
 }
 const rows=(data as Rec[]).filter(r=>r&&r.tenant_id===tenantId);
 const page=rows.slice(0,limit);
 const items:CommentActivityItem[]=[];
 for(const r of page){
  let commentText:string|null=null;
  try{
   commentText=typeof r.comment_text_encrypted==="string"?await decrypt(r.comment_text_encrypted):null;
  }catch{commentText=null;}
  items.push({id:String(r.id),customerName:typeof r.from_name==="string"?r.from_name:null,commentText,
   createdAt:String(r.created_at),publicReplyStatus:publicReplyStatusOf(r.reply_status),
   publicReplyText:typeof r.public_reply_text==="string"?r.public_reply_text:"",
   dmStatus:dmStatusOf(r.dm_status)});
 }
 const last=page[page.length-1];
 return {ok:true,items,nextCursor:rows.length>limit&&last?encodeCursor(String(last.created_at),String(last.id)):null};
}
