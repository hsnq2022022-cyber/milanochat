import { lazy, Suspense, useEffect, useState } from "react";
import Navbar from "./components/Navbar";
import FlowErrorBoundary from "./components/FlowErrorBoundary";
import RouteErrorBoundary from "./components/RouteErrorBoundary";
import Hero from "./components/Hero";
import { Marquee, Footer } from "./components/Extras";
import Guarantees from "./components/Guarantees";
import ChatDemo from "./components/ChatDemo";
import ChannelsSection from "./components/ChannelsSection";
import Pricing from "./components/Pricing";
import FAQ from "./components/FAQ";
import { getSupabase } from "./lib/supabase";

/* لوحة التحكم وحدة منفصلة — لا يتحمل زائر الصفحة الرئيسية حجمها */
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Settings = lazy(() => import("./pages/Settings"));
const Widgets = lazy(() => import("./pages/Widgets"));
const FlowBuilder = lazy(() => import("./pages/FlowBuilder"));
const LandingPage = lazy(() => import("./pages/LandingPage"));

export default function App() {
  const [route, setRoute] = useState(() => window.location.hash);

  useEffect(() => {
    const onHash = () => setRoute(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  /* حالة الجلسة: null = قيد التحقق. بدون إعداد Supabase يُعامل الزائر كغير مسجّل. */
  const [authed, setAuthed] = useState<boolean | null>(() => (getSupabase() ? null : false));
  useEffect(() => {
    const sb = getSupabase();
    if (!sb) return;
    let alive = true;
    sb.auth.getSession().then(({ data }) => alive && setAuthed(Boolean(data.session)), () => alive && setAuthed(false));
    const { data: sub } = sb.auth.onAuthStateChange((_e, session) => alive && setAuthed(Boolean(session)));
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  /* معاينة مستقلة لمصمم التدفقات؛ لا تغيّر لوحة التحكم أو الدوال المنشورة. */
  if (route.startsWith("#/flows")) {
    return <FlowErrorBoundary><Suspense fallback={<div className="min-h-screen bg-night" />}><FlowBuilder /></Suspense></FlowErrorBoundary>;
  }

  /* لوحة التحكم: #/dashboard */
  if (route.startsWith("#/dashboard")) {
    return (
      <RouteErrorBoundary key="dashboard">
        <Suspense fallback={<div className="min-h-screen bg-night" />}>
          <Dashboard />
        </Suspense>
      </RouteErrorBoundary>
    );
  }

  /* الإعدادات: #/settings (و#/profile كاسم بديل) */
  if (route.startsWith("#/settings") || route.startsWith("#/profile")) {
    return (
      <RouteErrorBoundary key="settings">
        <Suspense fallback={<div className="min-h-screen bg-night" />}>
          <Settings />
        </Suspense>
      </RouteErrorBoundary>
    );
  }

  /* صفحة Widgets: #/widgets */
  if (route.startsWith("#/widgets")) {
    return (
      <RouteErrorBoundary key="widgets">
        <Suspense fallback={<div className="min-h-screen bg-night" />}>
          <Widgets />
        </Suspense>
      </RouteErrorBoundary>
    );
  }

  /* الصفحة الرئيسية: غير المسجّل يرى صفحة الهبوط، والمسجّل يبقى على الصفحة الحالية. #/start يفتح الصفحة الحالية دائماً. */
  const isHome = !route.startsWith("#/") || route === "#/" || route.startsWith("#/?");
  if (isHome && authed !== true) {
    return (
      <RouteErrorBoundary key="landing">
        <Suspense fallback={<div className="min-h-screen bg-night" />}>
          {authed === null ? <div className="min-h-screen bg-night" /> : <LandingPage />}
        </Suspense>
      </RouteErrorBoundary>
    );
  }

  return (
    <div className="relative min-h-screen bg-night text-bone font-body overflow-x-clip">
      {/* خلفية محيطية ثابتة */}
      <div className="fixed inset-0 -z-10 pointer-events-none" aria-hidden="true">
        <div className="absolute inset-0 bg-night" />
        <div className="absolute inset-0 bg-[radial-gradient(1100px_600px_at_80%_-10%,rgba(46,194,126,0.08),transparent_60%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(900px_600px_at_-5%_60%,rgba(232,178,75,0.05),transparent_60%)]" />
      </div>

      {/* حبيبات */}
      <div className="noise-layer" aria-hidden="true" />

      <Navbar />

      <main>
        <Hero />
        <Marquee />
        <ChannelsSection />
        <Guarantees />
        <ChatDemo />
        <Pricing />
        <FAQ />
      </main>

      <Footer />
    </div>
  );
}
