import { useEffect, useState } from "react";
import { Logo, IconWhatsapp, IconMenu, IconX } from "./Icons";

const LINKS = [
  { label: "الضمانات", href: "#guarantees" },
  { label: "شاهد ميلانو", href: "#demo" },
  { label: "الأسعار", href: "#pricing" },
  { label: "الأسئلة", href: "#faq" },
];

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`fixed top-0 inset-x-0 z-50 transition-all duration-500 ${
        scrolled
          ? "bg-night/85 backdrop-blur-md border-b border-verde/15 shadow-[0_10px_40px_-18px_rgba(0,0,0,0.6)]"
          : "bg-transparent border-b border-transparent"
      }`}
    >
      <nav className="max-w-6xl mx-auto px-5 lg:px-8 h-16 flex items-center justify-between gap-4">
        <a href="#top" className="flex items-center gap-2.5 group">
          <span className="text-verde transition-transform duration-500 group-hover:rotate-[-8deg] group-hover:scale-110">
            <Logo className="w-9 h-9" />
          </span>
          <span className="font-display font-bold text-2xl leading-none text-bone">
            ميلانو
            <span className="text-oro">.</span>
          </span>
        </a>

        <ul className="hidden md:flex items-center gap-1">
          {LINKS.map((l) => (
            <li key={l.href}>
              <a
                href={l.href}
                className="px-4 py-2 rounded-full text-sm text-sage hover:text-bone hover:bg-moss/70 transition-colors duration-300"
              >
                {l.label}
              </a>
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-3">
          <a
            href="#/dashboard"
            className="hidden sm:inline-flex items-center gap-2 border border-verde/30 text-mist font-semibold text-sm px-4 py-2.5 rounded-full hover:border-oro/60 hover:text-oro transition-all duration-300 active:scale-95"
          >
            لوحة التحكم
          </a>
          <a
            href="#start"
            className="hidden sm:inline-flex items-center gap-2 bg-verde text-ink font-semibold text-sm px-5 py-2.5 rounded-full hover:bg-oro transition-colors duration-300 hover:shadow-[0_8px_30px_-8px_rgba(232,178,75,0.5)] active:scale-95"
          >
            <IconWhatsapp className="w-4 h-4" />
            ابدأ الآن
          </a>
          <button
            onClick={() => setOpen((v) => !v)}
            className="md:hidden text-bone p-2 rounded-lg hover:bg-moss transition-colors"
            aria-label="القائمة"
          >
            {open ? <IconX /> : <IconMenu />}
          </button>
        </div>
      </nav>

      {/* قائمة الجوال */}
      <div
        className={`md:hidden overflow-hidden transition-all duration-400 ${
          open ? "max-h-72 border-t border-verde/10 bg-night/95 backdrop-blur-md" : "max-h-0"
        }`}
      >
        <ul className="px-5 py-4 space-y-1">
          {LINKS.map((l) => (
            <li key={l.href}>
              <a
                href={l.href}
                onClick={() => setOpen(false)}
                className="block px-4 py-3 rounded-xl text-sage hover:text-bone hover:bg-moss transition-colors"
              >
                {l.label}
              </a>
            </li>
          ))}
          <li>
            <a
              href="#/dashboard"
              onClick={() => setOpen(false)}
              className="block text-center border border-verde/30 text-mist font-semibold px-4 py-3 rounded-xl mt-2 hover:border-oro/60 hover:text-oro transition-colors"
            >
              لوحة التحكم
            </a>
          </li>
          <li>
            <a
              href="#start"
              onClick={() => setOpen(false)}
              className="block text-center bg-verde text-ink font-semibold px-4 py-3 rounded-xl mt-2"
            >
              ابدأ الآن — 99 ريال
            </a>
          </li>
        </ul>
      </div>
    </header>
  );
}
