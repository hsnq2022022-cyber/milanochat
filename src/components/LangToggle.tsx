// زر تبديل اللغة — قائمة منسدلة (عربية / English) مع أيقونة الكرة الأرضية.
// يظهر في الشريط العلوي وصفحة الدخول ولوحة التحكم؛ يعمل باللمس على الجوال.
import { useEffect, useRef, useState } from "react";
import { useI18n, type Lang } from "../i18n/LanguageContext";

const OPTIONS: Array<{ code: Lang; label: string }> = [
  { code: "ar", label: "العربية" },
  { code: "en", label: "English" },
];

export default function LangToggle({ compact = false }: { compact?: boolean }) {
  const { lang, setLang } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // إغلاق القائمة بالنقر خارجها أو بمفتاح Escape
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const globe = (
    <svg
      viewBox="0 0 24 24"
      className="w-4 h-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3.6 9h16.8M3.6 15h16.8M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
    </svg>
  );

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={lang === "ar" ? "تغيير اللغة" : "Change language"}
        title={lang === "ar" ? "تغيير اللغة" : "Change language"}
        className={`inline-flex items-center gap-1.5 rounded-full border font-bold transition-all duration-300 select-none cursor-pointer ${
          compact
            ? "text-[10.5px] px-2.5 py-1 border-verde/25 text-sage hover:text-oro hover:border-oro/50 bg-night/60"
            : "text-xs px-3 py-1.5 border-oro/40 text-oro hover:bg-moss bg-night/70"
        }`}
      >
        {globe}
        <span dir="ltr">{lang === "ar" ? "العربية" : "English"}</span>
        <svg
          viewBox="0 0 24 24"
          className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <ul
          role="listbox"
          aria-label={lang === "ar" ? "اختيار اللغة" : "Select language"}
          dir="ltr"
          className="absolute z-[100] mt-1 min-w-40 rounded-xl border border-verde/25 bg-night/95 backdrop-blur-md shadow-[0_18px_50px_-18px_rgba(0,0,0,0.7)] py-1 overflow-hidden ltr:left-0 rtl:right-0"
        >
          {OPTIONS.map((o) => {
            const active = o.code === lang;
            return (
              <li key={o.code} role="option" aria-selected={active}>
                <button
                  type="button"
                  onClick={() => {
                    setLang(o.code);
                    setOpen(false);
                  }}
                  className={`w-full flex items-center justify-between gap-3 px-4 py-2.5 text-sm font-semibold transition-colors cursor-pointer ${
                    active
                      ? "text-oro bg-moss/70"
                      : "text-sage hover:text-bone hover:bg-moss/50"
                  }`}
                >
                  <span>{o.label}</span>
                  {active && (
                    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
                      <path d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
