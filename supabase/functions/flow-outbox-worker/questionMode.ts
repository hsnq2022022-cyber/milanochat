/**
 * Durable text/email/phone questions (Instagram only) are sent as a plain
 * text message: the customer types the answer, so there are no quick
 * replies and the rich-buttons flag is not involved. Every other question
 * keeps the existing button-only rules; unknown modes stay blocked.
 */
export const PLAIN_QUESTION_MODES=["text","email","phone"] as const;
const emptyList=(v:unknown)=>v===undefined||(Array.isArray(v)&&v.length===0);
export function plainInputQuestion(payload:unknown,platform:unknown):boolean{
 if(!payload||typeof payload!=="object"||Array.isArray(payload))return false;
 const p=payload as Record<string,unknown>;
 return platform==="instagram"&&p.kind==="question"&&
  (PLAIN_QUESTION_MODES as readonly unknown[]).includes(p.inputMode)&&
  emptyList(p.choices)&&emptyList(p.choiceIds);
}
