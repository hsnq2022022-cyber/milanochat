// زر تبديل اللغة — يظهر في كل الصفحات (عبر الموقع نفسه وليس داخل iframe)
import { useI18n } from "../i18n/LanguageContext";

export default function LangToggle({ compact = false }: { compact?: boolean }) {
  const { lang, toggle } = useI18n();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={lang === "ar" ? "Switch to English" : "التبديل إلى العربية"}
      title={lang === "ar" ? "English" : "العربية"}
      className={`inline-flex items-center gap-1.5 rounded-full border font-bold transition-all duration-300 select-none ${
        compact
          ? "text-[10.5px] px-2.5 py-1 border-verde/25 text-sage hover:text-oro hover:border-oro/50 bg-night/60"
          : "text-xs px-3.5 py-1.5 border-oro/40 text-oro hover:bg-moss bg-night/70"
      }`}
    >
      <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M3.6 9h16.8M3.6 15h16.8M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
      </svg>
      <span dir="ltr">{lang === "ar" ? "EN" : "ع"}</span>
    </button>
  );
}
