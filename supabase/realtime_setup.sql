-- ================================================================
-- SUPABASE REALTIME SETUP (Final Version)
-- Enables Realtime subscriptions for Conversations and Messages.
-- Required for: Dashboard.tsx (Instant message delivery & list updates)
-- ================================================================

-- 1. Enable Realtime for 'conversations' table
-- Allows frontend to detect new conversations and updates (last_message_at).
-- Uses DO block to handle "already exists" errors gracefully.
DO $$
BEGIN
  -- Check if table is already in publication to avoid errors
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'conversations'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.conversations;
  END IF;
END $$;

-- 2. Enable Realtime for 'messages' table
-- Allows frontend to receive new messages instantly without polling.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
  END IF;
END $$;

-- ================================================================
-- NOTES:
-- - Idempotent: Safe to run multiple times.
-- - Does not alter RLS policies.
-- - Requires 'supabase_realtime' publication to exist (default in Supabase).
-- ================================================================
