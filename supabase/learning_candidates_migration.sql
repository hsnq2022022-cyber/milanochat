-- ═══════════════════════════════════════════════════════════════════════════
-- Migration: إضافة جدول المعلومات المرشحة للتعلم
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.learning_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  session_id UUID REFERENCES public.widget_sessions(id) ON DELETE SET NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS learning_candidates_tenant_idx 
ON public.learning_candidates (tenant_id, status);

CREATE INDEX IF NOT EXISTS learning_candidates_session_idx 
ON public.learning_candidates (session_id);

-- سياسة RLS
ALTER TABLE public.learning_candidates ENABLE ROW LEVEL SECURITY;

CREATE POLICY learning_candidates_owner ON public.learning_candidates
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.tenants t 
      WHERE t.id = tenant_id AND t.user_id = auth.uid()
    )
  );
