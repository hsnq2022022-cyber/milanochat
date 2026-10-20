const fs = require('fs');
const path = 'src/pages/Dashboard.tsx';

if (!fs.existsSync(path)) {
    console.log('⚠️ الملف غير موجود:', path);
    process.exit(1);
}

let code = fs.readFileSync(path, 'utf8');
let modified = false;

// المتغيرات الشائعة التي تُستخدم لعرض اسم العميل أو الرسالة في القائمة
const vars = [
    'c.customerName', 'c.customer_name', 'c.name', 'chat.name', 'item.name',
    'c.lastMessage', 'c.last_message', 'c.preview', 'chat.lastMessage', 'item.preview'
];

for (const v of vars) {
    // نبحث عن المتغير داخل الأقواس {var}
    const regex = new RegExp(`\\{${v}\\}`, 'g');
    if (regex.test(code)) {
        // نغلفه بوسم span لمنع الترجمة
        code = code.replace(regex, `<span className="notranslate">{${v}}</span>`);
        modified = true;
        console.log(`✅ تم إيقاف ترجمة المتغير: ${v}`);
    }
}

if (modified) {
    fs.writeFileSync(path, code, 'utf8');
    console.log('✅ تم حفظ التعديلات في Dashboard.tsx بنجاح!');
} else {
    console.log('⚠️ لم أجد المتغيرات القياسية. سنقوم بصبغ القائمة بالكامل بـ notranslate...');
    // كحل بديل: البحث عن حاوية القائمة وإضافة notranslate لها
    const unifiedChatIndex = code.indexOf('Unified chat box');
    if (unifiedChatIndex !== -1) {
        // نبحث عن أول <div> بعد "Unified chat box"
        const divStart = code.indexOf('<div', unifiedChatIndex);
        if (divStart !== -1) {
            const divEnd = code.indexOf('>', divStart);
            let divTag = code.slice(divStart, divEnd);
            
            if (divTag.includes('className=')) {
                divTag = divTag.replace(/className="([^"]+)"/, 'className="$1 notranslate"');
                divTag = divTag.replace(/className=\{`([^`]+)`\}/, 'className={`$1 notranslate`}');
            } else {
                divTag = divTag.replace('<div', '<div className="notranslate"');
            }
            
            code = code.slice(0, divStart) + divTag + code.slice(divEnd);
            fs.writeFileSync(path, code, 'utf8');
            console.log('✅ تم إضافة notranslate إلى حاوية القائمة الجانبية بالكامل.');
        }
    } else {
        console.log('❌ لم أتمكن من العثور على مكان القائمة. قد تحتاج لتعديلها يدوياً.');
    }
}
