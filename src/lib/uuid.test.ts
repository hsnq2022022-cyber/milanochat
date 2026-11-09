import test from "node:test";
import assert from "node:assert/strict";
import { uuid } from "./uuid.ts";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const realCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
const setCrypto = (v: unknown) => Object.defineProperty(globalThis, "crypto", { value: v, configurable: true, writable: true });
const restore = () => { if (realCrypto) Object.defineProperty(globalThis, "crypto", realCrypto); };

test("uses crypto.randomUUID when it exists (secure context)", () => {
  assert.match(uuid(), V4);
});

test("insecure context: randomUUID missing, getRandomValues available -> valid v4, unique", () => {
  setCrypto({ getRandomValues: (a: Uint8Array) => { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256); return a; } });
  try {
    const ids = new Set(Array.from({ length: 500 }, () => uuid()));
    assert.equal(ids.size, 500);
    for (const id of ids) assert.match(id, V4);
  } finally { restore(); }
});

test("fallback goes through getRandomValues (cryptographic), not Math.random", () => {
  let calls = 0;
  setCrypto({ getRandomValues: (a: Uint8Array) => { calls++; a.fill(0xab); return a; } });
  const orig = Math.random; Math.random = () => { throw new Error("Math.random must not be used when getRandomValues exists"); };
  try { assert.match(uuid(), V4); assert.equal(calls, 1); } finally { Math.random = orig; restore(); }
});

test("no Web Crypto at all: last-resort Math.random path still yields a valid v4 id", () => {
  setCrypto(undefined);
  try { assert.match(uuid(), V4); } finally { restore(); }
});
