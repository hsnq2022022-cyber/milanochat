import { useEffect, useRef, useState } from "react";
import confetti from "canvas-confetti";
import {
  getCountries,
  getCountryCallingCode,
  getExampleNumber,
  isValidPhoneNumber,
  parsePhoneNumberFromString,
  formatIncompletePhoneNumber,
  type CountryCode,
} from "libphonenumber-js";
import { useCountUp, useInView, useReveal } from "../hooks/useReveal";
import { api, apiEnabled, apiFetch, type QAPair, type SemanticTestRes, type WaSnapshot } from "../lib/api";
import {
  IconArrowStart,
  IconBolt,
  IconCheck,
  IconChevronDown,
  IconGlobe,
  IconInfinity,
  IconMapPin,
  IconPen,
  IconPlus,
  IconSave,
  IconShieldCheck,
  IconTrash,
  IconSparkle,
  IconWhatsapp,
  Logo,
} from "./Icons";

/* ============================ أداة الربط ============================ */

type Source = "map" | "site" | "manual";
type Phase = "form" | "working" | "qa" | "done" | "pay" | "paid" | "link";

const SOURCES: { id: Source; label: string; desc: string; icon: (c: string) => JSX.Element }[] = [
  { id: "map", label: "قوقل ماب", desc: "محل له موقع على الخريطة", icon: (c) => <IconMapPin className={c} /> },
  { id: "site", label: "موقع أو متجر", desc: "منه يعرف الأسعار والتفاصيل", icon: (c) => <IconGlobe className={c} /> },
  { id: "manual", label: "أدخلها يدوياً", desc: "اكتب معلومات مشروعك بنفسك", icon: (c) => <IconPen className={c} /> },
];

const WORK_STEPS = [
  "نقرأ معلومات مشروعك من المصدر",
  "نبني البطاقة المعرفية لميلانو",
  "ندرّبه على لهجة عملائك",
  "نجهّز خط الواتساب للربط",
];

const inputCls =
  "w-full bg-night/70 border border-verde/20 rounded-xl px-4 py-3 text-sm text-bone placeholder:text-sage/45 focus:outline-none focus:border-oro/70 focus:ring-2 focus:ring-oro/20 transition-all duration-300";
const labelCls = "block text-xs font-semibold text-sage mb-1.5";
const errCls = "text-[11px] text-oro-soft mt-1.5 flex items-center gap-1";

/* ============================ الميزة 4: حقل الرقم مع رمز الدولة ============================ */

const ARAB_PRIORITY: CountryCode[] = [
  "SA", "AE", "KW", "QA", "BH", "OM", "IQ", "JO", "EG", "PS", "LB", "SY", "YE", "MA", "DZ", "TN", "LY", "SD",
];
const NAME_OVERRIDES: Partial<Record<string, string>> = {
  SA: "السعودية", AE: "الإمارات", KW: "الكويت", QA: "قطر", BH: "البحرين", OM: "عُمان",
  IQ: "العراق", JO: "الأردن", EG: "مصر", PS: "فلسطين", LB: "لبنان", SY: "سوريا",
  YE: "اليمن", MA: "المغرب", DZ: "الجزائر", TN: "تونس", LY: "ليبيا", SD: "السودان",
};
const regionNames =
  typeof Intl !== "undefined" && (Intl as any).DisplayNames
    ? new (Intl as any).DisplayNames(["ar"], { type: "region" })
    : null;
const countryName = (cc: CountryCode): string => NAME_OVERRIDES[cc] ?? regionNames?.of(cc) ?? cc;
const countryFlag = (cc: string) =>
  cc.toUpperCase().replace(/./g, (ch) => String.fromCodePoint(127397 + ch.charCodeAt(0)));
const exampleFor = (cc: CountryCode): string => {
  try {
    return ((getExampleNumber as any)(cc)?.formatNational() as string | undefined) ?? "";
  } catch {
    return "";
  }
};

type CountryOption = { code: CountryCode; dial: string };
const COUNTRY_LIST: CountryOption[] = (() => {
  const rest = getCountries()
    .filter((c) => !ARAB_PRIORITY.includes(c))
    .sort((a, b) => countryName(a).localeCompare(countryName(b), "ar"));
  return [...ARAB_PRIORITY, ...rest].map((code) => ({ code, dial: getCountryCallingCode(code) }));
})();

