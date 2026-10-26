import { useMemo, useState } from "react";
import { ArrowLeft, Plus, Trash2, Download, Upload, MessageSquare, GitBranch, Play, Save } from "lucide-react";

type Step = { id: string; type: "message" | "question" | "end"; text: string; options: string[] };
const STORE = "social_flow_builder_draft_v1";
const initial: Step[] = [
  { id: "start", type: "message", text: "أهلاً بيك! شلون نكدر نساعدك؟", options: [] },
  { id: "choice", type: "question", text: "اختار شتحتاج", options: ["الأسعار", "التواصل مع موظف"] },
  { id: "finish", type: "end", text: "", options: [] }
];
function load(): Step[] {
  try {
    const raw = localStorage.getItem(STORE);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed) && parsed.length && parsed.every((v) =>
      v && typeof v.id === "string" && ["message","question","end"].includes(v.type)
      && typeof v.text === "string" && Array.isArray(v.options))) return parsed as Step[];
  } catch { /* Ignore invalid local draft. */ }
  return initial;
}
export default function FlowBuilder() {
  const [steps, setSteps] = useState<Step[]>(load);
  const [selected, setSelected] = useState("start");
  const [preview, setPreview] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [answer, setAnswer] = useState("");
  const [notice, setNotice] = useState("");
  const current = steps.find(s => s.id === selected) ?? steps[0];
  const active = steps[cursor];
  const valid = useMemo(() => steps.length > 0 && steps.every(s => s.type === "end" || s.text.trim().length > 0) && steps.every(s => s.type !== "question" || s.options.some(x => x.trim())), [steps]);
  const patch = (id: string, update: Partial<Step>) => setSteps(old => old.map(s => s.id === id ? {...s,...update} : s));
  const add = (type: Step["type"]) => {
    const id = crypto.randomUUID();
    setSteps(old => [...old, {id,type,text:type==="end"?"":"اكتب الرسالة هنا",options:type==="question"?["الخيار الأول"]:[]}]);
    setSelected(id);
  };
  const save = () => { localStorage.setItem(STORE, JSON.stringify(steps)); setNotice("انحفظت المسودة على هذا الجهاز فقط"); };
  const download = () => {
    const blob = new Blob([JSON.stringify({version:1,steps},null,2)],{type:"application/json"});
    const url = URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.download="social-flow-draft.json"; a.click(); URL.revokeObjectURL(url);
  };
  const importFile = async (file?: File) => {
    if (!file || file.size > 100000) return;
    try {
      const data: unknown = JSON.parse(await file.text());
      if (!data || typeof data!=="object" || !("steps" in data) || !Array.isArray(data.steps) || !data.steps.length || data.steps.length>100 ||
        !data.steps.every((s: unknown) => !!s && typeof s==="object" && "id" in s && typeof s.id==="string" && "type" in s && ["message","question","end"].includes(String(s.type)) && "text" in s && typeof s.text==="string" && "options" in s && Array.isArray(s.options) && s.options.every((o:unknown)=>typeof o==="string"))) throw new Error();
      const next = data.steps as Step[]; setSteps(next);setSelected(next[0].id);setNotice("تم استيراد المسودة — احفظها للاحتفاظ بها");
    } catch {setNotice("ملف غير صالح");}
  };
  const btn="rounded-xl border border-[#275443] px-3 py-2 hover:bg-[#173D30] transition-colors";
  return <div dir="rtl" className="min-h-screen bg-[#061A14] text-white p-4 md:p-8" style={{fontFamily:"system-ui"}}>
    <div className="max-w-6xl mx-auto">
      <header className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div><a href="#/dashboard" className="inline-flex items-center gap-1 text-[#8B9E96] text-sm mb-2"><ArrowLeft size={16}/> الرجوع للوحة التحكم</a><h1 className="text-2xl font-bold">مصمم التدفقات</h1><p className="text-[#8B9E96] text-sm mt-1">محرر تجريبي يعمل داخل المتصفح — لا يرسل رسائل للعملاء حتى الآن</p></div>
        <div className="flex flex-wrap gap-2"><button className={btn} onClick={()=>setPreview(!preview)}><Play size={15} className="inline ml-1"/> {preview?"إغلاق التجربة":"تجربة التدفق"}</button><button className={btn} onClick={download}><Download size={15} className="inline ml-1"/> تصدير</button><label className={btn+" cursor-pointer"}><Upload size={15} className="inline ml-1"/> استيراد<input type="file" accept=".json,application/json" className="hidden" onChange={e=>{void importFile(e.target.files?.[0]);e.target.value="";}}/></label><button className="rounded-xl bg-[#3DD189] text-[#061A14] px-4 py-2 font-bold" onClick={save}><Save size={15} className="inline ml-1"/> حفظ المسودة</button></div>
      </header>
      {notice && <p role="status" className="mb-4 text-[#3DD189]">{notice}</p>}
      <div className="grid md:grid-cols-[1fr_1fr] gap-4">
        <section className="rounded-2xl border border-[#173D30] bg-[#0B241C] p-4">
          <h2 className="font-bold mb-4">خطوات المحادثة <span className="text-[#8B9E96] text-sm">({steps.length})</span></h2>
          <div className="space-y-3">{steps.map((step,i)=><button key={step.id} onClick={()=>setSelected(step.id)} className={"w-full text-right rounded-xl border p-4 transition-colors "+(selected===step.id?"border-[#3DD189] bg-[#173D30]":"border-[#173D30] bg-[#0F2E24]")}>
            <span className="text-xs text-[#3DD189]">{i+1} · {step.type==="message"?"رسالة":step.type==="question"?"سؤال وخيارات":"نهاية"}</span><p className="mt-1 truncate">{step.type==="end"?"إنهاء التدفق":step.text}</p>
          </button>)}</div>
          <div className="flex flex-wrap gap-2 mt-4"><button className={btn} onClick={()=>add("message")}><Plus size={14} className="inline"/> رسالة</button><button className={btn} onClick={()=>add("question")}><GitBranch size={14} className="inline"/> سؤال</button><button className={btn} onClick={()=>add("end")}><Plus size={14} className="inline"/> نهاية</button></div>
        </section>
        <section className="rounded-2xl border border-[#173D30] bg-[#0B241C] p-4">
          {preview ? <><h2 className="font-bold mb-4">تجربة المحادثة</h2><div className="rounded-xl bg-[#0F2E24] min-h-56 p-4"><div className="bg-[#173D30] rounded-xl p-3 mb-3">{active?.type==="end"?"انتهت المحادثة":active?.text??"انتهت المحادثة"}</div>{active?.type==="question" && <div className="flex flex-wrap gap-2">{active.options.filter(Boolean).map((o,i)=><button className={btn} key={i} onClick={()=>{setAnswer(o);setCursor(x=>Math.min(x+1,steps.length-1));}}>{o}</button>)}</div>}{answer && <p className="text-sm text-[#8B9E96] mt-3">اختيارك: {answer}</p>}</div><button className={btn+" mt-3"} onClick={()=>{setCursor(0);setAnswer("");}}>إعادة التجربة</button>{active?.type==="message"&&<button className={btn+" mt-3 mr-2"} onClick={()=>setCursor(x=>Math.min(x+1,steps.length-1))}>التالي</button>}</> :
          <><h2 className="font-bold mb-4">تعديل الخطوة</h2>{current?.type!=="end"&&<><label className="block text-sm mb-2">نص الرسالة</label><textarea className="w-full min-h-32 bg-[#0F2E24] border border-[#173D30] rounded-xl p-3 outline-none focus:border-[#3DD189]" maxLength={2000} value={current?.text??""} onChange={e=>patch(current.id,{text:e.target.value})}/></>}
          {current?.type==="question"&&<><label className="block text-sm mt-4 mb-2">خيارات الرد (خيار بكل سطر)</label><textarea className="w-full min-h-28 bg-[#0F2E24] border border-[#173D30] rounded-xl p-3" value={current.options.join("\n")} onChange={e=>patch(current.id,{options:e.target.value.split("\n").slice(0,10)})}/></>}
          {current?.type==="end"&&<p className="text-[#8B9E96]">هذه الخطوة تنهي المحادثة.</p>}
          <div className="flex justify-between mt-6"><span className={"text-sm "+(valid?"text-[#3DD189]":"text-[#E5B54B]")}>{valid?"المسودة قابلة للتجربة":"أكمل النصوص والخيارات أولاً"}</span><button disabled={steps.length===1} className="text-red-300 disabled:opacity-40 flex items-center gap-1" onClick={()=>{setSteps(old=>old.filter(s=>s.id!==current.id));setSelected(steps.find(s=>s.id!==current.id)?.id??"");}}><Trash2 size={16}/> حذف الخطوة</button></div></>}
        </section>
      </div>
      <p className="text-[#8B9E96] text-xs mt-5">هذه واجهة معاينة مستقلة: الحفظ محلي في متصفحك، ولا توجد مزامنة مع Supabase أو إرسال فعلي أو تفعيل آلي للعملاء.</p>
    </div>
  </div>;
}
