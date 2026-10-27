import { useEffect, useState } from "react";
import type { ReactNode } from "react";

/** Expired Meta CDN avatars are common. Never leave a broken image in the UI. */
export default function SafeAvatar({src,className,fallback}:{src:string|null|undefined;className:string;fallback:ReactNode}){
  const [failed,setFailed]=useState(false);
  useEffect(()=>{setFailed(false);},[src]);
  if(!src||failed)return <>{fallback}</>;
  return <img src={src} alt="" className={className} referrerPolicy="no-referrer" loading="lazy" onError={()=>setFailed(true)}/>;
}