function PhoneField({
  country,
  onCountry,
  value,
  onChange,
  error,
}: {
  country: CountryCode;
  onCountry: (c: CountryCode) => void;
  value: string;
  onChange: (v: string) => void;
  error?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const qt = q.trim();
  const qd = qt.replace(/\D/g, "");
  const filtered = qt
    ? COUNTRY_LIST.filter(
        (c) =>
          countryName(c.code).includes(qt) ||
          c.code.toLowerCase().includes(qt.toLowerCase()) ||
          (qd !== "" && c.dial.startsWith(qd))
      )
    : COUNTRY_LIST;

  return (
    <div>
      <label className={labelCls}>رقم واتساب الموظف *</label>
      <div className="flex gap-2" ref={ref}>
        {/* قائمة الدول: علم + اسم عربي + رمز دولي */}
        <div className="relative shrink-0 self-stretch">
          <button
            type="button"
            onClick={() => {
              setOpen((o) => !o);
              setQ("");
            }}
            aria-haspopup="listbox"
            aria-expanded={open}
            className={`h-full flex items-center gap-1.5 bg-night/70 border rounded-xl px-3 text-sm text-bone transition-all duration-300 ${
              open || error ? "border-oro/70 ring-2 ring-oro/20" : "border-verde/20 hover:border-verde/40"
            }`}
          >
            <span aria-hidden="true">{countryFlag(country)}</span>
            <span dir="ltr" className="font-semibold tabular-nums">+{getCountryCallingCode(country)}</span>
            <IconChevronDown
              className={`w-3.5 h-3.5 text-sage transition-transform duration-300 ${open ? "rotate-180" : ""}`}
            />
          </button>
          {open && (
            <div className="absolute z-30 top-full mt-2 start-0 w-72 bg-pine border border-verde/25 rounded-2xl shadow-[0_30px_70px_-20px_rgba(0,0,0,0.8)] overflow-hidden msg-in">
              <div className="p-2.5 border-b border-verde/15">
                <input
                  autoFocus
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="ابحث عن دولة أو رمز…"
                  className="w-full bg-night/70 border border-verde/15 rounded-lg px-3 py-2 text-xs text-bone placeholder:text-sage/45 focus:outline-none focus:border-oro/60"
                />
              </div>
              <ul role="listbox" className="qa-scroll max-h-56 overflow-y-auto py-1.5">
                {filtered.length === 0 && <li className="px-4 py-3 text-xs text-sage/60">لا نتائج</li>}
                {filtered.map((c) => {
                  const sel = c.code === country;
                  return (
                    <li key={c.code}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={sel}
                        onClick={() => {
                          onCountry(c.code);
                          setOpen(false);
                        }}
                        className={`w-full flex items-center gap-2.5 px-3.5 py-2 text-right text-[13px] transition-colors duration-150 ${
                          sel ? "bg-moss text-bone" : "text-mist hover:bg-night/60"
                        }`}
                      >
                        <span aria-hidden="true">{countryFlag(c.code)}</span>
                        <span className="flex-1 truncate">{countryName(c.code)}</span>
                        <span dir="ltr" className="text-[11px] text-sage tabular-nums">+{c.dial}</span>
                        {sel && (
                          <span className="text-verde">
                            <IconCheck className="w-3.5 h-3.5" />
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
        {/* الرقم الوطني بتنسيق تلقائي أثناء الكتابة */}
        <input
          dir="ltr"
          inputMode="tel"
          value={value}
          onChange={(e) => onChange(formatIncompletePhoneNumber(e.target.value, country))}
          placeholder={exampleFor(country) || "5X XXX XXXX"}
          className={`${inputCls} text-left ${error ? "border-oro/70" : ""}`}
        />
      </div>
      {error ? (
        <p className={errCls}>{error}</p>
      ) : (
        <p className="text-[11px] text-sage/70 mt-1.5" dir="auto">
          يُحفظ بالصيغة الدولية الكاملة E.164 — مثال: <span dir="ltr">+{getCountryCallingCode(country)} {exampleFor(country)}</span>
        </p>
      )}
    </div>
  );
}

function Wizard() {
  const [source, setSource] = useState<Source>("map");
  const [phase, setPhase] = useState<Phase>("form");
  const [reseller, setReseller] = useState(false);
  const [workStep, setWorkStep] = useState(0);

  const [mapUrl, setMapUrl] = useState("");
  const [siteUrl, setSiteUrl] = useState("");
  const [bizName, setBizName] = useState("");
  const [bizActivity, setBizActivity] = useState("");
  const [bizAddress, setBizAddress] = useState("");
  const [bizHours, setBizHours] = useState("");
  /* الميزة 4: دولة + رقم وطني، والتخزين النهائي E.164 */
  const [country, setCountry] = useState<CountryCode>("SA");
  const [phoneNat, setPhoneNat] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  /* ── حالة الخادم الحقيقي (تعمل فقط عند ضبط VITE_API_URL) ── */
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [apiResult, setApiResult] = useState<null | { ok: true } | { ok: false; error: string }>(null);
  /* ربط واتساب الحقيقي: الحالة تأتي من جلسة Baileys في الخادم عبر SSE */
  const EMPTY_WA: WaSnapshot = { sessionId: "", state: "DISCONNECTED", qrDataUrl: null, phone: null, error: null };
  const [waSnap, setWaSnap] = useState<WaSnapshot>(EMPTY_WA);
  const [claimTok, setClaimTok] = useState<string | null>(null);
  const sseRef = useRef<EventSource | null>(null);
  const pollRef = useRef<number | null>(null);
  const waBusyRef = useRef(false);
  const [payUrl, setPayUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reconnects = useRef(0);

  /* ── الميزة 2: أسئلة وأجوبة مولدة من الرابط ── */
  const [qaPairs, setQaPairs] = useState<QAPair[]>([]);
  const [qaSourceUrl, setQaSourceUrl] = useState<string | null>(null);
  const [qaTitle, setQaTitle] = useState("");
  const [qaSaving, setQaSaving] = useState(false);
  const [suggestManual, setSuggestManual] = useState(false);

  /* ── الميزة 3: مختبر الفهم الدلالي ── */
  const [testerQuery, setTesterQuery] = useState("");
  const [testerBusy, setTesterBusy] = useState(false);
  const [testerResult, setTesterResult] = useState<SemanticTestRes | null>(null);
  const [testerErr, setTesterErr] = useState("");
  const [barsIn, setBarsIn] = useState(false);

  const manualText = () =>
    [
      bizName.trim() && `اسم المشروع: ${bizName.trim()}`,
      bizActivity.trim() && `النشاط: ${bizActivity.trim()}`,
      bizAddress.trim() && `العنوان: ${bizAddress.trim()}`,
      bizHours.trim() && `أوقات العمل: ${bizHours.trim()}`,
      parsePhoneNumberFromString(phoneNat.replace(/\D/g, ""), country) &&
        `رقم الواتساب: ${parsePhoneNumberFromString(phoneNat.replace(/\D/g, ""), country)!.number}`,
    ]
      .filter(Boolean)
      .join("\n");

  /* تقدم خطوات الإنشاء — ينتظر اكتمال الخادم الفعلي قبل الانتقال */
  useEffect(() => {
    if (phase !== "working") return;
    if (workStep >= WORK_STEPS.length) {
      if (apiEnabled && !apiResult) return; // ننتظر رد الخادم
      if (apiEnabled && apiResult && !apiResult.ok) {
        setErrors({ api: apiResult.error });
        setPhase("form");
        return;
      }
      const t = setTimeout(() => {
        if (apiEnabled && qaPairs.length > 0) {
          setPhase("qa"); // المالك يراجع الأسئلة والأجوبة المولدة قبل الحفظ
        } else {
          setPhase("done");
          confetti({
            particleCount: 130,
            spread: 75,
            origin: { y: 0.35 },
            colors: ["#2ec27e", "#e8b24b", "#eff3ea", "#178a57"],
          });
        }
      }, 450);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setWorkStep((s) => s + 1), 820);
    return () => clearTimeout(t);
  }, [phase, workStep, apiResult, qaPairs]);

  const stopWaStreams = () => {
    sseRef.current?.close();
    sseRef.current = null;
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  /* إغلاق البث عند مغادرة شاشة الربط أو فك المكوّن */
  useEffect(() => {
    if (phase === "link") return;
    stopWaStreams();
  }, [phase]);
  useEffect(() => stopWaStreams, []);

  /* تطبيق حدث قادم من جلسة واتساب (SSE أو الاستطلاع الاحتياطي) */
  const applyWaEvent = (snap: WaSnapshot) => {
    setWaSnap((prev) => {
      if (snap.state === "CONNECTED" && prev.state !== "CONNECTED") {
        confetti({ particleCount: 90, spread: 80, origin: { y: 0.4 }, colors: ["#2ec27e", "#e8b24b"] });
      }
      return snap;
    });
    // انتهى الربط من الجوال (LOGGED_OUT) → جلسة جديدة وQR جديد تلقائياً دون تحديث الصفحة
    if (snap.state === "LOGGED_OUT" && reconnects.current < 3 && !waBusyRef.current) {
      reconnects.current += 1;
      window.setTimeout(() => relink(), 1200);
    }
  };

  /* فتح بث SSE للجلسة، مع استطلاع احتياطي إن تعذّر البث */
  const connectWaStream = (sessionId: string, tok: string | null) => {
    stopWaStreams();
    let failures = 0;
    const es = new EventSource(api.wa.eventsUrl(sessionId, tok));
    sseRef.current = es;
    es.onmessage = (m) => {
      try {
        failures = 0;
        applyWaEvent(JSON.parse(m.data) as WaSnapshot);
      } catch {
        /* رسالة غير صالحة — نتجاهلها */
      }
    };
    es.onerror = () => {
      failures += 1;
      if (failures >= 3) {
        es.close();
        sseRef.current = null;
        pollRef.current = window.setInterval(async () => {
          try {
            applyWaEvent(await api.wa.getQr(sessionId, tok));
          } catch {
            /* إعادة المحاولة في الدورة التالية */
          }
        }, 2500);
      }
    };
  };

  /* إنشاء جلسة حقيقية في الخادم وفتح البث — React لا ينشئ أي جلسة بنفسه */
  const relink = async () => {
    if (!tenantId || waBusyRef.current) return;
    waBusyRef.current = true;
    setWaSnap({ ...EMPTY_WA, state: "CONNECTING" });
    const tok = claimTok ?? localStorage.getItem("milano_claim");
    try {
      const snap = await api.wa.createSession(tenantId, tok);
      connectWaStream(snap.sessionId, tok);
    } catch {
      setWaSnap({
        ...EMPTY_WA,
        state: "ERROR",
        error: "تعذر إنشاء جلسة واتساب، تحقق من اتصال الخادم.",
      });
    }
    waBusyRef.current = false;
  };

  const urlOk = (v: string) => /^https?:\/\/\S+\.\S+/.test(v.trim());

  const submit = () => {
    const e: Record<string, string> = {};
    if (source === "map" && !mapUrl.trim()) e.mapUrl = "حط رابط مشروعك في قوقل ماب";
    if (source === "map" && mapUrl.trim() && !urlOk(mapUrl)) e.mapUrl = "الرابط ما يبدو صحيحاً — يبدأ بـ http";
    if (source === "site" && !siteUrl.trim()) e.siteUrl = "حط رابط موقعك أو متجرك";
    if (source === "site" && siteUrl.trim() && !urlOk(siteUrl)) e.siteUrl = "الرابط ما يبدو صحيحاً — يبدأ بـ http";
    if (source === "manual") {
      if (!bizName.trim()) e.bizName = "اكتب اسم المشروع";
      if (!bizActivity.trim()) e.bizActivity = "اكتب نشاط المشروع (مثال: كافيه مختص)";
    }
    /* الميزة 4: تحقق ديناميكي حسب الدولة المختارة (لكل دولة طول وصيغة مختلفة) */
    const natDigits = phoneNat.replace(/\D/g, "");
    if (!natDigits || !isValidPhoneNumber(natDigits, country)) {
      const ex = exampleFor(country);
      e.waNumber = `الرقم غير صحيح لـ${countryName(country)}${ex ? ` — الصيغة المتوقعة مثل: ${ex}` : ""}`;
    }
    setErrors(e);
    if (Object.keys(e).length !== 0) return;

    setWorkStep(0);
    setPhase("working");
    setApiResult(null);
    setPayUrl(null);
    setQaPairs([]);
    setQaSourceUrl(null);
    setQaTitle("");
    if (!apiEnabled) return; // وضع العرض التجريبي بدون خادم

    (async () => {
      try {
        const fallbackName = (source === "map" ? mapUrl : siteUrl).replace(/^https?:\/\//, "").split("/")[0];
        const e164 = parsePhoneNumberFromString(natDigits, country)?.number;
        const created = await api.createTenant(
          bizName.trim() || fallbackName || "مشروع جديد",
          source === "map" ? "gmaps" : source === "site" ? "website" : "manual",
          source === "map" ? mapUrl.trim() : siteUrl.trim(),
          e164
        );
        setTenantId(created.tenantId);
        setClaimTok(created.claimToken); // يصرّح لجلسة واتساب الخاصة بهذا المشروع فقط
        localStorage.setItem("milano_claim", created.claimToken); // لضم الحساب للوحة التحكم لاحقاً
        if (source === "manual") {
          const ing = await api.ingestText(created.tenantId, manualText());
          if (ing.status === "failed")
            throw new Error(ing.error || "تعذّر فهرسة المصدر — جرّب الإدخال اليدوي");
        } else {
          // الميزة 2: توليد أسئلة وأجوبة من الرابط ومراجعتها قبل الحفظ
          const srcUrl = (source === "map" ? mapUrl : siteUrl).trim();
          const { pairs, title } = await api.extractQA(created.tenantId, srcUrl);
          setQaPairs(pairs);
          setQaSourceUrl(srcUrl);
          setQaTitle(title);
        }
        setSuggestManual(false);
        setApiResult({ ok: true });
      } catch (err: any) {
        setSuggestManual(source !== "manual");
        setApiResult({ ok: false, error: err?.message || "تعذر الاتصال بالخادم — تأكد أنه يعمل" });
      }
    })();
  };

  /* بدء جلسة واتساب الحقيقية وعرض شاشة الربط */
  const startLink = async () => {
    if (!tenantId) return;
    reconnects.current = 0;
    setBusy(true);
    setPhase("link");
    await relink();
    setBusy(false);
  };

  /* إنشاء فاتورة Moyasar وفتح صفحة الدفع — التفعيل يتم من الـ webhook */
  const startPay = async () => {
    if (!tenantId) return;
    setBusy(true);
    try {
      const res = await apiFetch<{ paymentUrl: string | null }>("/api/payments/create", {
        method: "POST",
        body: JSON.stringify({ tenantId, packageId: "starter" }),
      });
      if (res.paymentUrl) {
        window.open(res.paymentUrl, "_blank", "noopener");
        setPayUrl(res.paymentUrl);
      }
    } catch (err: any) {
      setErrors((prev) => ({ ...prev, pay: err?.message || "تعذر إنشاء الفاتورة" }));
    }
    setBusy(false);
  };

  /* ── الميزة 2: مراجعة الأسئلة والأجوبة وحفظها ── */
  const updatePair = (idx: number, field: "question" | "answer", value: string) =>
    setQaPairs((ps) => ps.map((p, i) => (i === idx ? { ...p, [field]: value } : p)));
  const deletePair = (idx: number) => setQaPairs((ps) => ps.filter((_, i) => i !== idx));
  const addPair = () => setQaPairs((ps) => [...ps, { question: "", answer: "" }]);

  const saveQA = async () => {
    if (!tenantId) return;
    const valid = qaPairs.filter((p) => p.question.trim() && p.answer.trim());
    if (valid.length === 0) {
      setErrors((prev) => ({ ...prev, qa: "أضف سؤالاً واحداً كاملاً على الأقل قبل الحفظ" }));
      return;
    }
    setQaSaving(true);
    setErrors((prev) => {
      const next = { ...prev };
      delete next.qa;
      return next;
    });
    try {
      await api.saveQA(tenantId, valid, qaSourceUrl);
      confetti({
        particleCount: 110,
        spread: 80,
        origin: { y: 0.35 },
        colors: ["#2ec27e", "#e8b24b", "#eff3ea"],
      });
      setPhase("done");
    } catch (err: any) {
      setErrors((prev) => ({ ...prev, qa: err?.message || "تعذر الحفظ — أعد المحاولة" }));
    }
    setQaSaving(false);
  };

  /* الميزة 3: تجربة صياغة مختلفة عبر المسار الدلالي الكامل */
  const runTest = async () => {
    if (!tenantId || !testerQuery.trim() || testerBusy) return;
    setTesterBusy(true);
    setTesterErr("");
    setTesterResult(null);
    setBarsIn(false);
    try {
      const res = await api.testQA(tenantId, testerQuery.trim());
      setTesterResult(res);
      requestAnimationFrame(() => setTimeout(() => setBarsIn(true), 40));
    } catch (err: any) {
      setTesterErr(err?.message || "تعذر الاختبار — تأكد من تشغيل الخادم");
    }
    setTesterBusy(false);
  };

  const reset = () => {
    setPhase("form");
    setErrors({});
    setWorkStep(0);
    setApiResult(null);
    setPayUrl(null);
    reconnects.current = 0;
    setQaPairs([]);
    setQaSourceUrl(null);
    setQaTitle("");
    setSuggestManual(false);
    stopWaStreams();
    setWaSnap(EMPTY_WA);
  };

  const sourceLabel = SOURCES.find((s) => s.id === source)?.label ?? "";

  return (
    <div id="start" className="relative scroll-mt-28">
      {/* توهج خلف البطاقة */}
      <div className="absolute -inset-6 bg-[radial-gradient(60%_60%_at_50%_40%,rgba(46,194,126,0.16),transparent_70%)] pointer-events-none" />

      <div className="relative bg-pine/90 border border-verde/20 rounded-3xl p-6 sm:p-7 shadow-[0_40px_90px_-30px_rgba(0,0,0,0.7)] overflow-hidden">
        <div className="absolute top-0 inset-x-0 h-1 bg-gradient-to-l from-verde via-oro to-transparent" />

        {phase === "form" && (
          <>
            <div className="flex items-center justify-between gap-3 mb-5">
              <h2 className="font-display font-bold text-xl text-bone">
                من وين نسحب معلومات المشروع؟
              </h2>
              <span className="text-oro">
                <IconSparkle className="w-5 h-5" />
              </span>
            </div>

            {/* اختيار المصدر */}
            <div className="grid grid-cols-3 gap-2 mb-5" role="tablist" aria-label="مصدر معلومات المشروع">
              {SOURCES.map((s) => {
                const active = source === s.id;
                return (
                  <button
                    key={s.id}
                    role="tab"
                    aria-selected={active}
                    onClick={() => {
                      setSource(s.id);
                      setErrors({});
                    }}
                    className={`text-right rounded-2xl border p-3 transition-all duration-300 active:scale-95 ${
                      active
                        ? "border-oro/80 bg-moss shadow-[0_10px_30px_-12px_rgba(232,178,75,0.35)] -translate-y-0.5"
                        : "border-verde/15 bg-night/50 hover:border-verde/40 hover:bg-night/80"
                    }`}
                  >
                    <span className={active ? "text-oro" : "text-verde"}>{s.icon("w-5 h-5")}</span>
                    <span className={`block text-[13px] font-bold mt-1.5 ${active ? "text-bone" : "text-mist"}`}>
                      {s.label}
                    </span>
                    <span className="block text-[10.5px] text-sage leading-4 mt-0.5">{s.desc}</span>
                  </button>
                );
              })}
            </div>

            {/* الحقول حسب المصدر */}
            <div className="space-y-4">
              {(source === "map" || source === "site") && (
                <>
                  {source === "map" && (
                    <div>
                      <label className={labelCls}>رابط مشروعك في Google Maps *</label>
                      <input
                        dir="ltr"
                        value={mapUrl}
                        onChange={(e) => setMapUrl(e.target.value)}
                        placeholder="https://maps.app.goo.gl/..."
                        className={`${inputCls} text-left ${errors.mapUrl ? "border-oro/70" : ""}`}
                      />
                      {errors.mapUrl && <p className={errCls}>{errors.mapUrl}</p>}
                    </div>
                  )}
                  <div>
                    <label className={labelCls}>
                      {source === "site" ? "رابط موقعك أو متجرك *" : "رابط موقعك أو متجرك — اختياري"}
                    </label>
                    <input
                      dir="ltr"
                      value={siteUrl}
                      onChange={(e) => setSiteUrl(e.target.value)}
                      placeholder="https://your-store.com"
                      className={`${inputCls} text-left ${errors.siteUrl ? "border-oro/70" : ""}`}
                    />
                    <p className="text-[11px] text-sage/70 mt-1.5">
                      لو عندك موقع أو متجر، منه يعرف الموظف الأسعار والتفاصيل.
                    </p>
                    {errors.siteUrl && <p className={errCls}>{errors.siteUrl}</p>}
                  </div>
                </>
              )}

              {source === "manual" && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={labelCls}>اسم المشروع *</label>
                      <input
                        value={bizName}
                        onChange={(e) => setBizName(e.target.value)}
                        placeholder="كافيه ميلانو"
                        className={`${inputCls} ${errors.bizName ? "border-oro/70" : ""}`}
                      />
                      {errors.bizName && <p className={errCls}>{errors.bizName}</p>}
                    </div>
                    <div>
                      <label className={labelCls}>نوع النشاط *</label>
                      <input
                        value={bizActivity}
                        onChange={(e) => setBizActivity(e.target.value)}
                        placeholder="كافيه مختص"
                        className={`${inputCls} ${errors.bizActivity ? "border-oro/70" : ""}`}
                      />
                      {errors.bizActivity && <p className={errCls}>{errors.bizActivity}</p>}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={labelCls}>العنوان</label>
                      <input
                        value={bizAddress}
                        onChange={(e) => setBizAddress(e.target.value)}
                        placeholder="الرياض — حي الياسمين"
                        className={inputCls}
                      />
                    </div>
                    <div>
                      <label className={labelCls}>أوقات العمل</label>
                      <input
                        value={bizHours}
                        onChange={(e) => setBizHours(e.target.value)}
                        placeholder="يومياً 7ص – 1م"
                        className={inputCls}
                      />
                    </div>
                  </div>
                </>
              )}

              <PhoneField
                country={country}
                onCountry={setCountry}
                value={phoneNat}
                onChange={setPhoneNat}
                error={errors.waNumber}
              />

              {/* تبديل الوكيل */}
              <button
                onClick={() => setReseller((v) => !v)}
                className="w-full flex items-center justify-between gap-3 bg-night/50 border border-verde/15 rounded-xl px-4 py-3 hover:border-verde/35 transition-colors"
                aria-pressed={reseller}
              >
                <span className="text-[13px] text-mist">أنا أبيع الأداة لعملائي</span>
                <span
                  className={`relative w-10 h-5.5 rounded-full transition-colors duration-300 ${
                    reseller ? "bg-verde" : "bg-moss"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 w-4.5 h-4.5 rounded-full bg-bone transition-all duration-300 ${
                      reseller ? "start-5" : "start-0.5"
                    }`}
                  />
                </span>
              </button>

              {errors.api && (
                <div className="bg-night/60 border border-oro/25 rounded-xl px-3.5 py-2.5">
                  <p className="text-[11px] leading-5 text-oro-soft">{errors.api}</p>
                  {suggestManual && (
                    <button
                      onClick={() => {
                        setSource("manual");
                        setErrors({});
                        setSuggestManual(false);
                      }}
                      className="mt-2 text-[11.5px] font-bold text-verde hover:text-oro underline underline-offset-4 transition-colors duration-200"
                    >
                      أو أدخل معلومات مشروعك يدوياً
                    </button>
                  )}
                </div>
              )}

              <button
                onClick={submit}
                className="w-full group flex items-center justify-center gap-2.5 bg-verde text-ink font-display font-bold text-lg py-3.5 rounded-2xl hover:bg-oro transition-all duration-300 active:scale-[0.98] hover:shadow-[0_16px_40px_-12px_rgba(232,178,75,0.45)]"
              >
                {reseller ? "أنشئ موظف لعميلك" : "ابدأ الآن"}
                <span className="transition-transform duration-300 group-hover:-translate-x-1">
                  <IconArrowStart className="w-5 h-5" />
                </span>
              </button>

              <p className="text-[11px] leading-5 text-sage/75 border-t border-verde/10 pt-3.5">
                الربط يتم عبر خاصية «الأجهزة المرتبطة» في واتساب — وهي ليست قناة رسمية من Meta، وقد تقيّد واتساب أي
                رقم وفق تقديرها.{" "}
                <a href="#faq" className="text-oro-soft underline underline-offset-2 hover:text-oro">
                  اقرأ التفاصيل قبل الربط
                </a>
              </p>
            </div>
          </>
        )}

        {/* مرحلة الإنشاء */}
        {phase === "working" && (
          <div className="py-6">
            <div className="flex items-center gap-3 mb-6">
              <span className="text-verde">
                <Logo className="w-10 h-10 animate-pulse" />
              </span>
              <div>
                <h2 className="font-display font-bold text-xl text-bone">جارٍ إنشاء موظف ميلانو…</h2>
                <p className="text-xs text-sage">المصدر: {sourceLabel}</p>
              </div>
            </div>
            <ul className="space-y-3.5">
              {WORK_STEPS.map((step, i) => {
                const doneStep = i < workStep;
                const activeStep = i === workStep;
                return (
                  <li key={step} className="flex items-center gap-3">
                    <span
                      className={`w-7 h-7 rounded-full flex items-center justify-center border transition-all duration-500 shrink-0 ${
                        doneStep
                          ? "bg-verde border-verde text-ink"
                          : activeStep
                            ? "border-oro text-oro shimmer"
                            : "border-verde/20 text-sage/40"
                      }`}
                    >
                      {doneStep ? <IconCheck className="w-3.5 h-3.5" /> : <span className="text-[11px] font-bold">{i + 1}</span>}
                    </span>
                    <span className={`text-sm transition-colors duration-500 ${doneStep ? "text-mist" : activeStep ? "text-bone font-semibold" : "text-sage/50"}`}>
                      {step}
                    </span>
                  </li>
                );
              })}
            </ul>
            <div className="mt-7 h-1.5 rounded-full bg-night/70 overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-l from-verde to-oro transition-all duration-700 ease-out"
                style={{ width: `${Math.min((workStep / WORK_STEPS.length) * 100, 100)}%` }}
              />
            </div>
          </div>
        )}

        {/* مرحلة الميزة 2: مراجعة الأسئلة والأجوبة المولدة */}
        {phase === "qa" && (
          <div className="msg-in">
            <div className="flex items-center justify-between gap-3 mb-1.5">
              <h2 className="font-display font-bold text-xl text-bone">راجع قاعدة المعرفة</h2>
              <span className="text-[11px] font-bold text-verde bg-verde/10 border border-verde/30 rounded-full px-2.5 py-1 whitespace-nowrap tabular-nums">
                {qaPairs.length} {qaPairs.length === 1 ? "زوج" : "أزواج"} سؤال وجواب
              </span>
            </div>
            <p className="text-[11.5px] text-sage leading-5 mb-4">
              مستخرجة من {qaTitle ? `«${qaTitle}»` : "الرابط"} — عدّل أو احذف أو أضف بنفسك، ثم احفظ. الموظف لن يرد إلا من هذه المعلومات.
            </p>

            <div className="qa-scroll max-h-[320px] overflow-y-auto space-y-3 pe-1 mb-4">
              {qaPairs.map((p, i) => (
                <div
                  key={i}
                  className="bg-night/60 border border-verde/15 rounded-2xl p-3.5 hover:border-verde/35 transition-colors duration-300"
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10.5px] font-bold text-oro-soft bg-oro/10 border border-oro/25 rounded-full px-2.5 py-0.5 tabular-nums">
                      سؤال {i + 1}
                    </span>
                    <button
                      onClick={() => deletePair(i)}
                      title="حذف السؤال"
                      aria-label={`حذف السؤال ${i + 1}`}
                      className="text-sage/45 hover:text-oro transition-all duration-200 active:scale-90"
                    >
                      <IconTrash className="w-4 h-4" />
                    </button>
                  </div>
                  <label className={labelCls}>السؤال</label>
                  <textarea
                    value={p.question}
                    onChange={(e) => updatePair(i, "question", e.target.value)}
                    rows={1}
                    className={`${inputCls} resize-none mb-2.5 leading-6`}
                  />
                  <label className={labelCls}>الإجابة</label>
                  <textarea
                    value={p.answer}
                    onChange={(e) => updatePair(i, "answer", e.target.value)}
                    rows={2}
                    className={`${inputCls} resize-none leading-6`}
                  />
                </div>
              ))}
            </div>

            <button
              onClick={addPair}
              className="w-full flex items-center justify-center gap-2 border border-dashed border-verde/30 text-verde text-sm font-semibold rounded-2xl py-3 hover:border-oro/60 hover:text-oro hover:bg-night/40 transition-all duration-300 active:scale-[0.98] mb-4"
            >
              <IconPlus className="w-4 h-4" />
              إضافة سؤال يدوي
            </button>

            {errors.qa && (
              <p className="text-[11px] text-oro-soft bg-night/60 border border-oro/25 rounded-xl px-3.5 py-2.5 mb-3">
                {errors.qa}
              </p>
            )}

            <button
              onClick={saveQA}
              disabled={qaSaving}
              className="w-full flex items-center justify-center gap-2.5 bg-verde text-ink font-display font-bold text-lg py-3.5 rounded-2xl hover:bg-oro transition-all duration-300 active:scale-[0.98] disabled:opacity-60"
            >
              <IconSave className="w-5 h-5" />
              {qaSaving ? "جارٍ الحفظ…" : "حفظ قاعدة المعرفة"}
            </button>
            <button
              onClick={reset}
              className="mt-3 w-full text-xs text-sage hover:text-bone underline underline-offset-4 transition-colors duration-200"
            >
              البدء من جديد
            </button>
          </div>
        )}

        {/* مرحلة الجاهزية */}
        {phase === "done" && (
          <div className="py-4 text-center msg-in">
            <span className="inline-flex w-16 h-16 rounded-full bg-verde/15 border border-verde/40 items-center justify-center text-verde mb-4">
              <IconCheck className="w-8 h-8" />
            </span>
            <h2 className="font-display font-bold text-2xl text-bone mb-1">موظف ميلانو جاهز</h2>
            <p className="text-sm text-sage mb-6">
              {bizName.trim() ? `«${bizName.trim()}»` : "مشروعك"} صار عنده موظف يرد من معلوماته الحقيقية فقط.
            </p>
            <div className="text-right bg-night/60 border border-verde/15 rounded-2xl p-4 mb-6 space-y-2.5">
              {[
                [
                  "المصدر",
                  apiEnabled
                    ? qaPairs.length > 0
                      ? `أسئلة وأجوبة — ${qaPairs.length} سؤال محفوظ`
                      : `${sourceLabel} — مفهرس`
                    : sourceLabel,
                ],
                ["رقم الواتساب", parsePhoneNumberFromString(phoneNat.replace(/\D/g, ""), country)?.number || "—"],
                ["الرصيد المشمول", "1,000 رد ذكي"],
                ["التحويل للبشري", "مفعّل تلقائياً"],
              ].map(([k, v]) => (
                <div key={k} className="flex items-center justify-between text-sm gap-4">
                  <span className="text-sage">{k}</span>
                  <span className="text-bone font-semibold" dir="auto">{v}</span>
                </div>
              ))}
            </div>

            {/* الميزة 3: مختبر الفهم الدلالي — نفس مسار الرد الحقيقي */}
            {apiEnabled && (
              <div className="bg-night/60 border border-verde/15 rounded-2xl p-4 mb-5 text-right">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-oro"><IconSparkle className="w-4 h-4" /></span>
                  <h3 className="text-[13px] font-display font-bold text-bone">جرّب الفهم الدلالي</h3>
                </div>
                <p className="text-[11px] text-sage leading-5 mb-3">
                  اسأل بصياغة مختلفة تماماً عمّا حفظته — مرادفات أو عامية — وشاهد كيف يربطها بنفس المعلومة.
                </p>
                <div className="flex gap-2">
                  <input
                    value={testerQuery}
                    onChange={(e) => setTesterQuery(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && runTest()}
                    placeholder="مثال: بكم الكوفي عندكم؟"
                    className={`${inputCls} text-[13px]`}
                  />
                  <button
                    onClick={runTest}
                    disabled={testerBusy || !testerQuery.trim()}
                    className="shrink-0 bg-verde text-ink font-bold text-[13px] px-4 rounded-xl hover:bg-oro transition-all duration-300 active:scale-95 disabled:opacity-50"
                  >
                    {testerBusy ? "…" : "جرّب"}
                  </button>
                </div>
                {testerErr && <p className="text-[11px] text-oro-soft mt-2">{testerErr}</p>}
                {testerResult && (
                  <div className="mt-3.5 space-y-2.5 msg-in">
                    {testerResult.matches.length > 0 ? (
                      testerResult.matches.map((m, i) => (
                        <div key={m.id} className="flex items-center gap-2.5">
                          <span
                            className={`shrink-0 text-[10px] font-bold tabular-nums w-11 text-center rounded-full px-1.5 py-0.5 border ${
                              m.similarity >= testerResult.threshold
                                ? "text-verde border-verde/40 bg-verde/10"
                                : "text-oro-soft border-oro/30 bg-oro/5"
                            }`}
                          >
                            {Math.round(m.similarity * 100)}٪
                          </span>
                          <div className="flex-1 h-1.5 rounded-full bg-night overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all duration-700 ease-out ${
                                m.similarity >= testerResult.threshold
                                  ? "bg-gradient-to-l from-verde to-verde-deep"
                                  : "bg-oro/45"
                              }`}
                              style={{ width: barsIn ? `${Math.min(m.similarity * 100, 100)}%` : "0%" }}
                            />
                          </div>
                          {i === 0 && (
                            <span className="shrink-0 text-[9.5px] text-sage/70">
                              العتبة {Math.round(testerResult.threshold * 100)}٪
                            </span>
                          )}
                        </div>
                      ))
                    ) : (
                      <p className="text-[11px] text-oro-soft">لا نتائج — قاعدة المعرفة فارغة أو بعيدة عن السؤال.</p>
                    )}
                    {testerResult.answer ? (
                      <div className="bg-moss/80 border border-verde/25 rounded-xl rounded-ts-sm p-3">
                        <p className="text-[13px] text-bone leading-6">{testerResult.answer}</p>
                        <p className="text-[10px] text-verde mt-1.5 flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-verde live-dot" />
                          هذا ما سيرسله الموظف للعميل على واتساب
                        </p>
                      </div>
                    ) : (
                      <div className="bg-oro/5 border border-oro/25 rounded-xl p-3">
                        <p className="text-[12px] text-oro-soft leading-5">
                          ما عندي معلومات مؤكدة — سيُحال السؤال إلى «سجل الأسئلة العالقة» بدل اختلاق إجابة.
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {apiEnabled ? (
              <>
                <button
                  onClick={startLink}
                  disabled={busy}
                  className="w-full flex items-center justify-center gap-2.5 bg-verde text-ink font-display font-bold text-lg py-3.5 rounded-2xl hover:bg-oro transition-all duration-300 active:scale-[0.98] disabled:opacity-60"
                >
                  <IconWhatsapp className="w-5 h-5" />
                  اربط واتساب الآن — الأجهزة المرتبطة
                </button>
                <button
                  onClick={startPay}
                  disabled={busy}
                  className="mt-3 w-full bg-oro text-ink font-display font-bold py-3 rounded-2xl hover:bg-verde transition-all duration-300 active:scale-[0.98] disabled:opacity-60"
                >
                  {busy ? "جارٍ…" : "ادفع الآن — 99 ريال"}
                </button>
                {payUrl && (
                  <p className="mt-2.5 text-[11px] text-verde leading-5">
                    فُتحت صفحة الدفع — التفعيل يتم تلقائياً فور تأكيد البوابة.
                    <a href={payUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2 text-oro-soft">
                      {" "}إعادة فتح الرابط
                    </a>
                  </p>
                )}
                {errors.pay && <p className="mt-2 text-[11px] text-oro-soft">{errors.pay}</p>}
              </>
            ) : (
              <button
                onClick={() => setPhase("pay")}
                className="w-full bg-verde text-ink font-display font-bold text-lg py-3.5 rounded-2xl hover:bg-oro transition-all duration-300 active:scale-[0.98]"
              >
                أكمل الدفع — 99 ريال
              </button>
            )}

            <button onClick={reset} className="mt-3 text-xs text-sage hover:text-bone underline underline-offset-4 transition-colors">
              تعديل المعلومات
            </button>
          </div>
        )}

        {/* مرحلة الربط الفعلي بواتساب — QR حقيقي صادر من جلسة Baileys في الخادم */}
        {phase === "link" && (
          <div className="py-4 text-center msg-in">
            <h2 className="font-display font-bold text-xl text-bone mb-1">اربط واتساب الآن</h2>
            <p className="text-xs text-sage leading-5 mb-5">
              من جوالك: واتساب ← الإعدادات ← الأجهزة المرتبطة ← ربط جهاز، ثم امسح الرمز
            </p>

            {waSnap.state === "CONNECTED" ? (
              <div className="bg-night/60 border border-verde/30 rounded-2xl p-5 mb-5">
                <div className="flex items-center justify-center gap-2 text-verde font-semibold mb-2">
                  <span className="w-2 h-2 rounded-full bg-verde live-dot" />
                  تم الربط بنجاح{waSnap.phone ? ` — ${waSnap.phone}` : ""}
                </div>
                <p className="text-xs text-sage leading-5">
                  جرّب إرسال رسالة من رقم ثاني — ميلانو يرد من معلومات مشروعك فقط، ويحوّل لك أي سؤال ما يتأكد منه.
                </p>
              </div>
            ) : waSnap.state === "ERROR" ? (
              <div className="bg-night/60 border border-oro/35 rounded-2xl p-5 mb-5">
                <p className="text-sm font-semibold text-oro-soft mb-1">{waSnap.error ?? "تعذر إنشاء جلسة واتساب، تحقق من اتصال الخادم."}</p>
                <p className="text-[11px] text-sage leading-5 mb-3.5">
                  تأكد أن الخادم يعمل وأن VITE_API_URL يشير إليه، ثم أعد المحاولة.
                </p>
                <button onClick={startLink} className="text-xs font-bold text-verde hover:text-oro underline underline-offset-4 transition-colors">
                  إعادة المحاولة
                </button>
              </div>
            ) : (
              <>
                <div className="bg-bone rounded-2xl p-3 inline-block mb-3 shadow-[0_20px_60px_-20px_rgba(46,194,126,0.35)]">
                  {waSnap.qrDataUrl ? (
                    <img key={waSnap.qrDataUrl.length} src={waSnap.qrDataUrl} alt="رمز ربط واتساب" className="w-52 h-52" />
                  ) : (
                    <div className="w-52 h-52 flex flex-col items-center justify-center gap-2.5">
                      <span className="w-6 h-6 rounded-full border-2 border-[#1c5c41]/25 border-t-[#1c5c41] animate-spin" />
                      <span className="text-[13px] font-semibold" style={{ color: "#1c5c41" }}>
                        {waSnap.state === "CONNECTING"
                          ? "جاري الاتصال…"
                          : waSnap.state === "DISCONNECTED"
                            ? "انقطع الاتصال — إعادة المحاولة تلقائياً"
                            : waSnap.state === "LOGGED_OUT"
                              ? "انتهت صلاحية الجلسة — رمز جديد خلال لحظات"
                              : "جارٍ إنشاء الجلسة…"}
                      </span>
                    </div>
                  )}
                </div>

                {waSnap.state === "QR_REQUIRED" && (
                  <p className="text-[11px] text-verde/90 leading-5 mb-1.5">
                    صلاحية الرمز قصيرة — يُجدَّد هنا تلقائياً فور صدور رمز جديد، اترك الصفحة مفتوحة.
                  </p>
                )}
                {waSnap.state === "CONNECTING" && (
                  <p className="text-[11px] text-verde/90 leading-5 mb-1.5">
                    تم المسح — جاري إتمام الاتصال بجلسة واتساب…
                  </p>
                )}
              </>
            )}

            <p className="text-[11px] text-sage/70 leading-5 mb-4">
              الربط عبر «الأجهزة المرتبطة» — ليست قناة رسمية من Meta، وقد تقيّد واتساب الرقم وفق تقديرها.
            </p>

            {waSnap.state !== "CONNECTED" && (
              <button onClick={startLink} className="text-xs text-sage hover:text-bone underline underline-offset-4 transition-colors">
                إعادة توليد الرمز
              </button>
            )}
            <button onClick={() => setPhase("done")} className="mt-3 block mx-auto text-xs text-sage hover:text-oro underline underline-offset-4 transition-colors">
              العودة
            </button>
          </div>
        )}

        {/* مرحلة الدفع */}
        {(phase === "pay" || phase === "paid") && (
          <div className="py-4 msg-in">
            {phase === "pay" ? (
              <>
                <h2 className="font-display font-bold text-xl text-bone mb-4">فاتورة التفعيل</h2>
                <div className="bg-night/60 border border-verde/15 rounded-2xl p-4 mb-5">
                  <div className="flex items-end justify-between pb-3 border-b border-dashed border-verde/20">
                    <div>
                      <p className="font-display font-bold text-3xl text-oro">
                        99 <span className="text-base text-oro-soft">ريال</span>
                      </p>
                      <p className="text-[11px] text-sage">دفعة واحدة — بدون اشتراك شهري</p>
                    </div>
                    <span className="text-verde">
                      <Logo className="w-9 h-9" />
                    </span>
                  </div>
                  <ul className="pt-3 space-y-2">
                    {["إنشاء الموظف وتدريبه", "1,000 رد ذكي مشمولة", "فحص كل رد قبل الإرسال", "لوحة تحكم وسجل الأسئلة العالقة"].map((f) => (
                      <li key={f} className="flex items-center gap-2 text-[13px] text-mist">
                        <span className="text-verde"><IconCheck className="w-3.5 h-3.5" /></span>
                        {f}
                      </li>
                    ))}
                  </ul>
                </div>
                <button
                  onClick={() => {
                    setPhase("paid");
                    confetti({ particleCount: 90, spread: 90, origin: { y: 0.4 }, colors: ["#2ec27e", "#e8b24b"] });
                  }}
                  className="w-full bg-oro text-ink font-display font-bold text-lg py-3.5 rounded-2xl hover:bg-verde transition-all duration-300 active:scale-[0.98]"
                >
                  ادفع الآن (عرض تجريبي)
                </button>
                <button onClick={reset} className="mt-3 w-full text-xs text-sage hover:text-bone underline underline-offset-4 transition-colors">
                  العودة
                </button>
              </>
            ) : (
              <div className="text-center py-4">
                <span className="inline-flex w-16 h-16 rounded-full bg-oro/15 border border-oro/50 items-center justify-center text-oro mb-4">
                  <IconBolt className="w-8 h-8" />
                </span>
                <h2 className="font-display font-bold text-2xl text-bone mb-2">تم التفعيل!</h2>
                <p className="text-sm text-sage leading-6 mb-6">
                  وصلك رابط ربط «الأجهزة المرتبطة» على جوالك.
                  <br />
                  امسحه من واتساب — وميلانو يبدأ يرد عنك خلال ثواني.
                </p>
                <div className="bg-night/60 border border-verde/15 rounded-2xl p-4 mb-6">
                  <div className="flex items-center justify-center gap-2 text-verde text-sm font-semibold">
                    <span className="w-2 h-2 rounded-full bg-verde live-dot" />
                    الموظف متصل الآن — رصيدك 1,000 رد
                  </div>
                </div>
                <button onClick={reset} className="text-xs text-sage hover:text-oro underline underline-offset-4 transition-colors">
                  جرّب إنشاء موظف ثاني
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================ العدادات ============================ */

function Stat({ value, suffix, prefix, label, active, delay }: { value: number; suffix?: string; prefix?: string; label: string; active: boolean; delay: number }) {
  const n = useCountUp(value, active);
  return (
    <div data-reveal style={{ transitionDelay: `${delay}ms` }} className="text-center group">
      <p className="font-display font-bold text-3xl sm:text-4xl text-bone tabular-nums transition-colors duration-300 group-hover:text-oro">
        {prefix}
        {n.toLocaleString("en")}
        {suffix && <span className="text-lg text-oro-soft"> {suffix}</span>}
      </p>
      <p className="text-xs text-sage mt-1.5">{label}</p>
    </div>
  );
}

/* ============================ القسم كامل ============================ */

export default function Hero() {
  const [loaded, setLoaded] = useState(false);
  const stats = useInView<HTMLDivElement>();
  const wrap = useReveal<HTMLElement>();

  useEffect(() => {
    const t = setTimeout(() => setLoaded(true), 90);
    return () => clearTimeout(t);
  }, []);

  return (
    <section
      ref={wrap}
      className={`relative overflow-hidden pt-28 lg:pt-36 pb-14 ${loaded ? "loaded" : ""}`}
    >
      {/* خلفية القسم */}
      <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
        <div className="absolute inset-0 bg-[radial-gradient(1000px_520px_at_88%_-12%,rgba(46,194,126,0.16),transparent_62%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(800px_480px_at_0%_100%,rgba(232,178,75,0.09),transparent_60%)]" />
        <div className="absolute inset-0 pinstripe opacity-70" />
        <p className="absolute -start-10 top-24 font-display font-extrabold text-[11rem] lg:text-[15rem] leading-none text-bone/[0.028] select-none hidden md:block">
          MILANO
        </p>
      </div>

      <div className="relative max-w-6xl mx-auto px-5 lg:px-8 grid lg:grid-cols-[1.05fr_0.95fr] gap-12 lg:gap-10 items-start">
        {/* النص التعريفي */}
        <div className="pt-2">
          <div data-reveal className="inline-flex items-center gap-2.5 bg-moss/70 border border-verde/25 rounded-full px-4 py-1.5 mb-6">
            <span className="w-2 h-2 rounded-full bg-verde live-dot" />
            <span className="text-xs font-semibold text-mist">موظف ذكي على واتساب — يرد 24/7</span>
          </div>

          <h1 className="font-display font-extrabold text-[2.6rem] leading-[1.12] sm:text-6xl sm:leading-[1.08] text-bone">
            <span className="mask-line">
              <span>حوّل واتساب مشروعك</span>
            </span>
            <span className="mask-line">
              <span style={{ transitionDelay: "0.12s" }}>إلى موظف خدمة عملاء</span>
            </span>
            <span className="mask-line">
              <span style={{ transitionDelay: "0.24s" }} className="text-verde draw-line">
                لا ينام أبداً
              </span>
            </span>
          </h1>

          <p data-reveal style={{ transitionDelay: "0.2s" }} className="mt-6 text-sage text-base sm:text-lg leading-8 max-w-xl">
            اربط مشروعك، اربط واتسابك، وخلّه يرد على عملائك بمعلوماتك الحقيقية — الأسعار، المواعيد،
            الموقع — وإذا ما عرف، يقول ما يعرف ويحوّل المحادثة لك.
          </p>

          <ul data-reveal style={{ transitionDelay: "0.3s" }} className="mt-7 flex flex-wrap gap-x-6 gap-y-3">
            {[
              { icon: <IconBolt className="w-4 h-4" />, t: "99 ريال دفعة واحدة" },
              { icon: <IconInfinity className="w-4 h-4" />, t: "بدون اشتراك شهري" },
              { icon: <IconShieldCheck className="w-4 h-4" />, t: "يشمل 1,000 رد ذكي" },
            ].map((b) => (
              <li key={b.t} className="flex items-center gap-2 text-sm text-mist">
                <span className="text-oro">{b.icon}</span>
                {b.t}
              </li>
            ))}
          </ul>

          {/* فقاعات عائمة تزينية */}
          <div className="hidden xl:flex flex-col gap-3 mt-10 max-w-xs" aria-hidden="true">
            <div className="floaty self-start bg-wa-in text-mist text-[13px] px-4 py-2.5 rounded-2xl rounded-bl-md shadow-lg">
              كم سعر السبانش لاتيه؟
            </div>
            <div className="floaty-slow self-end bg-wa-out text-bone text-[13px] px-4 py-2.5 rounded-2xl rounded-br-md shadow-lg flex items-center gap-2">
              <span className="text-verde"><Logo className="w-4 h-4" /></span>
              18 ريال — حار أو مثلج
            </div>
          </div>
        </div>

        {/* الأداة */}
        <div data-reveal style={{ transitionDelay: "0.15s" }}>
          <Wizard />
        </div>
      </div>

      {/* شريط العدادات */}
      <div ref={stats.ref} className="relative max-w-6xl mx-auto px-5 lg:px-8 mt-16 lg:mt-20">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8 bg-pine/70 border border-verde/15 rounded-3xl px-6 py-8">
          <Stat value={24} suffix="/ 7" label="يرد بلا توقف ولا إجازات" active={stats.inView} delay={0} />
          <Stat value={3} prefix="<" suffix="ثواني" label="متوسط زمن الرد على العميل" active={stats.inView} delay={100} />
          <Stat value={1000} suffix="رد" label="ذكي مشمول في دفعة التفعيل" active={stats.inView} delay={200} />
          <Stat value={0} suffix="ريال" label="رسوم شهرية — للأبد" active={stats.inView} delay={300} />
        </div>
      </div>
    </section>
  );
}
