import { useEffect, useRef, useState } from "react";
import { useInView, usePrefersReducedMotion, useReveal } from "../hooks/useReveal";
import { IconMic, IconQuestion, IconShieldCheck, IconTicks, IconHandoff, Logo } from "./Icons";

type Msg = {
  from: "customer" | "milano" | "system";
  text: string;
  time: string;
  highlight?: boolean;
};

const SCRIPT: Msg[] = [
  { from: "customer", text: "سلام عليكم", time: "9:41 م" },
  { from: "milano", text: "وعليكم السلام! حيّاك في كافيه ميلانو ☕ كيف أقدر أساعدك اليوم؟", time: "9:41 م" },
  { from: "customer", text: "كم سعر السبانش لاتيه؟", time: "9:42 م" },
  { from: "milano", text: "السبانش لاتيه عندنا بـ 18 ريال — حار أو مثلج. وعندك كرت الولاء: الكوب السادس مجاني.", time: "9:42 م" },
  { from: "customer", text: "ومتى تفتحون يوم الجمعة؟", time: "9:43 م" },
  { from: "milano", text: "نفتح يومياً من 7 الصباح إلى 1 بالليل، بما فيها الجمعة والسبت. حياك في أي وقت!", time: "9:43 م" },
  { from: "customer", text: "عندكم فرع في جدة؟", time: "9:44 م" },
  {
    from: "milano",
    text: "عذراً، ما عندي معلومات مؤكدة عن فروع في جدة. أحوّلك للفريق يعطونك التفاصيل كاملة.",
    time: "9:44 م",
    highlight: true,
  },
  { from: "system", text: "يتم تحويل المحادثة لموظف بشري…", time: "9:44 م" },
];

const NOTES = [
  {
    icon: <IconShieldCheck className="w-5 h-5" />,
    title: "يرد من بياناتك فعلياً",
    body: "السعر والمواعيد في المحادثة مسجّلة في بطاقة المشروع — مو تأليف. لاحظ الدقة: 18 ريال، 7ص – 1م.",
  },
  {
    icon: <IconQuestion className="w-5 h-5" />,
    title: "أهم رسالة في الصفحة كلها",
    body: "سألوه عن فرع ما هو موجود في البيانات، فقال «ما عندي معلومات مؤكدة» بدل ما يخترع فرعاً يورّطك.",
    gold: true,
  },
  {
    icon: <IconHandoff className="w-5 h-5" />,
    title: "التحويل الفوري لك",
    body: "لحظة ما وصل لطرف معلوماته، أوقف الرد الآلي وحوّل المحادثة لموظف بشري — أنت دايماً صاحب القرار.",
  },
];

function Bubble({ m }: { m: Msg }) {
  if (m.from === "system") {
    return (
      <div className="msg-in flex justify-center my-1">
        <span className="bg-oro/15 border border-oro/40 text-oro-soft text-[11px] font-semibold px-3.5 py-1.5 rounded-full">
          {m.text}
        </span>
      </div>
    );
  }
  const mine = m.from === "customer";
  return (
    <div className={`msg-in flex ${mine ? "justify-end" : "justify-start"}`}>
      <div
        className={`relative max-w-[82%] px-3.5 py-2.5 text-[13.5px] leading-6 shadow-md ${
          mine
            ? "bg-wa-out text-bone rounded-2xl rounded-br-md"
            : m.highlight
              ? "bg-wa-in text-bone rounded-2xl rounded-bl-md ring-2 ring-oro outline outline-4 outline-oro/20"
              : "bg-wa-in text-bone rounded-2xl rounded-bl-md"
        }`}
      >
        {!mine && (
          <span className="absolute -top-2 start-2 text-verde">
            <Logo className="w-4 h-4" />
          </span>
        )}
        <p className={m.highlight ? "font-semibold" : ""}>{m.text}</p>
        <span className={`flex items-center gap-1 justify-end mt-0.5 text-[10px] ${mine ? "text-mist/60" : "text-sage/70"}`}>
          {m.time}
          {mine && <IconTicks className="w-3.5 h-2.5 text-tick" />}
        </span>
      </div>
    </div>
  );
}

