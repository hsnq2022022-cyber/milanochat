# دليل التشغيل الحقيقي الكامل — ميلانو

هذا الدليل يحوّل المشروع من «واجهة عرض» إلى نظام حقيقي: واتساب يرد فعلاً، معرفة تُخزن في Supabase، لوحة تحكم بحسابات حقيقية، ودفع مفعّل.

## المعمارية — افهم الصورة أولاً

```
المتصفح (GitHub Pages — ثابت)
   │  VITE_API_URL
   ▼
الخادم (Railway / VPS — Node.js)      ◄── كل شيء حقيقي يحدث هنا:
   │  ├─ جلسات واتساب (Baileys)           إنشاء الجلسة، QR، الردود، الخصم
   │  ├─ محرك RAG + LLM
   │  └─ الدفع (Moyasar webhook)
   ▼
Supabase (قاعدة البيانات + Auth)     ◄── التخزين: العملاء، المعرفة، المحادثات، الرصيد
```

- **GitHub Pages = عرض فقط.** لا يستطيع تشغيل Node ولا واتساب.
- **الخادم = العقل.** يجب أن يعمل 24/7 على Railway أو VPS.
- **Supabase = الذاكرة.** كل البيانات فيه، ومعك فعلاً كما ذكرت.

---

## الخطوة 1 — تجهيز Supabase

إن كان لديك مشروع Supabase جاهز تخطَّ إلى «المفاتيح».

