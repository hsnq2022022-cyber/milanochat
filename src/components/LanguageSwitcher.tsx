import { useTranslation } from 'react-i18next';
import { useEffect } from 'react';

export default function LanguageSwitcher() {
  const { i18n } = useTranslation();

  const toggleLanguage = () => {
    const newLang = i18n.language === 'ar' ? 'en' : 'ar';
    i18n.changeLanguage(newLang);
  };

  // تحديث اتجاه الصفحة (RTL للعربية، LTR للإنجليزية) عند تغيير اللغة
  useEffect(() => {
    document.documentElement.dir = i18n.language === 'ar' ? 'rtl' : 'ltr';
    document.documentElement.lang = i18n.language;
  }, [i18n.language]);

  return (
    <button 
      onClick={toggleLanguage}
      style={{
        padding: '8px 16px',
        borderRadius: '8px',
        border: '1px solid #25D366',
        background: 'transparent',
        color: '#25D366',
        cursor: 'pointer',
        fontWeight: 'bold'
      }}
    >
      {i18n.language === 'ar' ? 'English' : 'عربي'}
    </button>
  );
}
