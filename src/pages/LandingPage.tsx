import { useId, useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft, BookOpenCheck, Check, Plus, UserCheck, Workflow, MessagesSquare } from "lucide-react";

/* صفحة الهبوط للزائر غير المسجّل. #/start يفتح صفحة البدء الحالية، والدفع يتم داخل لوحة التحكم. */

const CTA_START = "#/start";
const CTA_LOGIN = "#/dashboard";
const CTA_PAY = "#/dashboard?pay=1";

/* الأسعار الحقيقية لـ Quark وProton وAtom من عقد الشحن (supabase/functions/topup-create/contract.ts). */
const PLANS = [
  { id: "quark", name: "Quark", credits: 1000, price: 35000, hint: "للبداية والتجربة", featured: false },
  // TODO(pricing): placeholder — owner must confirm
  { id: "electron", name: "Electron", credits: 2000, price: 60000, hint: "لمشروع يكبر تدريجياً", featured: false },
  { id: "proton", name: "Proton", credits: 3000, price: 85000, hint: "للمشاريع النشطة", featured: true },
  // TODO(pricing): placeholder — owner must confirm
  { id: "neutron", name: "Neutron", credits: 5000, price: 140000, hint: "لحجم رسائل أعلى", featured: false },
  { id: "atom", name: "Atom", credits: 10000, price: 225000, hint: "للضغط العالي من الرسائل", featured: false },
];

const nf = new Intl.NumberFormat("en-US");

const FEATURES = [
  {
    icon: BookOpenCheck,
    title: "موظف ذكاء اصطناعي بقاعدة معرفتك",
    body: "يرد على الأسعار والمواعيد والموقع من المعلومات التي تضيفها أنت، وإذا لم يجد جواباً مؤكداً لا يخمّن.",
  },
  {
    icon: MessagesSquare,
    title: "قنوات متعددة",
    body: "واتساب وإنستغرام وفيسبوك في مكان واحد، وتقدر تربط أكثر من حساب وتميّز مصدر كل محادثة.",
  },
  {
    icon: Workflow,
    title: "منشئ تدفقات بدون كود",
    body: "صمّم مسار الحوار بنفسك بالسحب والإفلات (Flow Builder) من دون كتابة برمجة.",
  },
  {
    icon: UserCheck,
    title: "تحويل للموظف البشري",
    body: "عند عدم المعرفة أو طلب العميل شخصاً حقيقياً يتوقف الرد الآلي، وتتابع الأمر من لوحة التحكم والمحادثات.",
  },
];

const FAQS = [
  {
    q: "ما هي الاعتمادات؟",
    a: "الاعتماد هو رصيد تستهلكه ردود الموظف الذكي. تشحن الباقة التي تناسبك من لوحة التحكم وتتابع رصيدك المتبقي هناك.",
  },
  {
    q: "كيف أربط واتساب؟",
    a: "من لوحة التحكم تفتح قسم القنوات وتتبع خطوات الربط. يتطلب واتساب رقماً تجارياً عبر WhatsApp Business Platform.",
  },
  {
    q: "هل يرد بدون معرفة؟",
    a: "لا. إذا لم يجد جواباً مؤكداً في قاعدة معرفتك يقول ذلك بصراحة ويحوّل المحادثة إليك، ويظهر السؤال في لوحة التحكم لتضيف الجواب.",
  },
  {
    q: "هل أحتاج برمجة؟",
    a: "لا. تضيف معلوماتك وتضبط الموظف وتبني التدفقات من الواجهة مباشرة بدون كتابة كود.",
  },
  {
    q: "كيف أدفع؟",
    a: "الدفع بالدينار العراقي عبر رابط دفع آمن يُنشأ لك داخل لوحة التحكم بعد تسجيل الدخول واختيار الباقة.",
  },
  {
    q: "هل بياناتي آمنة؟",
    a: "بيانات كل مشروع معزولة عن غيره، ويمكنك الاطلاع على التفاصيل في سياسة الخصوصية، ومنها حقك في حذف بياناتك.",
  },
];

