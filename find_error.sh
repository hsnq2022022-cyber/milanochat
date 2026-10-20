echo "======================================"
echo "🔍 1. أول 20 سطر من الملف (للتأكد من الاستيراد):"
head -n 20 src/components/Hero.tsx
echo "======================================"
echo "🔍 2. مكان بداية الدالة (export default function):"
grep -n "export default function" src/components/Hero.tsx
echo "======================================"
echo "🔍 3. مكان وجود useTranslation (هل تم حقنها؟):"
grep -n "useTranslation" src/components/Hero.tsx
echo "======================================"
echo "🔍 4. أول 3 أسطر تحتوي على t( (للتأكد من الاستبدال):"
grep -n "t('" src/components/Hero.tsx | head -n 3
echo "======================================"
echo "⚠️ انسخ هذه النتيجة وأرسلها لي فوراً."
