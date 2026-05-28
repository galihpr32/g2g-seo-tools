-- ── News & Trends Export config ────────────────────────────────────────────
-- Per-brand Google Sheet target for the news/trends export pipeline. User
-- pastes a Sheets URL on the Settings page, we extract the spreadsheet_id,
-- store it here, and the export endpoint + weekly cron know where to push.
--
-- Why a dedicated table (not env var): G2G and OffGamers may share data
-- with different divisions, so each brand gets its own Sheet. Multi-tenant
-- ready from day one.

CREATE TABLE IF NOT EXISTS public.news_export_config (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  site_slug           text NOT NULL DEFAULT 'g2g',

  /** Full Sheets URL as pasted by the user (preserved for display). */
  spreadsheet_url     text NOT NULL,
  /** Extracted ID — the 44-ish-char token after /d/. The export writer uses this. */
  spreadsheet_id      text NOT NULL,

  /** Last successful export run — surfaced in Settings UI as "Last exported: …". */
  last_exported_at    timestamptz,
  last_run_status     text,
  last_run_summary    text,

  /** Enable/disable the weekly cron push for this brand without deleting config. */
  weekly_cron_enabled boolean NOT NULL DEFAULT true,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, site_slug)
);

CREATE INDEX IF NOT EXISTS news_export_config_owner_site_idx
  ON public.news_export_config (owner_user_id, site_slug);

ALTER TABLE public.news_export_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own news export config"
  ON public.news_export_config FOR ALL
  USING  (auth.uid() = owner_user_id)
  WITH CHECK (auth.uid() = owner_user_id);

COMMENT ON TABLE public.news_export_config IS
  'Per-brand Google Sheets target for news + game-trends export. Sheet is shared with other divisions for hand-off.';
