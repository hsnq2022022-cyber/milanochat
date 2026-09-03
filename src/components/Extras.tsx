import { IconWhatsapp, Logo } from "./Icons";

/* ============================ شريط الأنشطة المتحرك ============================ */

const SECTORS = [
  "مقاهي ومطاعم",
  "عيادات ومراكز تجميل",
  "صالونات وحلاقين",
  "متاجر إلكترونية",
  "مكاتب عقارية",
  "نوادي رياضية",
  "مغاسل وخدمات",
  "معاهد تدريب",
  "فنادق وشقق",
  "خدمات سيارات",
];

function Diamond() {
  return (
    <svg viewBox="0 0 10 10" className="w-2 h-2 text-oro/70 shrink-0" fill="currentColor" aria-hidden="true">
      <rect x="1.6" y="1.6" width="6.8" height="6.8" transform="rotate(45 5 5)" />
    </svg>
  );
}

export function Marquee() {
  const row = [...SECTORS, ...SECTORS];
  return (
    <section className="relative py-6 border-y border-verde/12 bg-pine/50 overflow-hidden" aria-label="الأنشطة التي يخدمها ميلانو">
      <div className="marquee-track flex w-max items-center gap-8 pe-8">
        {row.map((s, i) => (
          <span key={i} className="flex items-center gap-8">
            <span className="font-display font-semibold text-lg text-sage whitespace-nowrap hover:text-oro transition-colors duration-300 cursor-default">
              {s}
            </span>
            <Diamond />
          </span>
        ))}
      </div>
      <div className="absolute inset-y-0 start-0 w-24 bg-gradient-to-l from-transparent to-night pointer-events-none" />
      <div className="absolute inset-y-0 end-0 w-24 bg-gradient-to-r from-transparent to-night pointer-events-none" />
    </section>
  );
}

/* ============================ الفوتر ============================ */

const FOOT_LINKS = [
  {
    title: "المنتج",
    links: [
      { label: "الضمانات", href: "#guarantees" },
      { label: "العرض الحي", href: "#demo" },
      { label: "الأسعار والشحن", href: "#pricing" },
      { label: "ابدأ الآن", href: "#start" },
    ],
  },
  {
    title: "المساعدة",
    links: [
      { label: "الأسئلة الشائعة", href: "#faq" },
      { label: "تفاصيل الربط", href: "#faq" },
      { label: "شحن الرصيد", href: "#pricing" },
      { label: "التحويل للبشري", href: "#demo" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="relative border-t border-verde/12 bg-night overflow-hidden">
      {/* بند ختامي */}
      <div className="max-w-6xl mx-auto px-5 lg:px-8 pt-16 pb-10 grid lg:grid-cols-[1.2fr_1fr] gap-10 items-center">
        <div>
          <h2 className="font-display font-extrabold text-4xl sm:text-5xl leading-[1.15] text-bone">
            عملاؤك ما ينامون
            <br />
            <span className="text-oro">…وموظفك بعد اليوم ما ينام</span>
          </h2>
          <p className="mt-4 text-sage leading-7 max-w-md">
            99 ريال تفصل مشروعك عن موظف يرد بدقّة، ويعترف لما ما يعرف، ويوصّل لك القرار.
          </p>
        </div>
        <div className="flex flex-col sm:flex-row lg:justify-end gap-3">
          <a
            href="#start"
            className="group inline-flex items-center justify-center gap-2.5 bg-verde text-ink font-display font-bold text-lg px-8 py-4 rounded-2xl hover:bg-oro transition-all duration-300 active:scale-95 hover:shadow-[0_16px_45px_-12px_rgba(232,178,75,0.5)]"
          >
            <IconWhatsapp className="w-5 h-5" />
            أنشئ موظفك الآن
          </a>
          <a
            href="#demo"
            className="inline-flex items-center justify-center gap-2 border border-verde/30 text-mist font-semibold px-8 py-4 rounded-2xl hover:border-oro/60 hover:text-oro transition-all duration-300 active:scale-95"
          >
            شوفه يشتغل أولاً
          </a>
        </div>
      </div>

      {/* روابط الفوتر */}
      <div className="border-t border-verde/10">
        <div className="max-w-6xl mx-auto px-5 lg:px-8 py-10 grid sm:grid-cols-[1.4fr_1fr_1fr] gap-8">
          <div>
            <a href="#top" className="flex items-center gap-2.5 mb-4">
              <span className="text-verde">
                <Logo className="w-9 h-9" />
              </span>
              <span className="font-display font-bold text-2xl text-bone">
                ميلانو<span className="text-oro">.</span>
              </span>
            </a>
            <p className="text-[12.5px] text-sage/80 leading-6 max-w-sm">
              موظف خدمة عملاء بالذكاء الاصطناعي يشتغل على واتساب مشروعك — يرد من معلوماتك الحقيقية فقط،
              ويحوّل لك الحالات اللي تحتاج قرارك.
            </p>
          </div>
          {FOOT_LINKS.map((col) => (
            <nav key={col.title} aria-label={col.title}>
              <p className="font-display font-bold text-oro mb-3.5">{col.title}</p>
              <ul className="space-y-2.5">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <a href={l.href} className="text-sm text-sage hover:text-bone hover:ps-1.5 transition-all duration-300">
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
      </div>

      {/* الشريط الأخير */}
      <div className="border-t border-verde/10">
        <div className="max-w-6xl mx-auto px-5 lg:px-8 py-5 flex flex-col sm:flex-row items-center justify-between gap-3 text-[11.5px] text-sage/70">
          <p>© 2026 ميلانو — جميع الحقوق محفوظة.</p>
          <p className="text-center sm:text-left leading-5 max-w-xl">
            الربط عبر «الأجهزة المرتبطة» في واتساب وليس قناة رسمية من Meta، وقد تقيّد واتساب أي رقم وفق
            تقديرها. <span className="text-oro-soft">اقرأ التفاصيل قبل الربط.</span>
          </p>
        </div>
      </div>
    </footer>
  );
}
