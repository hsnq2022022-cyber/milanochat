/** Server-owned Wayl top-up contract. Client must never set IQD amount/credits. */
export const WAYL_PACKAGES = Object.freeze({
  starter: Object.freeze({amountIQD:35000,credits:1000,label:"شحن 1,000 رد"}),
  growth: Object.freeze({amountIQD:85000,credits:3000,label:"شحن 3,000 رد"}),
  scale: Object.freeze({amountIQD:225000,credits:10000,label:"شحن 10,000 رد"}),
});
export type PackageId = keyof typeof WAYL_PACKAGES;
export function selectTopupPackage(value:unknown) {
  if(typeof value!=="string" || !Object.prototype.hasOwnProperty.call(WAYL_PACKAGES,value)) return null;
  return WAYL_PACKAGES[value as PackageId];
}
export function validWaylCheckoutLink(value:unknown):value is string{
  if(typeof value!=="string" || value.length>2048)return false;
  try{
    const url=new URL(value);
    return url.protocol==="https:"&&url.hostname==="checkout.thewayl.com"&&
      url.username===""&&url.password===""&&url.port===""&&url.pathname!=="/";
  }catch{return false;}
}
export function serverReturnUrl(value:unknown):string|null{
  if(typeof value!=="string" || value.length>1024)return null;
  try{
    const url=new URL(value);
    if(url.protocol!=="https:"||url.username||url.password||url.hash)return null;
    return url.toString();
  }catch{return null;}
}
export function makeLinkPayload(input:{
  id:string;amountIQD:number;label:string;env:"test"|"live";
  webhookUrl:string;webhookSecret:string;redirectUrl:string;
}){
  return {
    env:input.env,referenceId:input.id,total:input.amountIQD,
    currency:"IQD",customParameter:"",
    lineItem:[{label:input.label,amount:input.amountIQD,type:"increase" as const}],
    webhookUrl:input.webhookUrl,webhookSecret:input.webhookSecret,
    redirectionUrl:input.redirectUrl
  };
}
