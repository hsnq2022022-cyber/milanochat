type IconProps = { className?: string };

/* شعار ميلانو: فقاعة محادثة بداخلها ميم مرسومة */
export function Logo({ className = "w-10 h-10" }: IconProps) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <path
        d="M24 5C13.5 5 5 12.8 5 22.4c0 5.2 2.6 9.9 6.7 13L9.8 43l8.3-3.6c1.9.5 3.9.8 5.9.8 10.5 0 19-7.8 19-17.8S34.5 5 24 5Z"
        fill="currentColor"
      />
      <path
        d="M31.5 18.5a4.6 4.6 0 1 1-4.4 5.9H14.5"
        fill="none"
        stroke="#06201a"
        strokeWidth="3.4"
        strokeLinecap="round"
      />
      <circle cx="31.5" cy="18.5" r="1.1" fill="#06201a" />
    </svg>
  );
}

export function IconWhatsapp({ className = "w-5 h-5" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 2a8 8 0 1 1-4.2 14.8l-.5-.3-2.9.8.8-2.8-.3-.5A8 8 0 0 1 12 4Zm-3 4.2c-.2 0-.5.1-.7.3-.2.3-.9.9-.9 2.1s.9 2.4 1 2.6c.1.2 1.8 2.9 4.5 4 2.2.9 2.7.8 3.2.7.5 0 1.6-.7 1.8-1.3.2-.6.2-1.2.2-1.3-.1-.1-.2-.2-.5-.3l-1.7-.8c-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1-.3-.1-1.1-.4-2.1-1.3-.8-.7-1.3-1.5-1.5-1.8-.1-.2 0-.4.1-.5l.4-.5c.1-.2.2-.3.3-.5.1-.2 0-.4 0-.5l-.8-1.8c-.2-.4-.4-.5-.7-.5h-.6Z" />
    </svg>
  );
}

export function IconMapPin({ className = "w-5 h-5" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 21s-6.5-5.4-6.5-10.2A6.5 6.5 0 0 1 12 4.3a6.5 6.5 0 0 1 6.5 6.5C18.5 15.6 12 21 12 21Z" />
      <circle cx="12" cy="10.8" r="2.4" />
      <path d="M4 21h16" strokeDasharray="2.5 2.5" />
    </svg>
  );
}

export function IconGlobe({ className = "w-5 h-5" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8.2" />
      <path d="M3.8 12h16.4M12 3.8c2.6 2.3 3.9 5 3.9 8.2s-1.3 5.9-3.9 8.2c-2.6-2.3-3.9-5-3.9-8.2S9.4 6.1 12 3.8Z" />
    </svg>
  );
}

export function IconPen({ className = "w-5 h-5" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m14.5 5.5 4 4L8 20l-4.6.6L4 16 14.5 5.5Z" />
      <path d="m12.5 7.5 4 4M17 3l4 4-1.5 1.5-4-4L17 3Z" />
    </svg>
  );
}

export function IconShieldCheck({ className = "w-6 h-6" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3 5 5.8v5.4c0 4.6 3 7.9 7 9.8 4-1.9 7-5.2 7-9.8V5.8L12 3Z" />
      <path d="m8.8 11.8 2.3 2.3 4.2-4.5" />
    </svg>
  );
}

export function IconFilter({ className = "w-6 h-6" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 5h16l-6.2 7.2V19l-3.6-2v-4.8L4 5Z" />
      <path d="M17.5 16.5c.4 1.5-.6 2.3-.6 2.3s-1-.8-.6-2.3c.3-1 .6-1.5.6-1.5s.3.5.6 1.5Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconQuestion({ className = "w-6 h-6" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
      <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H12l-4 4v-4H6.5A2.5 2.5 0 0 1 4 13.5v-7Z" />
      <path d="M9.8 8.6c.3-1 1.2-1.6 2.3-1.6 1.3 0 2.3.9 2.3 2 0 1.6-2.3 1.7-2.3 3.2" />
      <circle cx="12" cy="14.8" r="0.4" fill="currentColor" />
    </svg>
  );
}

