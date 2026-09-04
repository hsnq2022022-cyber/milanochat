import { useEffect, useState } from "react";
import confetti from "canvas-confetti";
import { useCountUp, useInView, useReveal } from "../hooks/useReveal";
import { api, apiEnabled, apiFetch } from "../lib/api";
import {
  IconArrowStart,
  IconBolt,
  IconCheck,
  IconGlobe,
  IconInfinity,
  IconMapPin,
  IconPen,
  IconShieldCheck,
  IconSparkle,
  IconWhatsapp,
  Logo,
} from "./Icons";

/* ============================ أداة الربط ============================ */

type Source = "map" | "site" | "manual";
type Phase = "form" | "working" | "done" | "pay" | "paid" | "link";

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
  const [waNumber, setWaNumber] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  /* ── حالة الخادم الحقيقي (تعمل فقط عند ضبط VITE_API_URL) ── */
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [apiResult, setApiResult] = useState<null | { ok: true } | { ok: false; error: string }>(null);
  const [qr, setQr] = useState<{ status: string; qrDataUrl: string | null; phone: string | null }>({
    status: "idle",
    qrDataUrl: null,
    phone: null,
  });
  const [payUrl, setPayUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const manualText = () =>
    [
      bizName.trim() && `اسم المشروع: ${bizName.trim()}`,
      bizActivity.trim() && `النشاط: ${bizActivity.trim()}`,
      bizAddress.trim() && `العنوان: ${bizAddress.trim()}`,
      bizHours.trim() && `أوقات العمل: ${bizHours.trim()}`,
      waNumber.trim() && `رقم الواتساب: ${waNumber.trim()}`,
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
        setPhase("done");
        confetti({
          particleCount: 130,
          spread: 75,
          origin: { y: 0.35 },
          colors: ["#2ec27e", "#e8b24b", "#eff3ea", "#178a57"],
        });
      }, 450);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setWorkStep((s) => s + 1), 820);
    return () => clearTimeout(t);
  }, [phase, workStep, apiResult]);

  /* استطلاع حالة الربط ورمز QR الحقيقي كل ثانيتين */
  useEffect(() => {
    if (phase !== "link" || !tenantId) return;
    let stopped = false;
    const tick = async () => {
      try {
        const s = await api.getQr(tenantId);
        if (stopped) return;
        setQr((prev) => {
          if (s.status === "connected" && prev.status !== "connected") {
            confetti({ particleCount: 90, spread: 80, origin: { y: 0.4 }, colors: ["#2ec27e", "#e8b24b"] });
          }
          return s;
        });
      } catch {
        /* إعادة المحاولة في الدورة التالية */
      }
    };
    tick();
    const iv = setInterval(tick, 2000);
    return () => {
      stopped = true;
      clearInterval(iv);
    };
  }, [phase, tenantId]);

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
    const digits = waNumber.replace(/[\s-]/g, "");
    if (!/^\+?\d{9,15}$/.test(digits)) e.waNumber = "اكتب رقم الواتساب بالأرقام (9 خانات على الأقل)";
    setErrors(e);
    if (Object.keys(e).length !== 0) return;

    setWorkStep(0);
    setPhase("working");
    setApiResult(null);
    setPayUrl(null);
    if (!apiEnabled) return; // وضع العرض التجريبي بدون خادم

    (async () => {
      try {
        const fallbackName = (source === "map" ? mapUrl : siteUrl).replace(/^https?:\/\//, "").split("/")[0];
        const created = await api.createTenant(
          bizName.trim() || fallbackName || "مشروع جديد",
          source === "map" ? "gmaps" : source === "site" ? "website" : "manual",
          source === "map" ? mapUrl.trim() : siteUrl.trim()
        );
        setTenantId(created.tenantId);
        localStorage.setItem("milano_claim", created.claimToken); // لضم الحساب للوحة التحكم لاحقاً
        const ing =
          source === "manual"
            ? await api.ingestText(created.tenantId, manualText())
            : await api.ingestUrl(created.tenantId, (source === "map" ? mapUrl : siteUrl).trim());
        if (ing.status === "failed") throw new Error(ing.error || "تعذّر فهرسة المصدر — جرّب رابطاً آخر أو الإدخال اليدوي");
        setApiResult({ ok: true });
      } catch (err: any) {
        setApiResult({ ok: false, error: err?.message || "تعذر الاتصال بالخادم — تأكد أنه يعمل" });
      }
    })();
  };

  /* بدء جلسة واتساب الحقيقية وعرض شاشة الربط */
  const startLink = async () => {
    if (!tenantId) return;
    setBusy(true);
    try {
      await api.connectWa(tenantId);
    } catch {
      /* الحالة ستظهر عبر الاستطلاع */
    }
    setPhase("link");
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

  const reset = () => {
    setPhase("form");
    setErrors({});
    setWorkStep(0);
    setApiResult(null);
    setPayUrl(null);
    setQr({ status: "idle", qrDataUrl: null, phone: null });
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

              <div>
                <label className={labelCls}>رقم واتساب الموظف *</label>
                <div className="relative">
                  <span className="absolute start-3.5 top-1/2 -translate-y-1/2 text-verde">
                    <IconWhatsapp className="w-4.5 h-4.5" />
                  </span>
                  <input
                    dir="ltr"
                    value={waNumber}
                    onChange={(e) => setWaNumber(e.target.value)}
                    placeholder="+966 5X XXX XXXX"
                    className={`${inputCls} text-left ps-10 ${errors.waNumber ? "border-oro/70" : ""}`}
                  />
                </div>
                {errors.waNumber && <p className={errCls}>{errors.waNumber}</p>}
              </div>

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
                <p className="text-[11px] leading-5 text-oro-soft bg-night/60 border border-oro/25 rounded-xl px-3.5 py-2.5">
                  {errors.api}
                </p>
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
                ["المصدر", sourceLabel + (apiEnabled ? " — تمت الفهرسة ✓".replace(" ✓", "") : "")],
                ["رقم الواتساب", waNumber || "—"],
                ["الرصيد المشمول", "1,000 رد ذكي"],
                ["التحويل للبشري", "مفعّل تلقائياً"],
              ].map(([k, v]) => (
                <div key={k} className="flex items-center justify-between text-sm gap-4">
                  <span className="text-sage">{k}</span>
                  <span className="text-bone font-semibold" dir="auto">{v}</span>
                </div>
              ))}
            </div>

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

        {/* مرحلة الربط الفعلي بواتساب — QR حقيقي من الخادم */}
        {phase === "link" && (
          <div className="py-4 text-center msg-in">
            <h2 className="font-display font-bold text-xl text-bone mb-1">اربط واتساب الآن</h2>
            <p className="text-xs text-sage leading-5 mb-5">
              من جوالك: واتساب ← الإعدادات ← الأجهزة المرتبطة ← ربط جهاز، ثم امسح الرمز
            </p>

            {qr.status === "connected" ? (
              <div className="bg-night/60 border border-verde/30 rounded-2xl p-5 mb-5">
                <div className="flex items-center justify-center gap-2 text-verde font-semibold mb-2">
                  <span className="w-2 h-2 rounded-full bg-verde live-dot" />
                  تم الربط{qr.phone ? ` — ${qr.phone}` : ""}
                </div>
                <p className="text-xs text-sage leading-5">
                  جرّب إرسال رسالة من رقم ثاني — ميلانو يرد من معلومات مشروعك فقط، ويحوّل لك أي سؤال ما يتأكد منه.
                </p>
              </div>
            ) : (
              <div className="bg-bone rounded-2xl p-3 inline-block mb-3 shadow-[0_20px_60px_-20px_rgba(46,194,126,0.35)]">
                {qr.qrDataUrl ? (
                  <img src={qr.qrDataUrl} alt="رمز ربط واتساب" className="w-52 h-52" />
                ) : (
                  <div className="w-52 h-52 flex items-center justify-center">
                    <span className="text-[13px] font-semibold" style={{ color: "#1c5c41" }}>
                      {qr.status === "qr" ? "جارٍ توليد الرمز…" : "جارٍ الاتصال بالسيرفر…"}
                    </span>
                  </div>
                )}
              </div>
            )}

            <p className="text-[11px] text-sage/70 leading-5 mb-4">
              الربط عبر «الأجهزة المرتبطة» — ليست قناة رسمية من Meta، وقد تقيّد واتساب الرقم وفق تقديرها.
            </p>

            {qr.status !== "connected" && (
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
