// ═══════════════════════════════════════════════════════════════════════════════
// نظام تعدد اللغات — Context + تراكيب + حفظ الاختيار
// العربية RTL / الإنجليزية LTR، مع ضبط lang و dir على <html> فورًا.
// المفتاح في القاموس هو النص العربي الأصلي؛ t() يعيده كما هو في وضع العربية.
// ═══════════════════════════════════════════════════════════════════════════════

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { DICT, type Lang } from "./dict";

export type { Lang };

const STORAGE_KEY = "milan.lang";

function readStoredLang(): Lang {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "ar" || v === "en") return v;
  } catch {
    /* لا شيء */
  }
  return "ar";
}

/** يترجم نصًا عربيًا (مفتاح) إلى اللغة الحالية. السلاسل الديناميكية (رسائل الخادم/البريد) تمر كما هي. */
export function translate(lang: Lang, key: string): string {
  if (lang === "ar") return key;
  const entry = DICT[key];
  return entry ? entry.en : key;
}

interface LanguageApi {
  lang: Lang;
  dir: "rtl" | "ltr";
  isAr: boolean;
  setLang: (l: Lang) => void;
  toggle: () => void;
  /** ترجمة نص واحد */
  t: (key: string) => string;
  /** تركيب جملة من أجزاء: بعض الأجزاء مفاتيح قاموس وبعضها متغيرات ديناميكية */
  tx: (...parts: Array<string | number>) => string;
}

const LanguageContext = createContext<LanguageApi | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => readStoredLang());

  // ضبط html[lang] و html[dir] + حفظ الاختيار — يعملان قبل رسم الشاشة الأولى أيضًا
  useEffect(() => {
    const el = document.documentElement;
    el.lang = lang;
    el.dir = lang === "ar" ? "rtl" : "ltr";
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      /* لا شيء */
    }
  }, [lang]);

  const setLang = useCallback((l: Lang) => setLangState(l), []);
  const toggle = useCallback(
    () => setLangState((p) => (p === "ar" ? "en" : "ar")),
    []
  );

  const value = useMemo<LanguageApi>(() => {
    const t = (key: string) => translate(lang, key);
    const tx = (...parts: Array<string | number>) =>
      parts
        .map((p) => (typeof p === "number" ? String(p) : t(String(p))))
        .join("");
    return {
      lang,
      dir: lang === "ar" ? "rtl" : "ltr",
      isAr: lang === "ar",
      setLang,
      toggle,
      t,
      tx,
    };
  }, [lang, setLang, toggle]);

  return (
    <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
  );
}

export function useI18n(): LanguageApi {
  const ctx = useContext(LanguageContext);
  if (!ctx) {
    throw new Error("useI18n must be used inside <LanguageProvider>");
  }
  return ctx;
}

/** دوال تنسيق التواريخ حسب اللغة (تُستخدم في الواجهة فقط، لا في البيانات). */
export function fmtDateLocalized(dateStr: string, lang: Lang): string {
  try {
    return new Date(dateStr).toLocaleDateString(lang === "ar" ? "ar" : "en-GB");
  } catch {
    return dateStr;
  }
}
