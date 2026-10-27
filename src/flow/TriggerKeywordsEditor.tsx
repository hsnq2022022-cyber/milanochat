import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import type { TriggerMode } from "./model";

const inputClass="min-w-0 flex-1 rounded-xl border border-[#275443] bg-[#0F2E24] px-3 py-2.5 text-sm text-white outline-none focus:border-[#3DD189]";

/** Chip editor backed by the existing comma-separated keywords string; no persisted schema changes. */
export default function TriggerKeywordsEditor({mode,value,onChange}:{
  mode:TriggerMode;value:string;onChange:(value:string)=>void
}){
  const [draft,setDraft]=useState("");
  const [commentFilter,setCommentFilter]=useState(!!value.trim());
  useEffect(()=>{setDraft("");setCommentFilter(!!value.trim());},[mode]);
  if(mode!=="keyword"&&mode!=="comment")return null;
  const entries=value.split(/[,،\n]+/).map(x=>x.trim()).filter(Boolean);
  const words=[...new Set(entries)];
  const update=(next:string[])=>onChange(next.join(", "));
  const add=()=>{
    const next=draft.split(/[,،\n]+/).map(x=>x.trim()).filter(Boolean);
    if(next.length===0)return;
    update([...new Set([...words,...next])].slice(0,30));
    setDraft("");
  };
  return <section className="mt-4 rounded-xl border border-[#275443] bg-[#061A14]/60 p-3" data-testid="trigger-keyword-settings">
    {mode==="comment"&&<label className="mb-2 flex cursor-pointer items-center gap-3 text-xs font-semibold">
      <input type="checkbox" aria-label="تحديد كلمات للتعليقات" checked={commentFilter} onChange={e=>{
        setCommentFilter(e.target.checked);
        if(!e.target.checked)onChange("");
      }} className="h-4 w-4 accent-[#3DD189]"/>
      تفعيل كلمات مفتاحية للتعليقات
    </label>}
    {(mode==="keyword"||commentFilter)&&<>
      <label className="mb-2 block text-xs font-semibold text-[#B8D0C3]">الكلمات المفتاحية</label>
      <p className="mb-2 text-[11px] leading-5 text-[#8B9E96]">اكتب الكلمة واضغط Enter أو «إضافة». تظهر الكلمات المحفوظة أدناه.</p>
      <div className="flex items-center gap-2">
        <input className={inputClass} aria-label="إدخال كلمة مفتاحية" value={draft} maxLength={120}
          onChange={e=>setDraft(e.target.value)} onBlur={add}
          onKeyDown={e=>{if(e.key==="Enter"||e.key===","||e.key==="،"){e.preventDefault();add();}}}
          placeholder={mode==="comment"?"مثال: السعر، اشتراك":"مثال: أسعار، TOD"}/>
        <button type="button" aria-label="حفظ الكلمة المفتاحية" onMouseDown={e=>e.preventDefault()} onClick={add}
          className="inline-flex shrink-0 items-center gap-1 rounded-xl bg-[#3DD189] px-3 py-2.5 text-xs font-bold text-[#061A14]">
          <Plus size={15}/> إضافة
        </button>
      </div>
      <div className="mt-3 flex min-h-9 flex-wrap gap-2" data-testid="saved-keywords">
        {words.length?words.map((word,index)=><span key={word} className="inline-flex items-center gap-1 rounded-full border border-[#3DD189]/50 bg-[#173D30] px-3 py-1.5 text-xs text-[#BCF8D7]">
          {word}
          <button type="button" aria-label={"حذف الكلمة "+word} onClick={()=>update(words.filter((_,i)=>i!==index))} className="rounded-full p-0.5 hover:bg-[#275443]"><X size={12}/></button>
        </span>):<span className="text-[11px] text-[#8B9E96]">لم تُضف كلمات بعد</span>}
      </div>
      {mode==="keyword"&&!words.length&&<p className="mt-2 text-[11px] text-[#E5B54B]">أضف كلمة واحدة على الأقل لتحديد الرسائل المطابقة.</p>}
    </>}
    {mode==="comment"&&!commentFilter&&<p className="text-[11px] text-[#8B9E96]">سيُطبَّق الحدث على أي تعليق؛ فعّل الخيار لتحديد كلمات فقط.</p>}
  </section>;
}
