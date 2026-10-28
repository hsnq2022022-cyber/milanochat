-- Separate owner GO required. Preserves all publications, drafts and activations.
-- This disables only three specific service-only management RPCs.
BEGIN;
DROP FUNCTION IF EXISTS public.flow_deactivate_revision(uuid,uuid,text,text,uuid);
DROP FUNCTION IF EXISTS public.flow_activate_revision(uuid,uuid,text,text,bigint,uuid);
DROP FUNCTION IF EXISTS public.flow_publish_revision(uuid,uuid,text,text,uuid,jsonb);
COMMIT;