export function IconHandoff({ className = "w-6 h-6" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6.5" cy="7" r="2.6" />
      <path d="M2.8 19c.4-3.4 1.9-5.4 3.7-5.4s3.3 2 3.7 5.4" />
      <circle cx="17.5" cy="7" r="2.6" strokeDasharray="2.6 2.2" />
      <path d="M13.8 19c.4-3.4 1.9-5.4 3.7-5.4s3.3 2 3.7 5.4" strokeDasharray="2.6 2.2" />
      <path d="M10.5 12h3m0 0-1.4-1.4M13.5 12l-1.4 1.4" />
    </svg>
  );
}

export function IconLog({ className = "w-6 h-6" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
      <rect x="4" y="3.5" width="16" height="17" rx="2.4" />
      <path d="M8 8h8M8 12h5" />
      <circle cx="15.6" cy="15.8" r="2.6" />
      <path d="m17.6 17.8 2 2" />
    </svg>
  );
}

export function IconCoin({ className = "w-6 h-6" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8.2" />
      <circle cx="12" cy="12" r="4.6" strokeDasharray="3 2.4" />
      <path d="M12 9.6v4.8M10.4 11h2.6a1.1 1.1 0 0 1 0 2.2h-2" />
    </svg>
  );
}

export function IconCheck({ className = "w-4 h-4" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  );
}

export function IconArrowStart({ className = "w-4 h-4" }: IconProps) {
  /* سهم يشير لجهة البداية في RTL */
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14m0 0-5-5m5 5-5 5" transform="scale(-1,1) translate(-24,0)" />
    </svg>
  );
}

export function IconBolt({ className = "w-5 h-5" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5L13 2Z" />
    </svg>
  );
}

export function IconInfinity({ className = "w-5 h-5" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
      <path d="M8.2 8.6c-2.5 0-4.2 1.5-4.2 3.4s1.7 3.4 4.2 3.4c3.4 0 4.2-6.8 7.6-6.8 2.5 0 4.2 1.5 4.2 3.4s-1.7 3.4-4.2 3.4c-3.4 0-4.2-6.8-7.6-6.8Z" />
    </svg>
  );
}

export function IconMic({ className = "w-5 h-5" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" />
    </svg>
  );
}

export function IconTicks({ className = "w-4 h-3" }: IconProps) {
  /* علامتا القراءة في واتساب */
  return (
    <svg viewBox="0 0 18 12" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m1 6.5 3 3L9.5 3" />
      <path d="m7.5 8 1.5 1.5L16.5 3" />
    </svg>
  );
}

export function IconSparkle({ className = "w-5 h-5" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M12 3c.6 3.6 2 5.6 5.8 6.2-3.8.8-5.2 2.8-5.8 6.3-.6-3.5-2-5.5-5.8-6.3C10 8.6 11.4 6.6 12 3Z" />
      <path d="M18.8 14.5c.3 1.8 1 2.8 2.9 3.1-1.9.4-2.6 1.4-2.9 3.2-.3-1.8-1-2.8-2.9-3.2 1.9-.3 2.6-1.3 2.9-3.1Z" opacity="0.7" />
    </svg>
  );
}

export function IconMenu({ className = "w-6 h-6" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 7h16M4 12h10M4 17h16" />
    </svg>
  );
}

export function IconX({ className = "w-6 h-6" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

export function IconPlus({ className = "w-4 h-4" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function IconChevronDown({ className = "w-4 h-4" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9.5 6 6 6-6" />
    </svg>
  );
}

export function IconTrash({ className = "w-4 h-4" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 6.5h16M9.5 4h5M6.5 6.5l.8 12.2a2 2 0 0 0 2 1.8h5.4a2 2 0 0 0 2-1.8l.8-12.2" />
      <path d="M10 10.5v6M14 10.5v6" />
    </svg>
  );
}

export function IconSave({ className = "w-5 h-5" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 4h11.5L20 7.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" />
      <path d="M8 4v5h7V4M8 20v-6h8v6" />
    </svg>
  );
}
