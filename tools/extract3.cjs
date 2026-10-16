// سكربت داخلي مؤقت: استخراج الأجزاء العربية الحية (يُحذف بعد التنفيذ)
const { readFileSync, writeFileSync } = require("fs");

const files = [
  "src/App.tsx",
  "src/components/ChannelsSection.tsx",
  "src/components/ChatDemo.tsx",
  "src/components/Extras.tsx",
  "src/components/FAQ.tsx",
  "src/components/Guarantees.tsx",
  "src/components/Hero.tsx",
  "src/components/Navbar.tsx",
  "src/components/Pricing.tsx",
  "src/components/WidgetEditor.tsx",
  "src/components/WidgetPreview.tsx",
  "src/lib/channels.tsx",
  "src/pages/Dashboard.tsx",
  "src/pages/Widgets.tsx",
];

const AR = /[\u0600-\u06FF\u200c]/;

function partsOf(src) {
  const parts = [];
  const pushStr = (s) => {
    if (s && AR.test(s)) parts.push({ kind: "str", value: s });
  };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const e = src.indexOf("\n", i);
      i = e === -1 ? n : e;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      i = e === -1 ? n : e + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      let j = i + 1;
      let raw = "";
      let closed = false;
      let hasExpr = false;
      while (j < n) {
        if (src[j] === "\\") {
          raw += src[j] + (src[j + 1] || "");
          j += 2;
          continue;
        }
        if (q === "`" && src[j] === "$" && src[j + 1] === "{") {
          hasExpr = true;
          let depth = 1;
          j += 2;
          while (j < n && depth > 0) {
            if (src[j] === "{") depth++;
            else if (src[j] === "}") depth--;
            j++;
          }
          continue;
        }
        if (src[j] === q) {
          closed = true;
          break;
        }
        if (src[j] === "\n" && q !== "`") break;
        raw += src[j];
        j++;
      }
      if (!closed) {
        i++;
        continue;
      }
      if (raw.includes("\n")) {
        for (const line of raw.split("\n")) pushStr(line.trim());
      } else if (hasExpr) {
        for (const frag of raw.split(/\$\{[^{}]*\}/)) pushStr(frag.trim());
      } else {
        pushStr(raw);
      }
      i = j + 1;
      continue;
    }
    if (c === "<" && /[A-Za-z/\-]/.test(src[i + 1] || "")) {
      // وسم JSX — نجمع سماته النصية حتى علامة الإغلاق (مع تجاهل <> داخل تعبيرات بسيط)
      let j = i + 1;
      let depthBrace = 0;
      while (j < n) {
        const ch = src[j];
        if (ch === "{") depthBrace++;
        else if (ch === "}") depthBrace--;
        else if (ch === ">" && depthBrace === 0) break;
        j++;
      }
      const tag = src.slice(i, j + 1);
      const qs = [...tag.matchAll(/(["'])((?:\\.|(?!\1)[^\\])*)\1/g)];
      for (const m of qs) {
        const v = m[2].replace(/\\(["'`])/g, "$1");
        if (AR.test(v)) parts.push({ kind: "attr", quote: m[1], value: v });
      }
      i = j + 1;
      continue;
    }
    if (c === ">") {
      let j = i + 1;
      while (j < n && src[j] !== "<") j++;
      const text = src.slice(i + 1, j);
      if (AR.test(text) && !/[{}]/.test(text)) {
        const trimmed = text.trim();
        if (trimmed) parts.push({ kind: "jsx", value: trimmed });
      }
      i = j;
      continue;
    }
    i++;
  }
  return parts;
}

const out = {};
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const seen = new Set();
  const list = [];
  for (const p of partsOf(src)) {
    const key = p.kind + "|" + p.value;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(p);
  }
  out[f] = list;
}
writeFileSync("/tmp/parts.json", JSON.stringify(out, null, 1));
let total = 0;
for (const f in out) total += out[f].length;
console.log("files:", Object.keys(out).length, "unique parts:", total);
