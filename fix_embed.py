import re

file_path = "supabase/functions/milan-api/index.ts"

try:
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    new_embed_func = '''async function embed(
  texts: string[]
): Promise<number[][]> {
  const key = aiKey("embed");
  if (!key) throw new Error("No API key found for embeddings");

  // إذا كان المفتاح يخص Google (يبدأ بـ AIza)
  if (key.startsWith("AIza")) {
    const res = await fetchRetry(
      `https://generativelanguage.googleapis.com/v1/models/text-embedding-004:batchEmbedContents?key=${key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requests: texts.map(text => ({
            model: "models/text-embedding-004",
            content: { parts: [{ text }] }
          }))
        }),
      }
    );
    if (!res.ok) throw new Error(`Gemini embedding ${res.status}: ${await res.text()}`);
    const j = await res.json();
    return j.embeddings.map((e: any) => e.values);
  }

  // الإعداد الافتراضي لـ OpenAI
  const res = await fetchRetry(
    `${env("EMBED_BASE_URL") || "https://api.openai.com/v1"}/embeddings`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: env("EMBED_MODEL") || "text-embedding-3-small",
        input: texts,
      }),
    }
  );
  if (!res.ok) throw new Error(`OpenAI embedding ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return j.data.map((d: { embedding: number[] }) => d.embedding);
}
'''

    # استبدال الدالة القديمة بالجديدة
    pattern = r'async function embed\([\s\S]*?\n\}\n\nconst pg ='
    new_content = re.sub(pattern, new_embed_func + '\nconst pg =', content)

    if new_content != content:
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(new_content)
        print("✅ تم إصلاح دالة embed بنجاح لدعم Google Gemini!")
    else:
        print("❌ لم يتم العثور على دالة embed. لم يتم التعديل.")
except Exception as e:
    print(f"❌ حدث خطأ: {e}")
