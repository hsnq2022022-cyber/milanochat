import { useReveal } from "../hooks/useReveal";
import { IconArrowStart, IconBolt, IconCheck, IconCoin, IconInfinity, IconSparkle, IconWhatsapp, Logo } from "./Icons";

const STEPS = [
  {
    n: "١",
    title: "اربط مشروعك",
    body: "من قوقل ماب، موقعك، أو تكتبها يدوياً — دقيقتين وتخلص.",
    icon: <IconSparkle className="w-5 h-5" />,
  },
  {
    n: "٢",
    title: "اربط واتسابك",
    body: "عبر «الأجهزة المرتبطة» — بدون كلمة مرور، وتفصله متى تبغى.",
    icon: <IconWhatsapp className="w-5 h-5" />,
  },
  {
    n: "٣",
    title: "خلّه يرد",
    body: "يستقبل عملاءك 24/7، ويشحن رصيدك وقت ما تحتاج فقط.",
    icon: <IconBolt className="w-5 h-5" />,
  },
];

const PACKS = [
  { replies: "500 رد ذكي", price: "39", per: "0.078 ريال / رد", tag: "" },
  { replies: "1,500 رد ذكي", price: "99", per: "0.066 ريال / رد", tag: "الأكثر طلباً" },
  { replies: "5,000 رد ذكي", price: "249", per: "0.050 ريال / رد", tag: "للمشاغل العالية" },
];