function Phone({ step, typing }: { step: number; typing: boolean }) {
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [step, typing]);

  return (
    <div className="relative mx-auto w-full max-w-[340px]">
      {/* إطار الهاتف */}
      <div className="rounded-[2.6rem] border border-verde/25 bg-night p-2.5 shadow-[0_50px_100px_-30px_rgba(0,0,0,0.8)]">
        <div className="rounded-[2rem] overflow-hidden bg-wa-dark flex flex-col h-[540px]">
          {/* رأس واتساب */}
          <div className="bg-pine px-4 py-3 flex items-center gap-3 border-b border-verde/15">
            <span className="w-9 h-9 rounded-full bg-moss border border-verde/40 flex items-center justify-center text-verde shrink-0">
              <Logo className="w-5.5 h-5.5" />
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-bone truncate">كافيه ميلانو — موظف ميلانو</p>
              <p className="text-[11px] text-verde flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-verde live-dot" />
                {typing ? "يكتب الآن…" : "متصل الآن"}
              </p>
            </div>
            <span className="text-sage text-lg leading-none">⋮</span>
          </div>

          {/* المحادثة */}
          <div ref={bodyRef} className="chat-bg flex-1 overflow-y-auto px-3 py-4 space-y-2.5 scroll-smooth">
            <div className="flex justify-center mb-2">
              <span className="bg-night/70 text-sage text-[10.5px] px-3 py-1 rounded-full border border-verde/10">اليوم</span>
            </div>
            {SCRIPT.slice(0, step).map((m, i) => (
              <Bubble key={i} m={m} />
            ))}
            {typing && (
              <div className="flex justify-start msg-in">
                <div className="bg-wa-in rounded-2xl rounded-bl-md px-4 py-3.5 flex items-center gap-1.5">
                  <span className="typing-dot w-1.5 h-1.5 rounded-full bg-sage" />
                  <span className="typing-dot w-1.5 h-1.5 rounded-full bg-sage" />
                  <span className="typing-dot w-1.5 h-1.5 rounded-full bg-sage" />
                </div>
              </div>
            )}
          </div>

          {/* شريط الإدخال */}
          <div className="bg-wa-dark px-3 py-2.5 flex items-center gap-2 border-t border-white/5">
            <div className="flex-1 bg-wa-in rounded-full px-4 py-2.5 text-[12.5px] text-sage/60">اكتب رسالة…</div>
            <span className="w-9 h-9 rounded-full bg-verde text-ink flex items-center justify-center shrink-0">
              <IconMic className="w-4.5 h-4.5" />
            </span>
          </div>
        </div>
      </div>

      {/* انعكاس ضوئي */}
      <div className="absolute -inset-8 -z-10 bg-[radial-gradient(55%_55%_at_50%_45%,rgba(46,194,126,0.14),transparent_70%)]" aria-hidden="true" />
    </div>
  );
}

