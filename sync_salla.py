import re

file_path = "supabase/functions/milan-api/index.ts"

try:
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    if 'case "sync_salla_products":' in content:
        print("⚠️ إجراء المزامنة موجود بالفعل، لن يتم التعديل.")
    else:
        injection = '''
      /* ────────────────────────────────────────────────────────────────
         مزامنة منتجات سلة إلى قاعدة المعرفة
      ──────────────────────────────────────────────────────────────── */
      case "sync_salla_products": {
        const { data: sallaAcc } = await sb
          .from("accounts")
          .select("access_token_encrypted")
          .eq("tenant_id", tenant.id)
          .eq("channel", "salla")
          .maybeSingle();

        if (!sallaAcc || !sallaAcc.access_token_encrypted) {
          return err("لم يتم العثور على توكن سلة. يرجى إعادة ربط المتجر.", 400);
        }

        const token = await decryptField(sallaAcc.access_token_encrypted);

        // جلب المنتجات من واجهة سلة
        const sallaRes = await fetch("https://api.salla.dev/admin/v2/products?per_page=50", {
          headers: { 
            "Authorization": `Bearer ${token}`, 
            "Accept": "application/json" 
          }
        });

        if (!sallaRes.ok) {
          return err("فشل الاتصال بـ Salla API. تأكد من صلاحية التوكن.", 502);
        }

        const sallaData = await sallaRes.json();
        const products = sallaData.data || [];

        if (products.length === 0) {
          return json({ success: true, message: "لا توجد منتجات لمزامنتها." });
        }

        // تحويل المنتجات إلى نص
        let fullText = "قائمة منتجات المتجر الحالية:\\n";
        for (const p of products) {
          const price = p.price ? `${p.price.amount} ${p.price.currency}` : "غير محدد";
          const stock = p.quantity > 0 ? "متوفر" : "غير متوفر";
          fullText += `\\n- المنتج: ${p.name}\\n  السعر: ${price}\\n  الحالة: ${stock}\\n  الوصف: ${p.description || "لا يوجد وصف"}\\n  الرابط: ${p.url}\\n`;
        }

        // التقسيم وإنشاء الـ Embeddings
        const chunks = chunkText(fullText);
        const vectors = await embed(chunks);

        // حذف المنتجات القديمة من قاعدة المعرفة لتجنب التكرار
        await sb.from("knowledge_sources")
          .delete()
          .eq("tenant_id", tenant.id)
          .eq("kind", "salla_products");

        // حفظ المصدر الجديد
        const { data: src, error: srcError } = await sb
          .from("knowledge_sources")
          .insert({
            tenant_id: tenant.id,
            kind: "salla_products",
            url: "salla://products",
            status: "indexed",
            chunks_count: chunks.length,
          })
          .select()
          .single();

        if (srcError || !src) return err("تعذر إنشاء مصدر البيانات.", 500);

        // حفظ النصوص والـ Embeddings
        const { error: chunksError } = await sb
          .from("knowledge_chunks")
          .insert(
            chunks.map((content, i) => ({
              tenant_id: tenant.id,
              source_id: src.id,
              chunk_index: i,
              content,
              embedding: pg(vectors[i]),
            }))
          );

        if (chunksError) {
          return err("فشل حفظ المنتجات في قاعدة المعرفة.", 500);
        }

        return json({
          success: true,
          message: `تمت مزامنة ${products.length} منتج بنجاح.`,
          chunks: chunks.length
        });
      }

'''
        # حقن الكود قبل case "knowledge_add"
        pattern = r'(case "knowledge_add": \{)'
        new_content = re.sub(pattern, injection + r'\n      \1', content, count=1)

        if new_content != content:
            with open(file_path + ".bak", "w", encoding="utf-8") as f:
                f.write(content)
            with open(file_path, "w", encoding="utf-8") as f:
                f.write(new_content)
            print("✅ تم إضافة إجراء sync_salla_products بنجاح!")
            print("💾 تم إنشاء نسخة احتياطية باسم index.ts.bak")
        else:
            print("❌ لم يتم العثور على مكان الحقن. لم يتم التعديل.")
except Exception as e:
    print(f"❌ حدث خطأ: {e}")
