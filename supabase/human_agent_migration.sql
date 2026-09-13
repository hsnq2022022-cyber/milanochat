-- ================================================================
-- HUMAN AGENT MIGRATION (Final Version)
-- Compatible with: Dashboard.tsx, server/src/rag/reply.ts, server/src/routes/dashboard.ts
-- ================================================================
-- Purpose:
-- 1. Add 'human_agent_expires_at' column to track Human Agent session expiry.
-- 2. Add index for performance on expiration checks.
-- 3. Create trigger to update 'last_human_message_at' on manual reply.
-- 4. Clean up expired sessions (sets transferred=false).
-- ================================================================

-- 1. Add Column: human_agent_expires_at
-- Used by Backend (reply.ts) to check if AI should be paused.
-- Used by Frontend (Dashboard.tsx) for the countdown timer.
ALTER TABLE public.conversations 
ADD COLUMN IF NOT EXISTS human_agent_expires_at TIMESTAMPTZ;

-- 2. Add Index: For efficient querying of active human agent sessions
-- Helps backend quickly identify conversations where AI is paused.
CREATE INDEX IF NOT EXISTS idx_conversations_human_agent_expires 
ON public.conversations (human_agent_expires_at) 
WHERE human_agent_expires_at IS NOT NULL;

-- 3. Function: Update last_human_message_at
-- Triggered on INSERT into messages.
-- Matches logic: direction='outbound', is_auto=false, kind='answer'.
CREATE OR REPLACE FUNCTION public.handle_new_human_message()
RETURNS TRIGGER AS $$
BEGIN
  -- Check if the new message is a manual human reply
  IF NEW.direction = 'outbound' AND NEW.is_auto IS FALSE AND NEW.kind = 'answer' THEN
    UPDATE public.conversations
    SET last_human_message_at = NEW.created_at
    WHERE id = NEW.conversation_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. Trigger: Update last_human_message_at
-- Drop existing first to allow re-running migration safely.
DROP TRIGGER IF EXISTS trigger_update_last_human_message ON public.messages;

CREATE TRIGGER trigger_update_last_human_message
AFTER INSERT ON public.messages
FOR EACH ROW
EXECUTE FUNCTION public.handle_new_human_message();

-- 5. Cleanup: Expire stuck sessions
-- Sets transferred=false for any session where time has passed.
-- Ensures no conversation is stuck in "Human Agent" mode forever.
UPDATE public.conversations
SET transferred = FALSE,
    human_agent_expires_at = NULL
WHERE human_agent_expires_at IS NOT NULL 
  AND human_agent_expires_at < NOW();

-- ================================================================
-- NOTES:
-- - Does NOT create 'human_agent_enabled' (logic relies on expires_at).
-- - Does NOT create 'human_agent_until' (name mismatch with code).
-- - Backend is responsible for setting expires_at = NOW() + 15 mins.
-- - Backend is responsible for checking expires_at > NOW() before AI reply.
-- ================================================================
