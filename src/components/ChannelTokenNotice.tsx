import {channelTokenNotice,channelTokenState} from "../lib/channelTokenState";

type Props={status?:string|null;tokenExpiresAt?:string|null;reason?:string|null;onReconnect:()=>void;now?:number};

/** Expiry / reauthorization notice for one channel account, with a visible reconnect action. Renders nothing when healthy. */
export default function ChannelTokenNotice({status,tokenExpiresAt,reason,onReconnect,now}:Props){
 const info=channelTokenState({status,tokenExpiresAt},now??Date.now());
 const notice=channelTokenNotice(info,reason);
 if(!notice)return null;
 const err=notice.severity==="error";
 return (
  <div role={err?"alert":"status"} data-testid="channel-token-notice" data-state={info.state}
   className={`mt-1.5 flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[10.5px] leading-4 ${err?"border-red-400/40 bg-red-500/10 text-red-300":"border-amber-400/40 bg-amber-500/10 text-amber-200"}`}>
   <span className="flex-1">{notice.text}</span>
   <button type="button" onClick={onReconnect} data-testid="channel-token-reconnect" className="shrink-0 font-bold text-oro hover:text-bone">إعادة الربط</button>
  </div>
 );
}
