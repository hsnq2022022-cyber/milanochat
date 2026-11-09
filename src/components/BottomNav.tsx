import { NAV_ITEMS, type NavId } from "./navItems";

export type BottomNavId = NavId;

export default function BottomNav({ active }: { active: NavId | null }) {
  return (
    <nav
      data-testid="bottom-nav"
      aria-label="التنقل الرئيسي"
      className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-[#061A14]/95 backdrop-blur-md border-t border-[#173D30] pb-[env(safe-area-inset-bottom)]"
    >
      <div className="grid grid-cols-5 h-16">
        {NAV_ITEMS.map((i) => {
          const current = i.id === active;
          const Icon = i.icon;
          return (
            <a
              key={i.id}
              href={i.href}
              data-testid={`bottom-nav-${i.id}`}
              aria-current={current ? "page" : undefined}
              className={`flex flex-col items-center justify-center gap-1 min-h-[44px] min-w-0 px-1 text-xs font-bold transition-colors duration-200 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#3DD189] ${current ? "text-[#E5B54B]" : "text-[#8B9E96] hover:text-white"}`}
            >
              <Icon className="w-5 h-5 shrink-0" aria-hidden="true" />
              <span className="max-w-full truncate">{i.label}</span>
            </a>
          );
        })}
      </div>
    </nav>
  );
}