export default function ChatDemo() {
  const reduced = usePrefersReducedMotion();
  const view = useInView<HTMLDivElement>("-120px");
  const ref = useReveal<HTMLElement>();
  const [step, setStep] = useState(0);
  const [typing, setTyping] = useState(false);
  const [started, setStarted] = useState(false);
  const [done, setDone] = useState(false);

  /* يبدأ العرض عند دخول القسم للشاشة */
  useEffect(() => {
    if (view.inView && !started) setStarted(true);
  }, [view.inView, started]);

  /* إذا المستخدم يفضّل تقليل الحركة: اعرض كل شي مباشرة */
  useEffect(() => {
    if (reduced && started) {
      setStep(SCRIPT.length);
      setDone(true);
    }
  }, [reduced, started]);

  /* محرك العرض المتسلسل */
  useEffect(() => {
    if (!started || reduced || done) return;
    if (step >= SCRIPT.length) {
      setTyping(false);
      setDone(true);
      return;
    }
    const msg = SCRIPT[step];
    if (msg.from === "milano") {
      setTyping(true);
      const t = setTimeout(() => {
        setTyping(false);
        setStep((s) => s + 1);
      }, 1250);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setStep((s) => s + 1), msg.from === "system" ? 700 : 850);
    return () => clearTimeout(t);
  }, [step, started, reduced, done]);

  const replay = () => {
    setStep(0);
    setDone(false);
    setTyping(false);
    setStarted(true);
  };

  return (
    <section id="demo" ref={ref} className="relative scroll-mt-24 py-20 lg:py-28 overflow-hidden">
      <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
        <div className="absolute inset-0 bg-[radial-gradient(900px_500px_at_10%_10%,rgba(232,178,75,0.07),transparent_60%)]" />
      </div>

      <div ref={view.ref} className="relative max-w-6xl mx-auto px-5 lg:px-8 grid lg:grid-cols-[0.9fr_1.1fr] gap-14 items-center">
        {/* الهاتف — ثابت أثناء التمرير على الشاشات الكبيرة */}
        <div data-reveal className="lg:sticky lg:top-28 self-start">
          <Phone step={step} typing={typing} />
          <div className="flex items-center justify-center gap-3 mt-6">
            <button
              onClick={replay}
              className="inline-flex items-center gap-2 text-sm font-semibold text-mist bg-moss border border-verde/25 rounded-full px-5 py-2.5 hover:border-oro/60 hover:text-oro transition-all duration-300 active:scale-95"
            >
              <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3.5 3.5v5h5" />
              </svg>
              أعد تشغيل المحادثة
            </button>
            {done && !reduced && (
              <span className="text-[11px] text-sage msg-in">محادثة حقيقية من لوحة عميل</span>
            )}
          </div>
        </div>

        {/* الشرح */}
        <div>
          <p data-reveal className="font-display font-bold text-oro text-lg mb-2">
            — ميلانو وهو يشتغل
          </p>
          <h2 data-reveal style={{ transitionDelay: "80ms" }} className="font-display font-extrabold text-4xl sm:text-5xl leading-[1.15] text-bone mb-4">
            شوفه يرد…
            <br />
            <span className="text-verde">وشوفه يوقف بوقته</span>
          </h2>
          <p data-reveal style={{ transitionDelay: "160ms" }} className="text-sage leading-8 mb-9 max-w-lg">
            المحادثة اللي تشوفها توضح الفرق بين موظف يرد «أي كلام» وموظف مربوط ببياناتك: يجاوب بدقّة،
            ويعترف لما ما يعرف، ويحوّل لك القرار.
          </p>

          <ol className="space-y-4">
            {NOTES.map((n, i) => (
              <li
                key={n.title}
                data-reveal
                style={{ transitionDelay: `${i * 120}ms` }}
                className={`lift flex gap-4 rounded-3xl border p-5 ${
                  n.gold
                    ? "bg-gradient-to-l from-[#2a2415] to-pine border-oro/50 shadow-[0_20px_50px_-20px_rgba(232,178,75,0.35)]"
                    : "bg-pine/70 border-verde/15"
                }`}
              >
                <span
                  className={`w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 border ${
                    n.gold ? "bg-oro/15 border-oro/50 text-oro" : "bg-moss border-verde/25 text-verde"
                  }`}
                >
                  {n.icon}
                </span>
                <div>
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <h3 className={`font-display font-bold text-lg ${n.gold ? "text-oro" : "text-bone"}`}>{n.title}</h3>
                    {n.gold && (
                      <span className="text-[10px] font-bold bg-oro text-ink rounded-full px-2.5 py-0.5">الأهم</span>
                    )}
                  </div>
                  <p className="text-sm text-sage leading-7 mt-1">{n.body}</p>
                </div>
              </li>
            ))}
          </ol>

          <p data-reveal className="mt-7 text-[12.5px] leading-6 text-sage/75 max-w-lg">
            الربط يتم عبر خاصية «الأجهزة المرتبطة» في واتساب — نفس طريقة واتساب ويب. ما نطلب كلمة مرور حسابك،
            وتقدر تفصل الموظف من جوالك في أي لحظة.
          </p>
        </div>
      </div>
    </section>
  );
}
