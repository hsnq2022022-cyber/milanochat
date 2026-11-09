/**
 * SERVER ONLY. Validation/normalization of a typed customer answer to a
 * durable text/email/phone question. Pure: no IO, never logs its input.
 * null = invalid (the caller re-asks); a string = the value to store.
 */
import {normalizeArabicDigits} from "../../../src/flow/simulation.ts";

/** Inbound bound: longer webhook texts are never inspected or stored. */
export const MAX_INBOUND_ANSWER_CHARS=1000;
/** Stored bound for free-text answers (same as set_field values). */
export const MAX_TEXT_ANSWER_CHARS=500;
export const MAX_EMAIL_CHARS=254;
export type DurableAnswerMode="text"|"email"|"phone";
export const durableAnswerMode=(m:unknown):m is DurableAnswerMode=>
 m==="text"||m==="email"||m==="phone";

// C0/C1 controls (tab/newline are folded to a space first) and bidi
// embedding/override/isolate controls, which can disguise displayed text.
const CONTROL=/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const EMAIL_LOCAL=/^[a-z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+\/=?^_`{|}~-]+)*$/;
const EMAIL_LABEL=/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function text(raw:string):string|null{
 const v=raw.replace(/[\t\r\n]+/g," ").trim();
 if(!v||CONTROL.test(v)||v.length>MAX_TEXT_ANSWER_CHARS)return null;
 return v;
}
/** Pragmatic RFC 5321/5322 subset: ASCII dot-atom local part, DNS host, alpha TLD. */
function email(raw:string):string|null{
 const v=raw.trim().toLowerCase();
 if(!v||v.length>MAX_EMAIL_CHARS||CONTROL.test(v))return null;
 const at=v.lastIndexOf("@");
 if(at<1||v.indexOf("@")!==at)return null;
 const local=v.slice(0,at),domain=v.slice(at+1);
 if(local.length>64||!EMAIL_LOCAL.test(local))return null;
 const labels=domain.split(".");
 if(domain.length>253||labels.length<2||!labels.every(l=>EMAIL_LABEL.test(l))||
    !/^[a-z]{2,63}$/.test(labels[labels.length-1]))return null;
 return v;
}
/**
 * Digits (Arabic-Indic accepted) with an optional leading + (or 00) and the
 * separators space - . ( ). Canonical form: "+" when given, then digits only.
 */
function phone(raw:string):string|null{
 const v=normalizeArabicDigits(raw.trim());
 if(!v||v.length>40||!/^\+?[0-9 ().-]+$/.test(v))return null;
 let digits=v.replace(/\D/g,"");
 let plus=v.startsWith("+");
 if(!plus&&digits.startsWith("00")){plus=true;digits=digits.slice(2);}
 if(digits.length<7||digits.length>15)return null;
 return (plus?"+":"")+digits;
}
export function normalizeDurableAnswer(mode:DurableAnswerMode,raw:unknown):string|null{
 if(typeof raw!=="string"||raw.length>MAX_INBOUND_ANSWER_CHARS)return null;
 return mode==="email"?email(raw):mode==="phone"?phone(raw):text(raw);
}

/** Default re-ask (the node model has no invalid-answer message field). */
const REASK={
 ar:{text:"لم نتمكن من قراءة الإجابة، يرجى كتابتها مرة أخرى.",
  email:"يرجى إرسال بريد إلكتروني صحيح، مثل name@example.com",
  phone:"يرجى إرسال رقم هاتف صحيح (من 7 إلى 15 رقمًا)."},
 en:{text:"We could not read that answer, please type it again.",
  email:"Please send a valid email address, e.g. name@example.com",
  phone:"Please send a valid phone number (7 to 15 digits)."}
} as const;
/**
 * Arabic by default (project convention); English only when the question
 * itself is written in Latin script without any Arabic letter. The question
 * is repeated when the result stays within Instagram's 1000-byte text limit.
 */
export function reaskText(mode:DurableAnswerMode,question:string):string{
 const en=/[A-Za-z]/.test(question)&&!/[\u0600-\u06ff\u0750-\u077f]/.test(question);
 const line=REASK[en?"en":"ar"][mode];
 const q=question.trim();
 const both=q?line+"\n"+q:line;
 return new TextEncoder().encode(both).byteLength<=1000?both:line;
}
