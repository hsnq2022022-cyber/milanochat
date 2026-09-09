-- ═══════════════════════════════════════════════════════════════════════════════
-- Milano Knowledge Base Enhancement - Phase 1
-- تحسين نظام مصادر المعرفة لدعم أنواع متعددة وmetadata
-- ═══════════════════════════════════════════════════════════════════════════════

-- إضافة أعمدة جديدة لجدول knowledge_sources
ALTER TABLE public.knowledge_sources
ADD COLUMN IF NOT EXISTS name text,
ADD COLUMN IF NOT EXISTS file_type text,
ADD COLUMN IF NOT EXISTS file_size integer,
ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS last_synced_at timestamptz,
ADD COLUMN IF NOT EXISTS enabled boolean DEFAULT true;

-- إضافة أعمدة جديدة لجدول knowledge_chunks
ALTER TABLE public.knowledge_chunks
ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS title text,
ADD COLUMN IF NOT EXISTS section text,
ADD COLUMN IF NOT EXISTS page_number integer;

-- إنشاء فهرس للبحث النصي الكامل (Full Text Search)
CREATE INDEX IF NOT EXISTS knowledge_chunks_content_fts_idx
ON public.knowledge_chunks
USING GIN (to_tsvector('arabic', content));

-- إنشاء فهرس للـ metadata
CREATE INDEX IF NOT EXISTS knowledge_chunks_metadata_idx
ON public.knowledge_chunks USING GIN (metadata);

-- دالة بحث هجين (Vector + Full Text)
CREATE OR REPLACE FUNCTION public.hybrid_search_knowledge(
  p_tenant_id uuid,
  p_query vector,
  p_text_query text,
  p_limit integer DEFAULT 10,
  p_threshold real DEFAULT 0.25
)
RETURNS TABLE (
  id uuid,
  content text,
  similarity real,
  source_type text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH vector_results AS (
    SELECT 
      kc.id,
      kc.content,
      1 - (kc.embedding <=> p_query)::real as similarity,
      'vector' as source_type
    FROM public.knowledge_chunks kc
    WHERE kc.tenant_id = p_tenant_id
      AND kc.embedding IS NOT NULL
      AND 1 - (kc.embedding <=> p_query) > p_threshold
    ORDER BY kc.embedding <=> p_query
    LIMIT p_limit * 2
  ),
  text_results AS (
    SELECT 
      kc.id,
      kc.content,
      ts_rank(to_tsvector('arabic', kc.content), plainto_tsquery('arabic', p_text_query))::real as similarity,
      'text' as source_type
    FROM public.knowledge_chunks kc
    WHERE kc.tenant_id = p_tenant_id
      AND to_tsvector('arabic', kc.content) @@ plainto_tsquery('arabic', p_text_query)
    ORDER BY similarity DESC
    LIMIT p_limit * 2
  ),
  combined AS (
    SELECT * FROM vector_results
    UNION
    SELECT * FROM text_results
  )
  SELECT 
    id,
    content,
    MAX(similarity) as similarity,
    'hybrid' as source_type
  FROM combined
  GROUP BY id, content
  ORDER BY similarity DESC
  LIMIT p_limit;
END;
$$;

-- إضافة جدول لإعدادات اللهجات لكل tenant
CREATE TABLE IF NOT EXISTS public.tenant_dialect_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL UNIQUE REFERENCES public.tenants(id) ON DELETE CASCADE,
  dialect text NOT NULL DEFAULT 'arabic_fusha' CHECK (dialect IN (
    'arabic_fusha',
    'arabic_iraqi',
    'arabic_saudi',
    'arabic_emirati',
    'arabic_kuwaiti',
    'arabic_qatari',
    'arabic_bahraini',
    'arabic_omani',
    'arabic_gulf',
    'english',
    'auto_detect'
  )),
  formality text NOT NULL DEFAULT 'natural' CHECK (formality IN ('formal', 'natural', 'casual')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- دالة للحصول على إعدادات اللهجة
CREATE OR REPLACE FUNCTION public.get_tenant_dialect(p_tenant_id uuid)
RETURNS TABLE (dialect text, formality text)
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  SELECT dialect, formality
  FROM public.tenant_dialect_settings
  WHERE tenant_id = p_tenant_id;
$$;
