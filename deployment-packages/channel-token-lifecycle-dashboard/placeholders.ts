/**
 * Shared, pure placeholder handling for customer-facing flow text (V2 simple
 * replies, V3 durable planner and the outbox worker). No env, no IO, no Deno
 * APIs: imported by src/flow and by Edge Functions via a relative path.
 *
 * A placeholder is `{{` + any run of characters except braces and line breaks
 * + `}}` (ASCII, Arabic, digits incl. Arabic-Indic, spaces, punctuation, any
 * length). The name is the inner text trimmed. A lone `{{` or `}}`, braces
 * split by a line break, or `{{a{b}}` are NOT placeholders and are left as is;
 * in `{{{x}}}` only the inner `{{x}}` is a placeholder (single braces remain).
 * Replacement is a single left-to-right pass: substituted values are never
 * re-scanned.
 */
/** Customer-facing replacement for an uncollected {{first_name}}. */
export const FIRST_NAME_FALLBACK = "عميلنا العزيز";
/** Customer-facing replacement for any other unavailable placeholder. */
export const MISSING_VALUE_FALLBACK = "[غير متوفر]";
/** Max code points of a quick-reply / website-button title (Meta limit). */
export const MAX_LABEL_CHARS = 20;

const PATTERN = /\{\{([^{}\r\n]*)\}\}/;
/** True when `text` contains at least one placeholder. */
export function hasPlaceholder(text: unknown): boolean {
  return typeof text === "string" && text.includes("{{") && PATTERN.test(text);
}
/** Single pass; `resolve` gets the trimmed name and the whole match. */
export function replacePlaceholders(text: string, resolve: (name: string, whole: string) => string): string {
  if (!text.includes("{{")) return text;
  return text.replace(new RegExp(PATTERN.source, "g"), (whole, inner: string) => resolve(inner.trim(), whole));
}
/** No collected values available (V2, worker): first_name -> FIRST_NAME_FALLBACK, any other -> MISSING_VALUE_FALLBACK. */
export function sanitizePlaceholders(text: string): string {
  return replacePlaceholders(text, name => name === "first_name" ? FIRST_NAME_FALLBACK : MISSING_VALUE_FALLBACK);
}
/** Cuts to at most `max` UTF-8 bytes on a code point boundary. */
export function clipUtf8Bytes(text: string, max: number): string {
  const enc = new TextEncoder();
  if (enc.encode(text).byteLength <= max) return text;
  let out = "", used = 0;
  for (const ch of text) {
    const n = enc.encode(ch).byteLength;
    if (used + n > max) break;
    out += ch; used += n;
  }
  return out;
}
/**
 * Cuts on a code point boundary so that BOTH the code point count and the
 * UTF-16 length stay <= max (Meta counts code points; some validators use
 * String.length).
 */
export function clipChars(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = "", points = 0;
  for (const ch of text) {
    if (points + 1 > max || out.length + ch.length > max) break;
    out += ch; points++;
  }
  return out;
}
/**
 * Customer-facing button/choice title: placeholders resolved (default: the
 * no-collected-values rule), a blank result becomes MISSING_VALUE_FALLBACK,
 * then clipped to MAX_LABEL_CHARS. A label without placeholders is returned
 * unchanged (identity).
 */
export function sanitizeLabel(label: string, resolve?: (name: string, whole: string) => string): string {
  if (!hasPlaceholder(label)) return label;
  const out = resolve ? replacePlaceholders(label, resolve) : sanitizePlaceholders(label);
  return clipChars(out.trim() ? out : MISSING_VALUE_FALLBACK, MAX_LABEL_CHARS);
}
