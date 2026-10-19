/**
 * قسم القنوات الثلاث — "كل رسائلك في مكان واحد"
 * بطاقات WhatsApp / Instagram / Facebook + جدول مقارنة + خطوات العمل.
 * لا تعرض أي ميزة على أنها فعلية قبل إتمام التكامل — المعلومات وصفية وتوضيحية.
 */
import { useReveal } from "../hooks/useReveal";
import { CHANNEL_LIST, CHANNELS } from "../lib/channels";

const CARD_CONTENT = [
  {
    id: "whatsapp" as const,
    title: "خدمة عملاء واتساب",
    desc: "اربط رقم نشاطك التجاري، واستقبل استفسارات العملاء، وشغّل وكيل الذكاء الاصطناعي للرد اعتماداً على معلومات نشاطك التجاري.",
    features: ["استقبال الرسائل", "الرد التلقائي", "مصادر المعرفة", "تحويل المحادثة إلى موظف", "إدارة المحادثات"],
  },
  {
    id: "instagram" as const,
    title: "إدارة رسائل إنستغرام",
    desc: "اربط حساب Instagram الاحترافي الخاص بنشاطك التجاري، واجمع الرسائل الواردة في صندوق موحد، واستخدم الذكاء الاصطناعي لمساعدة فريقك على خدمة العملاء.",
    features: ["استقبال الرسائل الخاصة للحسابات المؤهلة", "الرد من لوحة التحكم", "وكيل ذكاء اصطناعي لكل حساب", "تحويل المحادثة إلى موظف", "سجل المحادثات"],
  },
  {
    id: "facebook" as const,
    title: "إدارة رسائل فيسبوك",
    desc: "اربط صفحات Facebook التي تديرها، واستقبل رسائل Messenger في منصتك، وأدر المحادثات مع العملاء دون التنقل بين التطبيقات.",
    features: ["ربط صفحات النشاط التجاري", "استقبال رسائل Messenger", "الرد من لوحة التحكم", "وكيل ذكاء اصطناعي", "التحويل إلى موظف"],
  },
];

const COMPARE_ROWS = [
  { channel: CHANNELS.whatsapp, recv: "نعم", reply: "نعم", agent: "نعم" },
  { channel: CHANNELS.instagram, recv: "نعم للحسابات المؤهلة", reply: "نعم", agent: "نعم" },
  { channel: CHANNELS.facebook, recv: "نعم للصفحات المؤهلة", reply: "نعم", agent: "نعم" },
];

const STEPS = [
  { n: 1, t: "اربط حساباتك", d: "سجّل الدخول عبر Meta الرسمية وربط الأصول." },
  { n: 2, t: "اختر القنوات", d: "فعّل واتساب أو إنستغرام أو فيسبوك حسب نشاطك." },
  { n: 3, t: "اربط الوكيل", d: "خصّص وكيل ذكاء اصطناعي لكل قناة أو حساب." },
  { n: 4, t: "حدد المعرفة", d: "امنح الوكيل مصادر معلومات نشاطك التجاري." },
  { n: 5, t: "صندوق موحد", d: "استقبل كل المحادثات في صفحة واحدة مرتبة." },
  { n: 6, t: "راقب الأداء", d: "تابع أداء فريقك والوكيل من نفس اللوحة." },
];

