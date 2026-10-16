// ترجمة السلاسل الديناميكية (رسائل الخادم، أسماء القنوات...) — تُستدعى داخل دوال تملك lang
import { DICT, type Lang } from "./dict";

export function tr(lang: Lang, s: string): string {
  if (lang === "ar") return s;
  return DICT[s]?.en ?? s;
}

/** يستبدل كل مقطع عربي مطابق لمفتاح قاموس داخل نص مركّب. */
export function trMixed(lang: Lang, text: string): string {
  if (lang === "ar" || !text) return text;
  let out = text;
  const keys = Object.keys(DICT).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (!k || k.length < 2) continue;
    if (out.includes(k)) out = out.split(k).join(DICT[k].en);
  }
  return out;
}
