import { useState } from "react";
import { useReveal } from "../hooks/useReveal";
import { IconPlus, IconWhatsapp } from "./Icons";

const ITEMS = [
  {
    q: "هل الربط رسمي من ميتا؟",
    a: "الربط يتم عبر خاصية «الأجهزة المرتبطة» في واتساب — نفس طريقة ربط واتساب ويب على جهازك. وهي ليست قناة رسمية من Meta، وقد تقيّد واتساب أي رقم وفق تقديرها وسياساتها. لذلك ننصح برقم مخصص للموظف، وقراءة التفاصيل قبل الربط.",
  },
  {
    q: "ماذا لو سأل العميل عن شي ما عندك فيه معلومة؟",
    a: "هنا يتفوق ميلانو: بدل ما يخمّن أو يخترع، يقول بوضوح «ما عندي معلومات مؤكدة» ويعرض تحويل المحادثة لموظف بشري. كل سؤال عجز عنه يظهر لك في اللوحة، فتضيف المعلومة ويصير أدق مع الوقت.",
  },
  {
    q: "هل فيه اشتراك شهري؟",
    a: "لا. تدفع 99 ريال دفعة واحدة تشمل إنشاء الموظف وتدريبه + 1,000 رد ذكي. بعدها تشحن رصيداً فقط وقت ما تحتاج — والخصم يتم على الردود المسلّمة فعلاً، لا على المحاولات الفاشلة.",
  },
  {
    q: "كم يستغرق تجهيز الموظف؟",
    a: "من لحظة ما تدخل معلومات مشروعك إلى أول رد حقيقي على عميلك: أقل من 10 دقائق في الغالب. القراءة من قوقل ماب أو موقعك تتم تلقائياً، وتقدر تراجع البطاقة المعرفية وتعدّلها قبل الإطلاق.",
  },
  {
    q: "هل يقدر يحوّل المحادثة لموظف بشري؟",
    a: "نعم، وبثلاث طرق: إذا طلب العميل ذلك صراحة، إذا وصل لسؤال ما عنده فيه معلومة مؤكدة، أو إذا كانت الحالة حساسة (شكوى، استرجاع، قرار مالي). في كل الحالات يوقف الرد الآلي فوراً ويوصلك السياق كاملاً.",
  },
  {
    q: "هل يصلح للمتاجر الإلكترونية والعيادات؟",
    a: "نعم — أي مشروع عنده أسئلة متكررة: الأسعار، المواعيد، الموقع، التوصيل، سياسة الاسترجاع. ميلانو يرد من بياناتك أنت، فتفاصيل كل نشاط تنعكس في إجاباته بدقة.",
  },
];

export default function FAQ() {
  const ref = useReveal<HTMLElement>();
  const [open, setOpen] = useState<number | null>(0);

  return (
    <section id="faq" ref={ref} className="relative scroll-mt-24 py-20 lg:py-28">
      <div className="max-w-4xl mx-auto px-5 lg:px-8">
        <div className="text-center mb-12">
          <p data-reveal className="font-display font-bold text-oro text-lg mb-2">
            — قبل ما تسألنا
          </p>
          <h2 data-reveal style={{ transitionDelay: "80ms" }} className="font-display font-extrabold text-4xl sm:text-5xl text-bone">
            الأسئلة اللي توصلنا كل يوم
          </h2>
        </div>

        <div className="space-y-3">
          {ITEMS.map((item, i) => {
            const isOpen = open === i;
            return (
              <div
                key={item.q}
                data-reveal
                style={{ transitionDelay: `${i * 60}ms` }}
                className={`rounded-2xl border transition-all duration-400 overflow-hidden ${
                  isOpen ? "bg-moss/80 border-oro/40 shadow-[0_20px_50px_-25px_rgba(232,178,75,0.3)]" : "bg-pine/70 border-verde/15 hover:border-verde/35"
                }`}
              >
                <button
                  onClick={() => setOpen(isOpen ? null : i)}
                  className="w-full flex items-center justify-between gap-4 text-right px-5 sm:px-6 py-4.5"
                  aria-expanded={isOpen}
                >
                  <span className={`font-display font-bold text-base sm:text-lg transition-colors duration-300 ${isOpen ? "text-oro" : "text-bone"}`}>
                    {item.q}
                  </span>
                  <span
                    className={`w-8 h-8 rounded-full border flex items-center justify-center shrink-0 transition-all duration-400 ${
                      isOpen ? "bg-oro text-ink border-oro rotate-45" : "border-verde/30 text-verde"
                    }`}
                  >
                    <IconPlus className="w-4 h-4" />
                  </span>
                </button>
                <div
                  className={`grid transition-[grid-template-rows] duration-400 ease-out ${
                    isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
                  }`}
                >
                  <div className="overflow-hidden">
                    <p className="px-5 sm:px-6 pb-5 text-sm text-sage leading-8 max-w-2xl">{item.a}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div data-reveal className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-3 text-center">
          <p className="text-sm text-sage">سؤالك مو موجود؟ موظف ميلانو نفسه يرد عليك الآن:</p>
          <a
            href="#start"
            className="inline-flex items-center gap-2 bg-verde text-ink font-semibold text-sm px-5 py-2.5 rounded-full hover:bg-oro transition-colors duration-300 active:scale-95"
          >
            <IconWhatsapp className="w-4 h-4" />
            جرّب تسأله
          </a>
        </div>
      </div>
    </section>
  );
}