1. [supabase.com](https://supabase.com) → **New Project** → اختر منطقة **EU Central (Frankfurt)** (الأقرب للسعودية) واحفظ كلمة مرور قاعدة البيانات.
2. من القائمة: **SQL Editor** → الصق محتوى `supabase/schema.sql` كاملاً → **Run**.
   - ينشئ: الامتداد pgvector، الجداول (tenants, knowledge_chunks, conversations, messages, unresolved_questions, payments…)، دوال الخصم الذرّي والبحث الدلالي ومنح الرصيد، وسياسات RLS.
3. تأكد من pgvector: **Database → Extensions** → ابحث عن **vector** → مفعّل.
4. جهّز الدخول للوحة التحكم: **Authentication → Providers → Email** → مفعّل.
   - للاختبار السريع: عطّل **Confirm email** من **Authentication → Settings** (لا تنسَ إعادته للإنتاج).

### المفاتيح (Project Settings → API)

| المفتاح | يُستخدم في | ملاحظة |
|---|---|---|
| Project URL | الخادم + الواجهة | `https://xxxx.supabase.co` |
| `anon public` | الواجهة فقط (`VITE_SUPABASE_ANON_KEY`) | آمن للعرض |
| `service_role` (اضغط Reveal) | **الخادم فقط** | خطر: يعطي صلاحيات كاملة — ممنوع في الواجهة أو Git |

---

## الخطوة 2 — مفاتيح الذكاء (LLM + Embeddings)

الأرخص والأكثر توافقًا: **OpenAI**
1. [platform.openai.com](https://platform.openai.com) → **API Keys** → أنشئ مفتاحًا.
2. اشحن رصيدًا (5$ تكفي شهورًا للتجربة) من **Billing**.
3. النماذج المستخدمة: `gpt-4o-mini` للردود و`text-embedding-3-small` للتمثيلات الدلالية.

لو تفضل Anthropic: مفتاح من [console.anthropic.com](https://console.anthropic.com) وغيّر في متغيرات الخادم:
`LLM_PROVIDER=anthropic`، `LLM_BASE_URL=https://api.anthropic.com`، `LLM_MODEL=claude-3-5-haiku-20241022`.

---

## الخطوة 3 — مفتاح التشفير الحقلي

يشفّر أرقام واتساب ومحتوى الرسائل داخل Supabase:
```bash
openssl rand -hex 32
```
ضع الناتج في `FIELD_ENCRYPTION_KEY`. **لا تدوّره لاحقًا** — البيانات المخزنة تُفك به.

---

## الخطوة 4 — نشر الخادم (أهم خطوة)

### الخيار الأسهل: Railway

1. [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo** → اختر مستودع `milanochat` → حدّد **Root Directory: `server`**.
2. أضف **Volume** واركّبه على المسار `/data` — **إلزامي**: بدونه تُمسح جلسات واتساب عند كل نشر ويعيد عملاؤك مسح QR.
3. في **Variables** أضف كل المتغيرات:

```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
FIELD_ENCRYPTION_KEY=<ناتج openssl>
LLM_PROVIDER=openai
LLM_API_KEY=sk-...
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
EMBED_API_KEY=sk-...
EMBED_BASE_URL=https://api.openai.com/v1
EMBED_MODEL=text-embedding-3-small
EMBED_DIM=1536
MOYASAR_SECRET_KEY=sk_test_...
MOYASAR_PUBLISHABLE_KEY=pk_test_...
MOYASAR_WEBHOOK_SECRET=...
PUBLIC_URL=https://اسمك.up.railway.app
FRONTEND_ORIGIN=https://hsnq2022022-cyber.github.io
DATA_DIR=/data
BASE_CREDITS=1000
SIMILARITY_THRESHOLD=0.25
RAG_TOP_K=5
PORT=4000
```
4. من **Settings → Networking** أنشئ **Public Domain** ← هذا هو `PUBLIC_URL`.
5. تحقق: افتح `https://اسمك.up.railway.app/health` → يجب أن ترى `{"ok":true}`.

### بديل: VPS (Hetzner/DigitalOcean — ~5$/شهر)

```bash
# على الخادم (Ubuntu):
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs nginx
sudo npm i -g pm2
git clone <مستودعك> && cd milanochat/server
npm install && cp .env.example .env   # املأ المتغيرات، DATA_DIR=/var/lib/milano
npm run build 2>/dev/null; pm2 start "npm run start" --name milano && pm2 save && pm2 startup
```
ثم nginx كوكيل عكسي على المنفذ 80/443 (مع شهادة Let's Encrypt)指向 `localhost:4000`.

---

## الخطوة 5 — الدفع (Moyasar)

1. سجّل في [moyasar.com](https://moyasar.com) — وضع الاختبار متاح فورًا؛ **المفاتيح الحقيقية تتطلب سجلًا تجاريًا سعوديًا**.
2. من لوحة Moyasar خذ: `secret key`، `publishable key`، وأنشئ **Webhook secret**.
3. ضعها في متغيرات الخادم. عند كل دفع ناجح تستدعي Moyasar المسار `/api/webhooks/moyasar` → يتحقق الخادم من التوقيع → **يفعّل الحساب ويمنح 1000 رد**. بدون تأكيد الـ webhook لا يتفعل أي حساب.
4. للاختبار استخدم بطاقات Moyasar التجريبية من توثيقهم.

---

## الخطوة 6 — بناء الواجهة ونشرها

أنشئ ملف `.env` في **جذر المشروع** (بجانب package.json):

```
VITE_API_URL=https://اسمك.up.railway.app
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
```

ثم:
```bash
npm run build
npx gh-pages -d dist
```

ملاحظات:
- متغيرات `VITE_*` تُخبز داخل البناء — أي تغيير يتطلب `npm run build` من جديد.
- `VITE_SUPABASE_URL/ANON` مخصصان لتسجيل الدخول في لوحة التحكم مباشرة من المتصفح.
- تأكد أن `FRONTEND_ORIGIN` في الخادم يطابق أصل موقعك بالضبط: `https://hsnq2022022-cyber.github.io` (بدون المسار `/milanochat/`).

---

## الخطوة 7 — الاختبار الحقيقي الكامل

| # | الاختبار | النتيجة المتوقعة |
|---|---|---|
| 1 | أنشئ موظفًا من الصفحة الرئيسية برابط موقع حقيقي | استخراج أسئلة/أجوبة حقيقي، وصفوف في جدول `knowledge_chunks` في Supabase |
| 2 | اضغط «اربط واتساب» | QR حقيقي يتجدد كل ~20 ثانية |
| 3 | امسحه من الجوال (الأجهزة المرتبطة) | CONNECTING ثم CONNECTED مع رقمك |
| 4 | أرسل رسالة من رقم آخر: «بكم الأسعار؟» | رد حقيقي من معرفتك، ونقصان في `credits_remaining` |
| 5 | اسأل شيئًا خارج معرفتك | اعتذار «ما عندي معلومات مؤكدة» + صف في `unresolved_questions` |
| 6 | اكتب «أبغى أتكلم مع بشري» | يتوقف الرد الآلي وتُعلَّم المحادثة محوّلة |
| 7 | أعد تشغيل الخادم | يعود متصلًا **بدون** QR جديد (الجلسة في الـ volume) |
| 8 | لوحة التحكم `#/dashboard`: سجّل حسابًا → انضم بالـ claimToken | الرصيد والمحادثات والعالقة حقيقية |
| 9 | حلّ سؤالاً عالقًا مع «أضفها للمعرفة» | صف جديد في `knowledge_chunks` — الموظف تعلمه فورًا |
| 10 | ادفع ببطاقة Moyasar التجريبية | تفعيل الحساب + 1000 رد تلقائيًا من الـ webhook |

---

## التكلفة الشهرية التقريبية

| البند | التكلفة |
|---|---|
| GitHub Pages (الواجهة) | مجاني |
| Supabase (مجاني: 500MB ثم Pro) | 0 – 25$ |
| الخادم Railway / VPS | ~5$ |
| OpenAI (gpt-4o-mini + embeddings) | < 1$ لآلاف الردود |
| Moyasar لكل عملية | 2.9% + 1 ريال تقريبًا |

---

## تحذيرات لا تتجاهلها

1. **واتساب (Baileys) غير رسمي من Meta** — خطر تقييد الرقم حقيقي. استخدم رقمًا مخصصًا للمشروع، بلا إرسال جماعي، وإحماء تدريجي. المسار الرسمي للترقية: WhatsApp Cloud API (التصميم جاهز لاستبدال الناقل فقط).
2. **`service_role` للخادم فقط** — لو وصل للمتصفح يستطيع أي شخص قراءة قاعدة بياناتك كاملة.
3. **Volume للخادم إلزامي** — بدون تخزين دائم يفقد العملاء ربطهم عند كل نشر.
4. **لا ترفع `.env` إلى Git** — هو في `.gitignore`؛ أضف المتغيرات في لوحة Railway مباشرة.
5. **بيانات عملاء حقيقيين = التزام PDPL** — سياسة الخصوصية جاهزة على `/privacy`، ولا تجمع أكثر مما يلزم.
