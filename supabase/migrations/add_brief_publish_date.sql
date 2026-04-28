-- Add target_publish_date to seo_content_briefs
-- Used by the Editorial Calendar and Writer Inbox to track planned publish dates.
alter table seo_content_briefs
  add column if not exists target_publish_date date;

-- Index for calendar queries (range scans by month)
create index if not exists seo_content_briefs_publish_date_idx
  on seo_content_briefs (target_publish_date)
  where target_publish_date is not null;
