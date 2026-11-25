// PURE: server error classification for flow activation (no React, no Supabase client).

/** Server error: `message` is the server's error code text, `status` the HTTP status (0 = client side). */
export class ServiceError extends Error{
 /** `code` = the server's machine code (body.code), only when it is a plain UPPER_SNAKE token. */
 readonly code?:string;
 readonly status:number;
 constructor(message:string,status:number,code?:unknown){
  super(message);
  this.status=status;
  if(typeof code==="string"&&/^[A-Z][A-Z0-9_]{0,63}$/.test(code))this.code=code;
 }
}


/** Visible diagnostic code for support: server code text plus HTTP status. Never secrets. */
export function serviceErrorDetail(e:unknown):string{
 // A machine code is the diagnostic (never the long customer sentence that may travel in `error`).
 if(e instanceof ServiceError&&e.code)return e.code+(e.status?" · HTTP "+e.status:"");
 if(e instanceof ServiceError)return e.message.slice(0,160)+(e.status?" · HTTP "+e.status:"");
 if(e instanceof Error&&e.message)return e.message.slice(0,160);
 return "unknown";
}

type Verb="التفعيل"|"الإيقاف"|"التحديث";
const VERB_EN:Record<Verb,string>={"التفعيل":"Could not activate","الإيقاف":"Could not stop","التحديث":"Could not update"};

/** Map real server error codes to Arabic (or English); the raw code is always appended. */
export function activationErrorMessage(e:unknown,verb:Verb,en=false):string{
 const code=e instanceof ServiceError?e.message:"";
 const machine=e instanceof ServiceError?e.code:undefined;
 const status=e instanceof ServiceError?e.status:0;
 let ar="",eng="";
 if(code==="No published revision"){ar="لا يوجد إصدار منشور، انشر التدفق أولًا";eng="no published revision, publish the flow first";}
 else if(code==="This flow uses unsupported runtime features"){ar="الميزة غير مدعومة";eng="unsupported feature";}
 else if(code==="Publication activation is disabled"||code==="Global/tenant switch is OFF"||status===423)
  {ar="التفعيل غير مفعّل على حسابك بعد";eng="activation is not enabled for your account yet";}
 else if(code==="Account is paused"){ar="الحساب أو الرد التلقائي متوقف";eng="the account or auto reply is paused";}
 else if(code==="Account is disabled"||code==="Account not authorized"||code==="Tenant not authorized"||status===403)
  {ar="الحساب غير مصرّح له";eng="the account is not authorized";}
 else if(code==="Publication revision not found"||code==="No active publication found"||status===404)
  {ar="الإصدار غير موجود أو غير نشط";eng="revision not found or not active";}
 // Registry refusals are matched on the server's machine code BEFORE any status rule (409/503).
 else if(machine==="FLOW_DURABLE_REGISTRY_MISSING")
  {ar="حسابك غير مفعّل للمسارات المتقدمة بعد، تواصل مع الدعم";eng="advanced flows are not enabled for your account yet, contact support";}
 else if(machine==="FLOW_DURABLE_REGISTRY_OTHER_ACCOUNT")
  {ar="المسارات المتقدمة مفعّلة لحساب آخر لديك، ويُدعم حساب واحد فقط لكل منصة";eng="advanced flows are enabled for another of your accounts; only one account per platform is supported";}
 else if(machine==="FLOW_DURABLE_REGISTRY_UNAVAILABLE")
  {ar="تعذر التحقق من تفعيل الحساب الآن، أعد المحاولة بعد قليل";eng="could not verify the account activation right now, try again shortly";}
 else if(code==="Conflicting active revisions")
  {ar="يوجد أكثر من إصدار نشط على الحساب";eng="more than one active revision on the account";}
 // Any other 409 is NOT assumed to be the multiple-revisions conflict.
 else if(status===409)
  {ar="تعذر إتمام العملية بسبب تعارض في حالة الحساب";eng="the operation conflicts with the account state";}
 else if(code==="Not authenticated"||status===401){ar="سجّل الدخول ثم أعد المحاولة";eng="sign in and try again";}
 else if(code==="Rate limit exceeded"||status===429){ar="محاولات كثيرة، أعد المحاولة بعد قليل";eng="too many attempts, try again shortly";}
 else if(status===503||status===0&&code==="unavailable"){ar="الخدمة غير متاحة مؤقتًا";eng="service temporarily unavailable";}
 const detail=serviceErrorDetail(e);
 if(en)return VERB_EN[verb]+(eng?": "+eng:"")+" (code: "+detail+")";
 return "تعذر "+verb+(ar?": "+ar:"")+" (رمز: "+detail+")";
}

