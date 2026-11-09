/**
 * RFC 4122 v4 id that also works in INSECURE contexts.
 *
 * `crypto.randomUUID()` only exists in secure contexts (https or localhost). On a plain
 * `http://192.168.x.x` page it is `undefined`, so calling it throws and blanks the screen.
 * `crypto.getRandomValues()` IS available there, so the fallback stays cryptographically random
 * (image upload paths rely on unguessable ids). `Math.random` is only the last resort for
 * environments with no Web Crypto at all.
 *
 * Pure and dependency-free: this file is also reachable from the edge functions via src/flow/model.ts.
 */
export function uuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  const h = Array.from(b, x => x.toString(16).padStart(2, "0"));
  return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10).join("")}`;
}