export default function Pricing() {
  const ref = useReveal<HTMLElement>();

  return (
    <section id="pricing" ref={ref} className="relative scroll-mt-24 py-20 lg:py-28 overflow-hidden">
      {/* خلفية فاتحة تميّز القسم */}
      <div className="absolute inset-0 bg-bone" aria-hidden="true" />
      <div
        className="absolute inset-0 opacity-[0.35] pinstripe"
        style={{ backgroundImage: "repeating-linear-gradient(90deg, rgba(11,36,27,0.05) 0 1px, transparent 1px 96px)" }}
        aria-hidden="true"
      />

      <div className="relative max-w-6xl mx-auto px-5 lg:px-8">
        <div className="grid lg:grid-cols-[1.05fr_0.95fr] gap-12 items-start">
          {/* بطاقة السعر */}
          <div>
            <p data-reveal className="font-display font-bold text-verde-deep text-lg mb-2">
              — كم يكلفك الموظف؟
            </p>
            <h2 data-reveal style={{ transitionDelay: "80ms" }} className="font-display font-extrabold text-4xl sm:text-5xl leading-[1.15] text-ink mb-10">
              دفعة واحدة.
              <br />
              <span className="text-verde-deep">وبعدها ما تدفع إلا اللي تستخدمه</span>
            </h2>

            <article
              data-reveal
              style={{ transitionDelay: "160ms" }}
              className="lift relative bg-pine rounded-[2rem] p-8 text-bone overflow-hidden shadow-[0_40px_80px_-30px_rgba(6,32,26,0.55)]"
            >
              <div className="absolute top-0 inset-x-0 h-1.5 bg-gradient-to-l from-verde via-oro to-transparent" />
              <div className="absolute -start-10 -bottom-14 opacity-10 text-verde rotate-12" aria-hidden="true">
                <Logo className="w-48 h-48" />
              </div>

              <div className="relative flex flex-wrap items-end justify-between gap-6">
                <div>
                  <p className="font-display font-extrabold text-7xl leading-none text-bone">
                    99 <span className="text-2xl text-oro">ريال</span>
                  </p>
                  <p className="mt-2 text-sm text-sage">دفعة واحدة — يشمل إنشاء الموظف + 1,000 رد ذكي</p>
                </div>
                <a
                  href="#start"
                  className="group inline-flex items-center gap-2.5 bg-verde text-ink font-display font-bold text-lg px-7 py-3.5 rounded-2xl hover:bg-oro transition-all duration-300 active:scale-95 hover:shadow-[0_16px_40px_-12px_rgba(232,178,75,0.5)]"
                >
                  ابدأ الآن
                  <span className="transition-transform duration-300 group-hover:-translate-x-1">
                    <IconArrowStart className="w-5 h-5" />
                  </span>
                </a>
              </div>

              <ul className="relative mt-8 grid sm:grid-cols-2 gap-x-6 gap-y-3.5 border-t border-verde/15 pt-7">
                {[
                  "يرد بمعلومات مشروعك الحقيقية، وما يخترع من عنده",
                  "يحوّل المحادثة لك إذا طلب العميل موظفاً بشرياً",
                  "بدون اشتراك شهري — تشحن رصيد وقت ما تحتاج",
                  "لوحة تشوف فيها كل سؤال عجز عنه",
                ].map((f) => (
                  <li key={f} className="flex items-start gap-2.5 text-[13.5px] leading-6 text-mist">
                    <span className="mt-1 text-oro shrink-0">
                      <IconCheck className="w-4 h-4" />
                    </span>
                    {f}
                  </li>
                ))}
              </ul>
            </article>
          </div>

          {/* الشحنات + الخطوات */}
          <div className="space-y-10">
            <div>
              <h3 data-reveal className="font-display font-bold text-2xl text-ink mb-1 flex items-center gap-2.5">
                <span className="text-verde-deep">
                  <IconCoin className="w-6 h-6" />
                </span>
                خلص الرصيد؟ اشحن بس
              </h3>
              <p data-reveal style={{ transitionDelay: "60ms" }} className="text-sm text-ink/60 mb-5">
                ما فيه اشتراك ولا رسوم خفية — تدفع على الردود اللي توصل فعلاً.
              </p>

              <div className="space-y-3">
                {PACKS.map((p, i) => (
                  <div
                    key={p.replies}
                    data-reveal
                    style={{ transitionDelay: `${i * 100}ms` }}
                    className="lift group flex items-center justify-between gap-4 bg-night/[0.04] border border-ink/10 hover:border-verde-deep/50 rounded-2xl px-5 py-4 transition-colors"
                  >
                    <div>
                      <p className="font-display font-bold text-lg text-ink flex items-center gap-2.5">
                        {p.replies}
                        {p.tag && (
                          <span className="text-[10px] font-body font-bold bg-verde-deep text-bone rounded-full px-2.5 py-0.5">
                            {p.tag}
                          </span>
                        )}
                      </p>
                      <p className="text-[11.5px] text-ink/50 mt-0.5 tabular-nums">{p.per}</p>
                    </div>
                    <p className="font-display font-extrabold text-2xl text-ink group-hover:text-verde-deep transition-colors">
                      {p.price} <span className="text-sm text-ink/50">ريال</span>
                    </p>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h3 data-reveal className="font-display font-bold text-2xl text-ink mb-5 flex items-center gap-2.5">
                <span className="text-oro">
                  <IconInfinity className="w-6 h-6" />
                </span>
                ثلاث خطوات ويشتغل
              </h3>
              <ol className="relative space-y-5 before:absolute before:top-3 before:bottom-3 before:start-[1.35rem] before:w-px before:bg-ink/15">
                {STEPS.map((s, i) => (
                  <li key={s.n} data-reveal style={{ transitionDelay: `${i * 110}ms` }} className="relative flex gap-4">
                    <span className="relative z-10 w-11 h-11 rounded-full bg-pine text-oro border-4 border-bone flex items-center justify-center font-display font-bold text-lg shrink-0">
                      {s.n}
                    </span>
                    <div className="pt-1">
                      <p className="font-display font-bold text-lg text-ink flex items-center gap-2">
                        {s.title}
                        <span className="text-verde-deep">{s.icon}</span>
                      </p>
                      <p className="text-sm text-ink/60 leading-6 mt-0.5">{s.body}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
