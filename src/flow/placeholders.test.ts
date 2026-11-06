import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FIRST_NAME_FALLBACK, MISSING_VALUE_FALLBACK, MAX_LABEL_CHARS, hasPlaceholder, replacePlaceholders,
  sanitizePlaceholders, sanitizeLabel, clipUtf8Bytes, clipChars
} from "./placeholders.ts";

const M = MISSING_VALUE_FALLBACK, F = FIRST_NAME_FALLBACK;
test("constants", () => {
  assert.equal(F, "عميلنا العزيز");
  assert.equal(M, "[غير متوفر]");
  assert.equal(MAX_LABEL_CHARS, 20);
});
test("matching: ASCII, Arabic, spaces, inner whitespace, Arabic-Indic digits, punctuation, long names", () => {
  assert.equal(sanitizePlaceholders("Hi {{first_name}} / {{ first_name }} / {{\tfirst_name }}"), `Hi ${F} / ${F} / ${F}`);
  assert.equal(sanitizePlaceholders("{{age}} {{ age }} {{رقم الهاتف}} {{ اسم العميل }}"), `${M} ${M} ${M} ${M}`);
  assert.equal(sanitizePlaceholders("{{رقم١٢٣}} {{field_1}} {{٣}} {{first-name}} {{a.b}}"), `${M} ${M} ${M} ${M} ${M}`);
  assert.equal(sanitizePlaceholders("{{" + "س".repeat(300) + "}}"), M, "long names are still replaced, never literal");
  assert.equal(sanitizePlaceholders("{{}} {{   }}"), `${M} ${M}`, "empty name: still a {{...}} pair, replaced");
  assert.equal(sanitizePlaceholders("{{FIRST_NAME}}"), M, "names are case-sensitive");
});
test("non-placeholders: lone, unbalanced, newline-split braces stay as they are", () => {
  for (const s of ["{{", "}}", "a {{ b", "a }} b", "{x}", "{{a\nb}}", "{{a\r\nb}}", "}}{{"])
    assert.equal(sanitizePlaceholders(s), s, JSON.stringify(s));
  assert.equal(sanitizePlaceholders("{{{age}}}"), `{${M}}`, "nested: inner pair replaced, single braces remain");
  assert.equal(sanitizePlaceholders("{{a{{age}}"), `{{a${M}`, "lone {{ before a placeholder is kept");
  assert.equal(sanitizePlaceholders("{{age}}}}"), `${M}}}`);
  assert.equal(hasPlaceholder("{{"), false);
  assert.equal(hasPlaceholder("x {{ y }}"), true);
  assert.equal(hasPlaceholder(undefined), false);
  assert.equal(hasPlaceholder(42), false);
});
test("single pass and identity", () => {
  assert.equal(replacePlaceholders("{{a}}", () => "{{a}}"), "{{a}}", "replacement values are never re-scanned");
  const plain = "نص عادي بلا متغيرات { }";
  assert.equal(sanitizePlaceholders(plain), plain);
  let calls = 0;
  replacePlaceholders("{{ x }}", (name, whole) => { calls++; assert.equal(name, "x"); assert.equal(whole, "{{ x }}"); return ""; });
  assert.equal(calls, 1);
});
test("clipping: 1000-byte edge on a code point boundary; chars by code points and UTF-16", () => {
  const enc = new TextEncoder();
  const raw = "ع".repeat(495) + "{{age}}"; // 990 + 7 bytes
  assert.equal(enc.encode(raw).byteLength, 997);
  const out = clipUtf8Bytes(sanitizePlaceholders(raw), 1000);
  assert.ok(enc.encode(out).byteLength <= 1000);
  assert.equal(out, "ع".repeat(495) + "[غير م", "990 + 1 + 6 + 1 + 2 = 1000 bytes");
  assert.equal(clipUtf8Bytes("abc", 1000), "abc");
  assert.equal(clipChars("😀".repeat(15), 20), "😀".repeat(10), "UTF-16 length bound");
  assert.equal(clipChars("ابت", 20), "ابت");
});
test("labels: placeholder labels resolved, blank -> fallback, <= 20; plain labels untouched", () => {
  assert.equal(sanitizeLabel("اشتراكات"), "اشتراكات");
  assert.equal(sanitizeLabel("{{first_name}}"), "عميلنا العزيز");
  assert.equal(sanitizeLabel("{{رقم الهاتف}} {{a}}"), "[غير متوفر] [غير متو");
  assert.equal(sanitizeLabel("{{x}}", () => " "), M, "blank after substitution");
  for (const l of ["{{first_name}} {{first_name}}", "{{a}}{{b}}{{c}}"]) {
    const out = sanitizeLabel(l);
    assert.ok([...out].length <= 20 && out.length <= 20);
    assert.doesNotMatch(out, /\{\{[^{}\r\n]*\}\}/);
  }
});
