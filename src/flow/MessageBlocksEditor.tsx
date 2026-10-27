import { useState } from "react";
import { Trash2, ArrowUp, ArrowDown, Type, Image as ImageIcon, FileText, Clock3, ClipboardList } from "lucide-react";
import type { ContentBlock, FlowNode } from "./model";
import { useFlowStore } from "./store";

const types: Array<{id:ContentBlock["type"];label:string;note:string;icon:typeof Type}>=[
  {id:"text",label:"نص",note:"رسالة نصية إضافية",icon:Type},
  {id:"image",label:"صورة",note:"صورة داخل التسلسل",icon:ImageIcon},
  {id:"pdf",label:"PDF",note:"ملف PDF أو رابط مباشر",icon:FileText},
  {id:"delay",label:"انتظار",note:"فاصل زمني بين المحتويات",icon:Clock3},
  {id:"collection",label:"جمع بيانات",note:"اسم العميل، البريد أو الهاتف",icon:ClipboardList}
];
const input="w-full rounded-xl border border-[#275443] bg-[#0F2E24] px-3 py-2.5 text-sm text-white outline-none focus:border-[#3DD189]";
const btn="inline-flex items-center gap-1.5 rounded-xl border border-[#275443] px-3 py-2 text-xs hover:bg-[#173D30]";

