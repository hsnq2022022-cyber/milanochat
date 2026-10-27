/** Reproducible simulator-only selection; never used to route live messages. */
export function chooseWeightedPort(options:ReadonlyArray<{id:string;weight?:number}>,seed:number,step:number):string {
  if(!options.length)return "next";
  // Stable 32-bit integer mix, independent of Math.random and system time.
  let n=(Math.trunc(seed) ^ Math.imul((step+1)>>>0,0x9e3779b9))>>>0;
  n=Math.imul(n^(n>>>16),0x85ebca6b)>>>0;
  n=Math.imul(n^(n>>>13),0xc2b2ae35)>>>0;
  const roll=((n^(n>>>16))>>>0)/4294967296;
  const total=options.reduce((sum,item)=>sum+Math.max(0,item.weight||0),0);
  if(total<=0)return options[0].id;
  let cursor=roll*total;
  for(const item of options){
    cursor-=Math.max(0,item.weight||0);
    if(cursor<0)return item.id;
  }
  return options[options.length-1].id;
}

export const MAX_SIMULATOR_STEPS=150;

/** Preview input checks are local-only; live Meta execution needs a server validator. */
export function normalizeArabicDigits(value:string):string{
 return value.replace(/[٠-٩۰-۹]/g,char=>{
  const code=char.charCodeAt(0);
  return String(code>=0x6f0&&code<=0x6f9?code-0x6f0:code-0x660);
 });
}
export function validCustomerInput(mode:string,raw:string):boolean{
 const value=normalizeArabicDigits(raw.trim());
 if(!value)return false;
 if(mode==="email")return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(value);
 if(mode==="phone"){
  if(!/^\\+?[\\d\\s-]+$/.test(value))return false;
  const digits=value.replace(/\\D/g,"");
  return digits.length>=7&&digits.length<=15;
 }
 if(mode==="number")return /^[-+]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)$/.test(value)&&Number.isFinite(Number(value));
 return true;
}
