/** Supabase-js resolves PostgREST insert errors as {error}, not as thrown exceptions.
 * A duplicate inbound message must never trigger another automatic reply.
 */
export type InboundInsertDisposition="stored"|"duplicate"|"failed";
export function inboundInsertDisposition(error:{code?:string;message?:string}|null|undefined):InboundInsertDisposition {
  if(!error)return "stored";
  if(error.code==="23505")return "duplicate";
  return "failed";
}