const focusRing =
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-[#3DD189] focus-visible:ring-offset-2 focus-visible:ring-offset-[#061A14]";

function SectionTitle({ kicker, title, id }: { kicker: string; title: string; id: string }) {
  return (
    <div className="mb-6 md:mb-8">
      <p className="mb-2 text-sm font-bold text-[#E5B54B]">{kicker}</p>
      <h2 id={id} className="text-2xl font-bold text-white">
        {title}
      </h2>
    </div>
  );
}

function Faq() {
  const base = useId();
  const [open, setOpen] = useState<number | null>(0);
  const btns = useRef<(HTMLButtonElement | null)[]>([]);

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const last = FAQS.length - 1;
    let next = -1;
    if (e.key === "ArrowDown") next = i === last ? 0 : i + 1;
    else if (e.key === "ArrowUp") next = i === 0 ? last : i - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    if (next >= 0) {
      e.preventDefault();
      btns.current[next]?.focus();
    }
  };

  return (
    <div className="space-y-3">
      {FAQS.map((item, i) => {
        const isOpen = open === i;
        const btnId = `${base}-b${i}`;
        const panelId = `${base}-p${i}`;
        return (
          <div
            key={item.q}
            className={`rounded-xl border bg-[#0B241C] transition-colors duration-200 ease-out ${
              isOpen ? "border-[#3DD189]/60" : "border-[#173D30]"
            }`}
          >
            <h3>
              <button
                ref={(el) => {
                  btns.current[i] = el;
                }}
                id={btnId}
                type="button"
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => setOpen(isOpen ? null : i)}
                onKeyDown={(e) => onKey(e, i)}
                className={`flex min-h-[44px] w-full items-center justify-between gap-4 rounded-xl p-4 text-right text-base font-bold text-white ${focusRing}`}
              >
                <span>{item.q}</span>
                <Plus
                  aria-hidden="true"
                  className={`h-5 w-5 shrink-0 text-[#3DD189] transition-transform duration-200 ease-out ${
                    isOpen ? "rotate-45" : ""
                  }`}
                />
              </button>
            </h3>
            <div id={panelId} role="region" aria-labelledby={btnId} hidden={!isOpen}>
              <p className="px-4 pb-4 text-sm font-normal leading-7 text-[#8B9E96]">{item.a}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function LandingPage() {
  const base = import.meta.env.BASE_URL;

  return (
    <div dir="rtl" className="min-h-screen overflow-x-clip bg-[#061A14] font-body text-white">
      <header className="sticky top-0 z-40 border-b border-[#173D30] bg-[#061A14]/90 backdrop-blur-md">
        <nav aria-label="التنقل الرئيسي" className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4 md:px-6">
          <a href="#/" className={`flex min-h-[44px] items-center gap-2 rounded-lg ${focusRing}`}>
            <img src={`${base}logo.png`} alt="" className="h-8 w-8" />
            <span className="text-lg font-bold">إدارة سوشيال</span>
          </a>
          <div className="flex items-center gap-2">
            <a
              href="#pricing"
              className={`hidden min-h-[44px] items-center rounded-lg px-3 text-sm text-[#8B9E96] transition-colors duration-200 ease-out hover:text-white sm:inline-flex ${focusRing}`}
            >
              الأسعار
            </a>
            <a
              href={CTA_LOGIN}
              className={`inline-flex min-h-[44px] items-center rounded-lg border border-[#173D30] bg-[#0B241C] px-4 text-sm font-bold text-white transition-colors duration-200 ease-out hover:border-[#3DD189] ${focusRing}`}
            >
              تسجيل الدخول
            </a>
          </div>
        </nav>
      </header>

      <main className="pb-[calc(2rem+env(safe-area-inset-bottom))]">
        {/* Hero */}
        <section aria-labelledby="hero-title" className="mx-auto max-w-6xl px-4 pb-12 pt-8 md:px-6 md:pb-16 md:pt-16">
          <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-[#173D30] bg-[#0B241C] px-3 py-2 text-xs text-[#8B9E96]">
            <span className="rounded-full bg-[#0F2E24] px-2 py-1 font-bold text-[#3DD189]" dir="ltr">
              Meta
            </span>
            يعمل مع واتساب وإنستغرام وفيسبوك
          </p>
          <h1 id="hero-title" className="max-w-3xl text-3xl font-bold leading-[1.4] md:text-5xl md:leading-[1.3]">
            موظف خدمة عملاء
            <span className="text-[#3DD189]"> يرد على رسائل زبائنك </span>
            بمعلومات مشروعك أنت
          </h1>
          <p className="mt-4 max-w-xl text-base font-normal leading-8 text-[#8B9E96]">
            اربط قنواتك، وأضف معلوماتك، ودعه يجيب على الأسعار والمواعيد والموقع. وإذا لم يعرف الجواب يحوّل المحادثة إليك.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <a
              href={CTA_START}
              className={`inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl bg-[#3DD189] px-6 text-base font-bold text-[#061A14] transition-colors duration-200 ease-out hover:bg-[#E5B54B] ${focusRing}`}
            >
              جرّب مجاناً
              <ArrowLeft aria-hidden="true" className="h-5 w-5" />
            </a>
            <a
              href="#pricing"
              className={`inline-flex min-h-[48px] items-center justify-center rounded-xl border border-[#173D30] bg-[#0B241C] px-6 text-base font-bold text-white transition-colors duration-200 ease-out hover:border-[#E5B54B] ${focusRing}`}
            >
              شاهد الأسعار
            </a>
          </div>
        </section>

        {/* Features */}
        <section aria-labelledby="features-title" className="mx-auto max-w-6xl px-4 py-12 md:px-6">
          <SectionTitle kicker="المميزات" title="كل ما تحتاجه ليرد موظفك صح" id="features-title" />
          <ul className="grid gap-3 sm:grid-cols-2 md:gap-4 lg:grid-cols-4">
            {FEATURES.map(({ icon: Icon, title, body }) => (
              <li key={title} className="rounded-xl border border-[#173D30] bg-[#0B241C] p-4">
                <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-[#0F2E24] text-[#3DD189]">
                  <Icon aria-hidden="true" className="h-5 w-5" />
                </span>
                <h3 className="mb-2 text-lg font-bold">{title}</h3>
                <p className="text-sm font-normal leading-7 text-[#8B9E96]">{body}</p>
              </li>
            ))}
          </ul>
        </section>

        {/* Pricing */}
        <section id="pricing" aria-labelledby="pricing-title" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-12 md:px-6">
          <SectionTitle kicker="الأسعار" title="اشحن اعتمادات بالدينار العراقي" id="pricing-title" />
          <ul className="grid gap-3 sm:grid-cols-2 md:gap-4 xl:grid-cols-5">
            {PLANS.map((p) => (
              <li
                key={p.id}
                className={`flex flex-col rounded-xl border bg-[#0B241C] p-4 ${p.featured ? "border-[#E5B54B]" : "border-[#173D30]"}`}
              >
                <div className="mb-4 flex min-h-[28px] items-center justify-between gap-2">
                  <h3 className="text-xl font-bold" dir="ltr">
                    {p.name}
                  </h3>
                  {p.featured && (
                    <span className="rounded-full bg-[#E5B54B] px-3 py-1 text-xs font-bold text-[#061A14]">الأشهر</span>
                  )}
                </div>
                <p className="text-2xl font-bold tabular-nums">
                  {nf.format(p.price)} <span className="text-sm font-normal text-[#8B9E96]">د.ع</span>
                </p>
                <p className="mt-1 text-sm font-normal text-[#8B9E96]">{p.hint}</p>
                <p className="my-4 flex items-center gap-2 border-t border-[#173D30] pt-4 text-sm">
                  <Check aria-hidden="true" className="h-4 w-4 shrink-0 text-[#3DD189]" />
                  <span className="tabular-nums">{nf.format(p.credits)} اعتماد</span>
                </p>
                <a
                  href={CTA_PAY}
                  aria-label={`اشحن باقة ${p.name}`}
                  className={`mt-auto inline-flex min-h-[44px] items-center justify-center rounded-xl px-4 text-base font-bold transition-colors duration-200 ease-out ${
                    p.featured
                      ? "bg-[#E5B54B] text-[#061A14] hover:bg-[#3DD189]"
                      : "border border-[#173D30] bg-[#0F2E24] text-white hover:border-[#3DD189]"
                  } ${focusRing}`}
                >
                  اشحن الآن
                </a>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs font-normal text-[#8B9E96]">اختيار الباقة وإتمام الدفع يتمان داخل لوحة التحكم بعد تسجيل الدخول.</p>
        </section>

        {/* FAQ */}
        <section id="faq" aria-labelledby="faq-title" className="mx-auto max-w-3xl scroll-mt-20 px-4 py-12 md:px-6">
          <SectionTitle kicker="الأسئلة" title="أسئلة شائعة" id="faq-title" />
          <Faq />
        </section>
      </main>

      <footer className="border-t border-[#173D30] px-4 py-6 md:px-6">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <ul className="flex flex-wrap gap-x-2 text-sm text-[#8B9E96]">
            {[
              { href: `${base}privacy.html`, label: "الخصوصية" },
              { href: "#pricing", label: "الأسعار" },
              { href: "#faq", label: "الأسئلة" },
              { href: CTA_LOGIN, label: "تسجيل الدخول" },
            ].map((l) => (
              <li key={l.label}>
                <a
                  href={l.href}
                  className={`inline-flex min-h-[44px] items-center rounded-lg px-3 transition-colors duration-200 ease-out hover:text-white ${focusRing}`}
                >
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
          <p className="px-3 text-xs font-normal text-[#8B9E96]">© 2026 إدارة سوشيال</p>
        </div>
      </footer>
    </div>
  );
}
