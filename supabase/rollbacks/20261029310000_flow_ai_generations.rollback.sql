-- REVIEW ONLY rollback for 20261029310000_flow_ai_generations.
-- NOT applied anywhere by this repository.
--
-- Disable / undeploy generate-flow FIRST (FLOW_AI_BUILDER_ENABLED unset):
-- otherwise every AI flow request fails closed once these functions are gone.
--
-- Drops public.flow_ai_generation_reserve(uuid,uuid,text,integer),
-- public.flow_ai_generation_commit(uuid,uuid,jsonb),
-- public.flow_ai_generation_release(uuid,uuid) and public.flow_ai_generations,
-- each ONLY when it carries the marker
-- CREATED_BY_20261029310000_FLOW_AI_GENERATIONS (an unmarked object of the
-- same name makes the rollback REFUSE as a whole).
-- Data guards:
--  * 'reserved' rows hold customer credits: the rollback ALWAYS refuses while
--    any exist (release them, or wait 180 s and let a reserve sweep them).
--  * otherwise the table is the AI builder charge / refund audit trail: when
--    it holds rows the rollback REFUSES unless the session setting
--    milan.rollback_310000 = 'discard-flow-ai-generations' is set
--    (e.g. PGOPTIONS='-c milan.rollback_310000=discard-flow-ai-generations').
-- Credits already committed are NOT given back by the rollback.
-- Refuses when nothing of 310000 is installed (nothing to roll back).
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $rb$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029310000_FLOW_AI_GENERATIONS';
 v_sig text;
 v_rows boolean;
 v_reserved boolean;
BEGIN
 IF to_regclass('public.flow_ai_generations') IS NULL
    AND to_regprocedure('public.flow_ai_generation_reserve(uuid,uuid,text,integer)') IS NULL
    AND to_regprocedure('public.flow_ai_generation_commit(uuid,uuid,jsonb)') IS NULL
    AND to_regprocedure('public.flow_ai_generation_release(uuid,uuid)') IS NULL THEN
  RAISE EXCEPTION '20261029310000_flow_ai_generations is not installed; nothing to roll back';
 END IF;
 FOREACH v_sig IN ARRAY ARRAY['public.flow_ai_generation_reserve(uuid,uuid,text,integer)',
                              'public.flow_ai_generation_commit(uuid,uuid,jsonb)',
                              'public.flow_ai_generation_release(uuid,uuid)'] LOOP
  IF to_regprocedure(v_sig) IS NOT NULL
     AND obj_description(to_regprocedure(v_sig),'pg_proc') IS DISTINCT FROM v_marker THEN
   RAISE EXCEPTION '% exists without marker %; refusing to drop it', v_sig, v_marker;
  END IF;
 END LOOP;
 IF to_regclass('public.flow_ai_generations') IS NOT NULL THEN
  IF obj_description(to_regclass('public.flow_ai_generations'),'pg_class') IS DISTINCT FROM v_marker THEN
   RAISE EXCEPTION 'public.flow_ai_generations exists without marker %; refusing to drop it', v_marker;
  END IF;
  EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.flow_ai_generations WHERE status = ''reserved'')' INTO v_reserved;
  IF v_reserved THEN
   RAISE EXCEPTION 'public.flow_ai_generations holds reserved credits; release them before rolling back';
  END IF;
  EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.flow_ai_generations)' INTO v_rows;
  IF v_rows AND current_setting('milan.rollback_310000', true) IS DISTINCT FROM 'discard-flow-ai-generations' THEN
   RAISE EXCEPTION 'public.flow_ai_generations holds rows; set milan.rollback_310000=discard-flow-ai-generations to discard them';
  END IF;
 END IF;
END
$rb$;

DROP FUNCTION IF EXISTS public.flow_ai_generation_reserve(uuid,uuid,text,integer);
DROP FUNCTION IF EXISTS public.flow_ai_generation_commit(uuid,uuid,jsonb);
DROP FUNCTION IF EXISTS public.flow_ai_generation_release(uuid,uuid);
DROP TABLE IF EXISTS public.flow_ai_generations;

COMMIT;
