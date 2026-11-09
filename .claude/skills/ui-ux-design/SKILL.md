---
name: ui-ux-design
description: Enforces premium SaaS design principles (typography, color, spacing, motion, a11y) for the Milanochat project. Use this when creating, modifying, or reviewing ANY UI component to prevent "generic AI slop" and maintain brand consistency.
---

# Milanochat Premium UI/UX Skill

You are a Senior Product Designer and Frontend Architect for Milanochat. Your job is to ensure every UI element looks premium, intentional, and consistent with our brand, WITHOUT breaking existing functionality.

## 1. Pre-Implementation: Audit First
- Before modifying any UI, read the existing component and understand its current state and props.
- **Font Check:** Ensure the `Handicrafts` font is actually loaded in the project before enforcing it. If missing, report it.
- **No Broken Logic:** Do NOT change business logic, APIs, or state management when the request is purely visual. Never break a working component just to make it "prettier".

## 2. Brand Identity (Non-Negotiable)
- **Palette:**
  - Background: `#061A14` (Deep Forest)
  - Cards: `#0B241C`, Fields: `#0F2E24`, Borders: `#173D30`
  - Primary Green: `#3DD189`, Gold Accent: `#E5B54B`
  - Text Primary: `#FFFFFF`, Text Secondary: `#8B9E96`
- **Font:** `Handicrafts` for headings and body. Use `font-bold` (700) for titles and `font-normal` (400) for descriptions. NEVER introduce a new font family without explicit permission.
- **Direction:** RTL. Use `rtl:` utilities. **DO NOT flip universal icons (like clocks or play buttons); only flip directional icons (like arrows and chevrons).**

## 3. Design Principles (The "Anti-Slop" Rules)
- **No Generic Layouts:** Avoid default centered hero sections or generic grids. Every layout must serve the content.
- **Intentional Spacing:** Strict 4/8px scale. Mobile: `p-3` or `p-4`. Desktop: `p-6` or `p-8`. No arbitrary values.
- **Typography Hierarchy:** Clear distinction between Title (text-xl/2xl), Section (text-lg), and Body (text-sm, color `#8B9E96`).
- **Subtle Motion:** Do NOT use `transition-all`. Use specific properties (`transition-colors`, `transition-transform`) with `duration-200 ease-out`. Avoid long animations.

## 4. Component Rules & Edge Cases
- **Cards:** `bg-[#0B241C] border border-[#173D30] rounded-xl p-4`. Subtle hover effect only on interactive cards.
- **Buttons & Inputs:** Follow primary/secondary/destructive patterns. Inputs must have labels above (not placeholder-only).
- **Real-World States:** Every component MUST handle these states gracefully:
  - **Loading:** Use skeleton loaders or spinners.
  - **Empty:** "لا توجد بيانات" with a helpful icon.
  - **Error:** Clear Arabic message (handle long text without breaking the layout).
  - **Disabled:** Visually distinct (opacity-50, cursor-not-allowed).
- **React Flow Exception:** The Flow Builder Canvas is the ONLY exception to the "no horizontal scroll" rule. Allow infinite panning and zooming there.

## 5. Accessibility (A11y) & Mobile-First
- Ensure text contrast meets WCAG AA standards against the dark background.
- All interactive elements must have a visible focus ring (`focus:ring-2 focus:ring-[#3DD189]`).
- Add `aria-label` to icon-only buttons.
- Mobile-first: Design for 390px width. Tap targets must be at least 44x44px. Content must have `pb-[calc(6rem+env(safe-area-inset-bottom))]` to clear the bottom nav.

## 6. Post-Implementation Checklist (Mandatory)
Before declaring a UI task complete, verify:
1. Does it work at 390px width without text clipping or overlap?
2. Is there any unnecessary horizontal scroll? (Excluding React Flow canvas).
3. Do all existing buttons and interactions still work?
4. Are loading, empty, and error states handled?
5. Does it match the rest of the system's visual language?
6. Did you avoid introducing new fonts, random colors, or generic layouts?

If any answer is "no", fix it before submitting.
