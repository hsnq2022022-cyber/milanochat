import { useReveal } from "../hooks/useReveal";
import {
  IconCoin,
  IconFilter,
  IconGlobe,
  IconHandoff,
  IconLog,
  IconMapPin,
  IconPen,
  IconQuestion,
  IconShieldCheck,
  Logo,
} from "./Icons";

type G = {
  n: string;
  title: string;
  body: string;
  icon: JSX.Element;
  wide?: boolean;
  visual?: JSX.Element;
};

/* مخطط مصغّر لبطاقة الأولى: المصادر → ميلانو */
function SourcesDiagram() {
  return (
    <div className="mt-6 grid grid-cols-[1fr_auto_1fr] items-center gap-3" aria-hidden="true">
      <div className="space-y-2">
        {[
          { icon: <IconMapPin className="w-3.5 h-3.5" />, t: "بطاقة قوقل" },
          { icon: <IconGlobe className="w-3.5 h-3.5" />, t: "موقعك / متجرك" },
          { icon: <IconPen className="w-3.5 h-3.5" />, t: "ملاحظاتك أنت" },
        ].map((s) => (
          <div
            key={s.t}
            className="flex items-center gap-2 bg-night/60 border border-verde/15 rounded-xl px-3 py-2 text-[11.5px] text-mist hover:border-oro/50 hover:-translate-y-0.5 transition-all duration-300"
          >
            <span className="text-oro">{s.icon}</span>
            {s.t}
          </div>
        ))}
      </div>
      <svg viewBox="0 0 60 24" className="w-12 h-6 text-verde/60" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M58 12H6m0 0 6-5m-6 5 6 5" />
      </svg>
      <div className="flex flex-col items-center gap-2">
        <span className="w-14 h-14 rounded-2xl bg-moss border border-verde/40 flex items-center justify-center text-verde shadow-[0_10px_30px_-10px_rgba(46,194,126,0.4)]">
          <Logo className="w-8 h-8" />
        </span>
        <span className="text-[11px] text-sage font-semibold">ميلانو</span>
      </div>
    </div>
  );
}

const ITEMS: G[] = [
  {
    n: "٠١",
    title: "لا يجاوب إلا من معلوماتك",
    body: "الموظف يقرأ من بطاقتك على قوقل، وموقعك، وما تكتبه أنت — ولا شي غيرها. ما عنده معرفة عامة يرد منها عن مشروعك، فمستحيل يخترع سعراً أو خدمة ما عندك.",
    icon: <IconShieldCheck className="w-6 h-6" />,
    wide: true,
    visual: <SourcesDiagram />,
  },
  {
    n: "٠٢",
    title: "كل رد يُفحص قبل ما يُرسل",
    body: "قبل وصول الرد للعميل، يمر على فحص يمنع أي سعر أو موعد أو وعد ما صرّحت به. لو حاول يخترع، يُستبدل الرد ولا يخرج.",
    icon: <IconFilter className="w-6 h-6" />,
  },
  {
    n: "٠٣",
    title: "ما يعرف؟ يقول ما يعرف",
    body: "إذا سُئل عن شي ما عندك فيه معلومة مؤكدة، يقولها بوضوح ويعرض تحويل العميل لك — بدل ما يخمّن ويورّطك بوعد.",
    icon: <IconQuestion className="w-6 h-6" />,
  },
  {
    n: "٠٤",
    title: "الحالات الحساسة تصلك أنت",
    body: "شكوى، استرجاع، أو أي طلب يحتاج قرارك: يتوقف الموظف ويحوّل المحادثة لك فوراً بدل ما يتصرف من عنده.",
    icon: <IconHandoff className="w-6 h-6" />,
  },
  {
    n: "٠٥",
    title: "تشوف كل سؤال عجز عنه",
    body: "كل سؤال ما قدر يجاوبه يُسجّل ويظهر لك في لوحتك، فتضيف المعلومة الناقصة ويصير أدق مع الوقت.",
    icon: <IconLog className="w-6 h-6" />,
  },
  {
    n: "٠٦",
    title: "ما تدفع على رد ما وصل",
    body: "الخصم يتم بعد تسليم الرد فعلاً. لو فشل الإرسال، ما ينخصم شي — ولا يتكرر الخصم على نفس الرسالة أبداً.",
    icon: <IconCoin className="w-6 h-6" />,
  },
];

export default function Guarantees() {
  const ref = useReveal<HTMLElement>();

  return (
    <section id="guarantees" ref={ref} className="relative scroll-mt-24 py-20 lg:py-28">
      <div className="max-w-6xl mx-auto px-5 lg:px-8">
        <div className="max-w-2xl mb-12">
          <p data-reveal className="font-display font-bold text-oro text-lg mb-2">
            — ليش تأمنه على عملائك؟
          </p>
          <h2 data-reveal style={{ transitionDelay: "80ms" }} className="font-display font-extrabold text-4xl sm:text-5xl leading-[1.15] text-bone">
            الضمانات مبنية في النظام،
            <br />
            <span className="text-sage">مو مجرد وعود</span>
          </h2>
          <p data-reveal style={{ transitionDelay: "160ms" }} className="mt-4 text-sage leading-7">
            ما نطلب منك تثق فينا — هذي ست حراسات تشتغل على كل رسالة، قبل ما توصل لعميلك.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-4">
          {ITEMS.map((g, i) => (
            <article
              key={g.n}
              data-reveal
              style={{ transitionDelay: `${(i % 3) * 110}ms` }}
              className={`lift relative bg-pine/80 border border-verde/15 rounded-3xl p-6 group ${
                g.wide ? "md:col-span-2 bg-gradient-to-l from-pine to-moss" : ""
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                <span className="w-12 h-12 rounded-2xl bg-moss border border-verde/25 text-verde flex items-center justify-center group-hover:text-oro group-hover:border-oro/50 group-hover:rotate-6 transition-all duration-400">
                  {g.icon}
                </span>
                <span className="font-display font-bold text-2xl text-verde/25 group-hover:text-oro/40 transition-colors duration-400">
                  {g.n}
                </span>
              </div>
              <h3 className="font-display font-bold text-xl text-bone mt-4 mb-2 group-hover:text-oro-soft transition-colors duration-300">
                {g.title}
              </h3>
              <p className="text-sm text-sage leading-7">{g.body}</p>
              {g.visual}
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
