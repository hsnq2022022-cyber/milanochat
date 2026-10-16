// سكربت التوليد النهائي: يقرأ src/i18n/strings.json وينشئ ملفات الترجمة وقاموس الاستبدال (يُحذف لاحقاً)
const { readFileSync, writeFileSync } = require("fs");

const data = JSON.parse(readFileSync("src/i18n/strings.json", "utf8"));
const AR = /[\u0600-\u06FF\u200c]/;

const dict = {}; // ar -> en
for (const file of Object.keys(data)) {
  const entries = Array.isArray(data[file]) ? data[file] : Object.entries(data[file]);
  for (const item of entries) {
    if (Array.isArray(item)) {
      const [ar, en] = item;
      if (!ar || !en) throw new Error(`ترجمة ناقصة في ${file}: ${JSON.stringify(item)}`);
      if (dict[ar] && dict[ar] !== en) {
        console.warn(`تحذير: تعارض ترجمة لـ "${ar}" داخل ${file} — يُستخدم الأخير`);
      }
      dict[ar] = en;
    } else {
      const ar = item;
      if (dict[ar] === undefined) throw new Error(`ترجمة مفقودة (${file}): ${JSON.stringify(ar.slice(0, 60))}`);
    }
  }
}

// ترتيب حسب الطول تنازلياً لتجنب تداخل السلاسل المتضمنة
const keys = Object.keys(dict).sort((a, b) => b.length - a.length);

// 1) قاموس الاستبدال (يُصدَّر من ar.ts كي تبقى النصوص العربية في ملف واحد)
const replaceLines = keys.map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(dict[k])},`);
writeFileSync(
  "src/i18n/replace.ts",
  `// ملف مُولَّد تلقائياً بواسطة tools/generate.cjs — لا يعدَّل يدوياً.\n// يربط كل نص عربي ظاهر في الواجهة مقابل الإنجليزية.\nexport const REPLACE: Record<string, string> = {\n${replaceLines.join("\n")}\n};\n`,
  "utf8"
);

// 2) دالة استخراج الأجزاء العربية الحية من ملف مصدري
function arabicParts(src) {
  const parts = [];
  const push = (s) => {
    if (s && AR.test(s)) parts.push(s);
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
        parts.push({ bad: true });
        i++;
        continue;
      }
      if (raw.includes("\n")) {
        for (const line of raw.split("\n")) push(line.trim());
      } else if (hasExpr) {
        for (const frag of raw.split(/\$\{[^{}]*\}/)) push(frag.trim());
      } else {
        push(raw);
      }
      i = j + 1;
      continue;
    }
    if (c === "<" && /[A-Za-z/\-]/.test(src[i + 1] || "")) {
      const gt = src.indexOf(">", i);
      if (gt !== -1) {
        const tag = src.slice(i, gt + 1);
        const qs = [...tag.matchAll(/(["'])((?:\\.|(?!\1)[^\\])*)\1/g)];
        for (const m of qs) {
          const v = m[2].replace(/\\(["'`])/g, "$1");
          if (AR.test(v)) parts.push({ attr: { quote: m[1], value: v } });
        }
        i = gt + 1;
        continue;
      }
    }
    if (c === ">") {
      let j = i + 1;
      while (j < n && src[j] !== "<") j++;
      const text = src.slice(i + 1, j);
      if (AR.test(text) && !/[{}]/.test(text)) {
        const first = text.replace(/^\s+/, "");
        const last = text.replace(/\s+$/, "");
        const startWs = first === "" ? "" : text.slice(0, text.length - first.length);
        const endWs = last === "" ? "" : text.slice(last.length);
        const core = first === "" ? "" : last.slice(0, last.length - first.length + (text.length - text.trimEnd().length >= 0 ? 0 : 0));
        parts.push({ jsx: { lead: startWs, tail: endWs, value: text.trim() } });
      }
      i = j;
      continue;
    }
    i++;
  }
  return parts;
}

function decodeEntire(s) {
  return s
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function encodeJsxText(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const files = Object.keys(data);
let totalRepl = 0;
let failures = [];

for (const file of files) {
  let src = readFileSync(file, "utf8");
  const parts = arabicParts(src);
  let count = 0;
  for (const p of parts) {
    if (p.bad) {
      failures.push(`${file}: سطر غير مكتمل`);
      continue;
    }
    if (typeof p === "string") {
      // جزء نصي عادي (سطر كامل أو مقطع من قالب)
      const key = p;
      let repl;
      if (dict[key] !== undefined) {
        repl = decodeEntire(dict[key]);
      } else {
        // محاولة مطابقة بعد فك الترميز (مثل \" داخل السلسلة)
        const decoded = decodeEntire(key);
        if (decoded !== key && dict[decoded] !== undefined) {
          repl = decodeEntire(dict[decoded]);
        } else {
          failures.push(`${file}: ترجمة مفقودة للجزء: ${JSON.stringify(key.slice(0, 70))}`);
          continue;
        }
      }
      const idx = src.indexOf(key);
      if (idx === -1) {
        failures.push(`${file}: الجزء غير موجود نصياً: ${JSON.stringify(key.slice(0, 50))}`);
        continue;
      }
      src = src.slice(0, idx) + repl + src.slice(idx + key.length);
      count++;
    } else if (p.attr) {
      const key = p.attr.value;
      const en = dict[key] !== undefined ? dict[key] : dict[decodeEntire(key)];
      if (en === undefined) {
        failures.push(`${file}: ترجمة مفقودة لسمة: ${JSON.stringify(key.slice(0, 60))}`);
        continue;
      }
      const token = p.attr.quote + key + p.attr.quote;
      const outTok = p.attr.quote + decodeEntire(en) + p.attr.quote;
      const idx = src.indexOf(token);
      if (idx === -1) {
        failures.push(`${file}: سمة غير موجودة: ${JSON.stringify(key.slice(0, 50))}`);
        continue;
      }
      src = src.slice(0, idx) + outTok + src.slice(idx + token.length);
      count++;
    } else if (p.jsx) {
      const key = p.jsx.value;
      const en = dict[key] !== undefined ? dict[key] : dict[decodeEntire(key)];
      if (en === undefined) {
        failures.push(`${file}: ترجمة مفقودة لنص JSX: ${JSON.stringify(key.slice(0, 60))}`);
        continue;
      }
      const token = p.jsx.lead + key + p.jsx.tail;
      const outTok = p.jsx.lead.replace(/ /g, "") + "{" + JSON.stringify(decodeEntire(en)) + "}" + p.jsx.tail.replace(/ /g, "");
      const idx = src.indexOf(token);
      if (idx === -1) {
        failures.push(`${file}: كتلة JSX غير موجودة: ${JSON.stringify(key.slice(0, 50))}`);
        continue;
      }
      src = src.slice(0, idx) + outTok + src.slice(idx + token.length);
      count++;
    }
  }
  writeFileSync(file, src, "utf8");
  totalRepl += count;
  console.log(`${file}: ${count} استبدال`);
}

console.log(`المجموع: ${totalRepl} استبدال، قاموس بحجم ${keys.length}`);
if (failures.length) {
  console.log("== إخفاقات ==");
  console.log(failures.join("\n"));
  writeFileSync("/tmp/failures.txt", failures.join("\n"));
}