export default function MessageBlocksEditor({node}:{node:FlowNode}){
  const store=useFlowStore();
  const blocks=node.data.contentBlocks||[];
  const [status,setStatus]=useState("");
  const edit=(items:ContentBlock[])=>store.changeNode(node.id,{contentBlocks:items});
  const patch=(id:string,part:Partial<ContentBlock>)=>edit(blocks.map(b=>b.id===id?{...b,...part}:b));
  const add=(type:ContentBlock["type"])=>{
    if(blocks.length>=24){setStatus("الحد الأقصى 24 مكوّنًا في الرسالة.");return;}
    edit([...blocks,{id:crypto.randomUUID(),type,text:type==="text"?"اكتب نصًا إضافيًا":type==="collection"?"اكتب بياناتك هنا":"",url:"",seconds:3,field:"response",inputMode:"text"}]);
  };
  const reorder=(index:number,dir:-1|1)=>{
    const i=index+dir;if(i<0||i>=blocks.length)return;
    const next=[...blocks];[next[index],next[i]]=[next[i],next[index]];edit(next);
  };
  const upload=async(block:ContentBlock,file?:File)=>{
    if(!file)return;
    if(block.type==="pdf"){
      if(file.type!=="application/pdf"||file.size>350000){setStatus("ملف PDF المحلي يجب ألا يتجاوز 350KB. للملفات الأكبر استخدم رابط HTTPS.");return;}
      const reader=new FileReader();
      reader.onload=()=>{const url=String(reader.result||"");if(url.startsWith("data:application/pdf;base64,")){patch(block.id,{url});setStatus("حُفظ PDF داخل المسودة المحلية.");}};
      reader.onerror=()=>setStatus("تعذر قراءة ملف PDF.");
      reader.readAsDataURL(file);
      return;
    }
    if(!["image/jpeg","image/png","image/webp"].includes(file.type)||file.size>5*1024*1024){setStatus("اختر JPG أو PNG أو WebP بحجم أقصى 5MB.");return;}
    const url=URL.createObjectURL(file);
    try{
      const image=new Image();
      await new Promise<void>((resolve,reject)=>{image.onload=()=>resolve();image.onerror=()=>reject(new Error());image.src=url;});
      const size=Math.min(1,1000/Math.max(image.naturalWidth,image.naturalHeight));
      const canvas=document.createElement("canvas");canvas.width=Math.max(1,Math.round(image.naturalWidth*size));canvas.height=Math.max(1,Math.round(image.naturalHeight*size));
      const ctx=canvas.getContext("2d");if(!ctx)throw new Error();
      ctx.drawImage(image,0,0,canvas.width,canvas.height);
      const output=canvas.toDataURL("image/webp",.68);
      if(output.length>700000){setStatus("الصورة كبيرة بعد الضغط، اختر صورة أصغر.");return;}
      patch(block.id,{url:output});setStatus("أُضيفت الصورة بنجاح إلى الرسالة.");
    }catch{setStatus("لم نتمكن من معالجة هذه الصورة.");}finally{URL.revokeObjectURL(url);}
  };
  return <section className="mt-5 rounded-2xl border border-[#275443] bg-[#061A14]/50 p-3" dir="rtl">
    <div className="mb-1 flex items-center justify-between gap-2"><h3 className="text-sm font-bold">محتويات الرسالة</h3><span className="text-[11px] text-[#8B9E96]">{blocks.length} / 24</span></div>
    <p className="mb-3 text-[11px] text-[#8B9E96]">النص والصور والمرفقات في مكان واحد. اختر المكوّن مباشرة من القائمة الظاهرة بالأسفل.</p>
    <div className="mb-3 rounded-xl border border-[#275443] bg-[#0F2E24] p-3" data-testid="primary-message-content">
      <label className="mb-2 block text-xs font-bold text-white">النص الأساسي</label>
      <textarea className={input} rows={4} maxLength={2000} aria-label="نص الرسالة" placeholder="اكتب الرسالة التي ستظهر للعميل"
        value={node.data.text} onChange={e=>store.changeNode(node.id,{text:e.target.value})}/>
      <div className="mt-2 flex items-center justify-between gap-2">
        <button type="button" className={btn} onClick={()=>store.changeNode(node.id,{text:node.data.text+" {{first_name}}"})}>+ اسم العميل</button>
        <span className="text-[11px] text-[#8B9E96]" dir="ltr">{node.data.text.length}/2000</span>
      </div>
    </div>
    {!!node.data.image&&<div className="mb-3 rounded-xl border border-[#275443] bg-[#0F2E24] p-3" data-testid="legacy-message-image">
      <div className="mb-2 flex items-center gap-2"><ImageIcon size={16} className="text-[#3DD189]"/><span className="flex-1 text-xs font-bold">صورة محفوظة سابقًا</span>
        <button type="button" aria-label="إزالة الصورة المحفوظة" className="text-red-300" onClick={()=>store.changeNode(node.id,{image:""})}><Trash2 size={15}/></button>
      </div>
      <img className="max-h-40 w-full rounded-lg object-contain" alt="الصورة المحفوظة" src={node.data.image}/>
      <p className="mt-2 text-[11px] text-[#8B9E96]">احتفظنا بالصورة القديمة في مكانها الأصلي داخل البيانات؛ يمكنك حذفها أو إضافة صور جديدة عبر المكونات أدناه.</p>
    </div>}
    <div className="space-y-3">
      {blocks.map((block,i)=>{
        const def=types.find(t=>t.id===block.type)!;const Icon=def.icon;
        return <div key={block.id} className="rounded-xl border border-[#275443] bg-[#0F2E24] p-3" data-testid={"content-block-"+block.type}>
          <header className="mb-2 flex items-center gap-2"><Icon size={16} className="text-[#3DD189]"/><span className="flex-1 text-xs font-bold">{def.label}</span>
            <button aria-label="نقل للأعلى" title="نقل للأعلى" disabled={i===0} onClick={()=>reorder(i,-1)}><ArrowUp size={15}/></button>
            <button aria-label="نقل للأسفل" title="نقل للأسفل" disabled={i===blocks.length-1} onClick={()=>reorder(i,1)}><ArrowDown size={15}/></button>
            <button aria-label="حذف المكوّن" className="text-red-300" onClick={()=>edit(blocks.filter(x=>x.id!==block.id))}><Trash2 size={15}/></button>
          </header>
          {block.type==="text"&&<textarea className={input} rows={3} maxLength={2000} aria-label="نص المكوّن" value={block.text||""} onChange={e=>patch(block.id,{text:e.target.value})}/>}
          {block.type==="image"&&<>
            <input className={input} dir="ltr" aria-label="رابط صورة المكوّن" placeholder="https://example.com/image.jpg" value={block.url?.startsWith("data:")?"":block.url||""} onChange={e=>patch(block.id,{url:e.target.value})}/>
            <label className={btn+" mt-2 cursor-pointer"}><ImageIcon size={15}/> اختر صورة من الجهاز<input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={e=>{void upload(block,e.target.files?.[0]);e.target.value="";}}/></label>
            {!!block.url&&<img alt="معاينة المكوّن" src={block.url} className="mt-2 max-h-40 w-full rounded-lg object-contain"/>}
          </>}
          {block.type==="pdf"&&<>
            <input className={input} dir="ltr" aria-label="رابط PDF" placeholder="https://example.com/document.pdf" value={block.url?.startsWith("data:")?"":block.url||""} onChange={e=>patch(block.id,{url:e.target.value})}/>
            <label className={btn+" mt-2 cursor-pointer"}><FileText size={15}/> رفع PDF صغير<input type="file" accept="application/pdf,.pdf" className="hidden" onChange={e=>{void upload(block,e.target.files?.[0]);e.target.value="";}}/></label>
            {!!block.url&&<p className="mt-2 text-xs text-[#3DD189]">ملف PDF مُضاف إلى المسودة</p>}
          </>}
          {block.type==="delay"&&<div className="flex items-center gap-2"><input type="number" min={1} max={3600} className={input} aria-label="فاصل الانتظار بالثواني" value={block.seconds||3} onChange={e=>patch(block.id,{seconds:Math.max(1,Math.min(3600,Number(e.target.value)||1))})}/><span className="shrink-0 text-xs text-[#8B9E96]">ثانية</span></div>}
          {block.type==="collection"&&<>
            <input className={input} aria-label="سؤال جمع البيانات" placeholder="اكتب رقم هاتفك" value={block.text||""} onChange={e=>patch(block.id,{text:e.target.value})}/>
            <label className="mb-1 mt-2 block text-xs">نوع البيانات</label>
            <select aria-label="نوع البيانات" className={input} value={block.inputMode||"text"} onChange={e=>patch(block.id,{inputMode:e.target.value as ContentBlock["inputMode"]})}>
              <option value="text">نص</option><option value="email">بريد إلكتروني</option><option value="phone">هاتف</option><option value="number">رقم</option>
            </select>
            <label className="mb-1 mt-2 block text-xs">اسم المتغير</label>
            <input className={input} aria-label="متغير جمع البيانات" value={block.field||""} onChange={e=>patch(block.id,{field:e.target.value})}/>
          </>}
        </div>;
      })}
    </div>
    <div className="mt-2 grid grid-cols-2 gap-2" data-testid="content-block-menu">{types.map(t=><button key={t.id} className="flex min-h-14 items-center gap-2 rounded-xl border border-[#275443] bg-[#0F2E24] p-2 text-right transition-colors hover:border-[#3DD189] hover:bg-[#173D30]" onClick={()=>add(t.id)}>
      <t.icon size={17} className="text-[#3DD189]"/><span><span className="block text-xs font-bold">{t.label}</span><span className="text-[11px] text-[#8B9E96]">{t.note}</span></span>
    </button>)}</div>
    {!!status&&<p role="status" className="mt-3 text-xs text-[#3DD189]">{status}</p>}
    <p className="mt-3 text-[11px] text-[#8B9E96]">المرفقات والمعلومات موجودة في المسودة المحلية فقط؛ دعم إرسال الصور وPDF يعتمد على القناة وصلاحيات Meta بعد تفعيل الخادم.</p>
  </section>;
}
