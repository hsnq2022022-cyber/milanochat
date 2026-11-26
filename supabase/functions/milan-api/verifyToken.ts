/**
 * Meta webhook GET handshake: compares the presented hub.verify_token with the
 * configured one in constant time (reuses constantTimeEqual from PR #212).
 * Same semantics as the former `expected && token === expected`: a missing
 * token or an empty/missing configured token never matches. Pure: no IO, no logging.
 */
import {constantTimeEqual} from "../flowWorkerAuth.ts";

export function verifyTokenMatches(presented:string|null|undefined,expected:string|null|undefined):boolean{
  if(typeof expected!=="string"||expected.length===0)return false;
  if(typeof presented!=="string")return false;
  return constantTimeEqual(presented,expected);
}
