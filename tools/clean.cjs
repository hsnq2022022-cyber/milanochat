// تنظيف أولي: حذف الشظايا والتعليقات (يُحذف لاحقاً)
const { readFileSync, writeFileSync } = require("fs");
const d = JSON.parse(readFileSync("/tmp/strings.json", "utf8"));
for (const k in d) {
  d[k] = d[k].filter(
    (s) =>
      !s.startsWith("/*") &&
      !s.startsWith("*") &&
      !s.startsWith("//") &&
      !/^".*"$/.test(s) &&
      s.length > 1
  );
}
writeFileSync("/tmp/strings.json", JSON.stringify(d, null, 1));
const all = new Set();
for (const k in d) d[k].forEach((s) => all.add(s));
console.log("unique:", all.size);
