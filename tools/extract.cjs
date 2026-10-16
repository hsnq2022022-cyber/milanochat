// سكربت داخلي مؤقت لاستخراج السلاسل العربية من ملفات الواجهة (يُحذف بعد الاستخدام)
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
const out = {};

for (const f of files) {
  const src = readFileSync(f, "utf8");
  const set = new Set();
  const re = /(["'`])((?:\\.|(?!\1)[^\\\r\n])*)\1/g;
  let m;
  while ((m = re.exec(src))) {
    const s = m[2];
    if (AR.test(s)) set.add(s);
  }
  for (const line of src.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) continue;
    if (AR.test(t)) {
      const stripped = t.replace(/<[^>]*>/g, "\u0001").replace(/[{}()=[\],;:?&|.!+]/g, "\u0001");
      for (const frag of stripped.split("\u0001")) {
        const s = frag.trim();
        if (s && AR.test(s) && s.length < 300) set.add(s);
      }
    }
  }
  out[f] = [...set].sort();
}
writeFileSync("/tmp/strings.json", JSON.stringify(out, null, 1), "utf8");
console.log(Object.entries(out).map(([k, v]) => `${k}: ${v.length}`).join("\n"));
