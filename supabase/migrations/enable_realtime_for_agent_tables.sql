-- Enable Supabase Realtime publication on tables consumed by the FE.
-- ApprovalQueueWidget subscribes to agent_actions; BriefViewer subscribes to
-- seo_content_briefs. Without this publication, the FE silently falls back
-- to its built-in polling intervals (still works, just slower UX).

-- Idempotent: ALTER PUBLICATION ADD TABLE errors if already added, so we
-- check first via a DO block.

DO $$
BEGIN
  -- agent_actions
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'agent_actions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_actions;
  END IF;

  -- seo_content_briefs
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'seo_content_briefs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.seo_content_briefs;
  END IF;

  -- agent_runs (for live "Needs Attention" + Activity Log refresh)
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'agent_runs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_runs;
  END IF;
END $$;
