import { IconLog, IconSparkle, IconSettings } from "./Icons";

export type BottomNavId = "home" | "flows" | "profile";

const ITEMS: { id: BottomNavId; href: string; label: string; testid: string; icon: JSX.Element }[] = [
  { id: "home", href: "#/dashboard", label: "الرئيسية", testid: "bottom-nav-home", icon: <IconLog className="w-5 h-5" /> },
  { id: "flows", href: "#/flows", label: "التدفقات", testid: "bottom-nav-flows", icon: <IconSparkle className="w-5 h-5" /> },
  { id: "profile", href: "#/profile", label: "الملف الشخصي", testid: "bottom-nav-profile", icon: <IconSettings className="w-5 h-5" /> },
];

export default function BottomNav({ active }: { active: BottomNavId }) {
  return (
    <nav
      data-testid="bottom-nav"
      aria-label="التنقل الرئيسي"
      className="fixed bottom-0 inset-x-0 z-40 bg-night/95 backdrop-blur-md border-t border-verde/15 pb-[env(safe-area-inset-bottom)]"
    >
      <div className="max-w-6xl mx-auto grid grid-cols-3 h-16">
        {ITEMS.map((i) => {
          const current = i.id === active;
          return (
            <a
              key={i.testid}
              href={i.href}
              data-testid={i.testid}
              aria-current={current ? "page" : undefined}
              className={`flex flex-col items-center justify-center gap-1 text-xs font-bold transition-colors ${current ? "text-oro" : "text-sage hover:text-bone"}`}
            >
              {i.icon}
              <span>{i.label}</span>
            </a>
          );
        })}
      </div>
    </nav>
  );
}
