import { useEffect, useState } from "react";
import Navbar from "./components/Navbar";
import Hero from "./components/Hero";
import { Marquee, Footer } from "./components/Extras";
import Guarantees from "./components/Guarantees";
import ChatDemo from "./components/ChatDemo";
import Pricing from "./components/Pricing";
import FAQ from "./components/FAQ";
import Dashboard from "./pages/Dashboard";

export default function App() {
  const [route, setRoute] = useState(() => window.location.hash);

  useEffect(() => {
    const onHash = () => setRoute(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  /* لوحة التحكم: #/dashboard */
  if (route.startsWith("#/dashboard")) {
    return <Dashboard />;
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
        <Guarantees />
        <ChatDemo />
        <Pricing />
        <FAQ />
      </main>

      <Footer />
    </div>
  );
}