export default function ChannelsSection() {
  const ref = useReveal<HTMLElement>();

  return (
    <section id="channels" ref={ref} className="relative scroll-mt-24 py-20 lg:py-28">
      <div className="max-w-6xl mx-auto px-5 lg:px-8">
        {/* العنوان */}
        <div className="text-center mb-14">
          <p data-reveal className="font-display font-bold text-oro text-lg mb-2">— ثلاث قنوات، منصة واحدة</p>
          <h2 data-reveal style={{ transitionDelay: "80ms" }} className="font-display font-extrabold text-4xl sm:text-5xl text-bone">
            كل رسائلك في مكان واحد
          </h2>
          <p data-reveal style={{ transitionDelay: "160ms" }} className="mt-5 text-sage text-base sm:text-lg leading-8 max-w-3xl mx-auto">
            أدر محادثات عملائك من واتساب وإنستغرام وفيسبوك عبر لوحة واحدة، واجعل وكلاء الذكاء
            الاصطناعي يساعدونك في الرد والمتابعة وخدمة العملاء.
          </p>
        </div>

        {/* البطاقات الثلاث */}
        <div className="grid md:grid-cols-3 gap-6 mb-16">
          {CARD_CONTENT.map((c, i) => {
            const meta = CHANNELS[c.id];
            return (
              <article
                key={c.id}
                data-reveal
                style={{ transitionDelay: `${i * 90}ms` }}
                className={`relative bg-pine/70 border rounded-3xl p-6 flex flex-col overflow-hidden group hover:-translate-y-1 transition-transform duration-300 ${meta.borderClass}`}
              >
                <span className="absolute inset-x-0 top-0 h-1 opacity-70" style={{ background: meta.color }} aria-hidden="true" />
                <div className="flex items-center gap-3 mb-4">
                  <span
                    className="w-11 h-11 rounded-2xl flex items-center justify-center shrink-0"
                    style={{ background: `${meta.color}1a`, color: meta.color }}
                  >
                    <span className="w-6 h-6">{meta.icon}</span>
                  </span>
                  <h3 className="font-display font-bold text-xl text-bone leading-snug">{c.title}</h3>
                </div>
                <p className="text-sm text-sage leading-7 mb-5">{c.desc}</p>
                <ul className="space-y-2.5 mb-6 flex-1">
                  {c.features.map((f) => (
                    <li key={f} className="flex items-start gap-2.5 text-[13.5px] text-mist">
                      <span className="mt-1 w-1.5 h-1.5 rounded-full shrink-0" style={{ background: meta.color }} />
                      {f}
                    </li>
                  ))}
                </ul>
                <p className="text-[11px] leading-5 text-sage/70 border-t pt-3.5" style={{ borderColor: `${meta.color}26` }}>
                  {meta.note}
                </p>
              </article>
            );
          })}
        </div>

        {/* جدول مقارنة القنوات */}
        <div data-reveal className="mb-16">
          <h3 className="font-display font-bold text-2xl text-bone mb-5 text-center">مقارنة القنوات</h3>
          <div className="overflow-x-auto rounded-2xl border border-verde/15 bg-pine/60">
            <table className="w-full text-sm min-w-[560px]" dir="rtl">
              <thead>
                <tr className="border-b border-verde/15 text-right">
                  <th className="px-5 py-3.5 font-display font-bold text-mist">القناة</th>
                  <th className="px-5 py-3.5 font-display font-bold text-mist">استقبال الرسائل</th>
                  <th className="px-5 py-3.5 font-display font-bold text-mist">الرد من المنصة</th>
                  <th className="px-5 py-3.5 font-display font-bold text-mist">وكيل ذكاء اصطناعي</th>
                </tr>
              </thead>
              <tbody>
                {COMPARE_ROWS.map((r) => (
                  <tr key={r.channel.id} className="border-b border-verde/10 last:border-0">
                    <td className="px-5 py-3.5">
                      <span className="inline-flex items-center gap-2 font-semibold" style={{ color: r.channel.color }}>
                        <span className="w-4 h-4">{r.channel.icon}</span>
                        <span className="text-bone">{r.channel.badge}</span>
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-sage">{r.recv}</td>
                    <td className="px-5 py-3.5 text-verde font-semibold">{r.reply}</td>
                    <td className="px-5 py-3.5 text-verde font-semibold">{r.agent}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[11.5px] text-sage/70 text-center">
            الأهلية والصلاحيات تخضع لشروط Meta — قد تختلف الميزات المتاحة حسب نوع الحساب وحالة مراجعة التطبيق.
          </p>
        </div>

        {/* طريقة العمل */}
        <div>
          <h3 data-reveal className="font-display font-bold text-2xl text-bone mb-8 text-center">كيف تعمل المنصة؟</h3>
          <div data-reveal className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-10">
            {STEPS.map((s, i) => (
              <div key={s.n} className="relative bg-pine/60 border border-verde/15 rounded-2xl p-4 text-center">
                <span className="block w-8 h-8 mx-auto mb-2.5 rounded-full bg-verde/15 text-verde font-display font-bold text-sm leading-8">
                  {s.n}
                </span>
                <p className="font-display font-bold text-[13.5px] text-bone mb-1">{s.t}</p>
                <p className="text-[11.5px] text-sage leading-5">{s.d}</p>
                {i < STEPS.length - 1 && (
                  <span className="hidden lg:block absolute top-1/2 -left-3 -translate-y-1/2 text-verde/40 text-lg" aria-hidden="true">←</span>
                )}
              </div>
            ))}
          </div>

          {/* مخطط تدفق القنوات إلى صندوق واحد */}
          <div data-reveal className="bg-pine/70 border border-verde/15 rounded-3xl p-6 lg:p-8">
            <div className="flex flex-col lg:flex-row items-center gap-6">
              <div className="flex lg:flex-col gap-3 shrink-0">
                {CHANNEL_LIST.map((ch) => (
                  <span
                    key={ch.id}
                    className="inline-flex items-center gap-2 rounded-full border px-4 py-2 text-[13px] font-semibold"
                    style={{ borderColor: `${ch.color}4d`, color: ch.color, background: `${ch.color}0d` }}
                  >
                    <span className="w-4 h-4">{ch.icon}</span>
                    {ch.badge}
                  </span>
                ))}
              </div>
              <div className="text-verde/50 text-2xl hidden lg:block" aria-hidden="true">⟶</div>
              <div className="text-verde/50 text-2xl lg:hidden rotate-90" aria-hidden="true">⟶</div>
              <div className="flex-1 w-full bg-gradient-to-l from-verde/20 to-verde/5 border border-verde/30 rounded-2xl px-6 py-5 text-center">
                <p className="font-display font-bold text-lg text-bone mb-1">صندوق المحادثات الموحد</p>
                <p className="text-[12.5px] text-sage leading-6">
                  كل الرسائل من كل القنوات تصل إلى نفس المكان — مع تمييز بصري للمصدر، ووكيل لكل قناة،
                  وفريق بشري جاهز للتدخل متى لزم.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
