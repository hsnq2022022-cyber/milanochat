import { useEffect, useState } from 'react';

export default function LanguageSwitcher() {
  const [currentLang, setCurrentLang] = useState('ar');

  useEffect(() => {
    // التحقق من الكوكيز لمعرفة اللغة الحالية
    const match = document.cookie.match(/googtrans=\/ar\/([a-z]+)/);
    if (match && match[1]) {
      setCurrentLang(match[1]);
    }
  }, []);

  const changeLanguage = (lang: string) => {
    // تعيين كوكيز جوجل للترجمة
    document.cookie = `googtrans=/ar/${lang}; path=/`;
    document.cookie = `googtrans=/ar/${lang}; domain=.${window.location.hostname}; path=/`;
    // إعادة تحميل الصفحة لتطبيق الترجمة
    window.location.reload();
  };

  return (
    <select 
      value={currentLang}
      onChange={(e) => changeLanguage(e.target.value)}
      style={{
        padding: '6px 12px',
        borderRadius: '8px',
        border: '1px solid #25D366',
        background: 'transparent',
        color: '#25D366',
        cursor: 'pointer',
        fontWeight: 'bold'
      }}
    >
      <option value="ar">عربي</option>
      <option value="en">English</option>
    </select>
  );
}
