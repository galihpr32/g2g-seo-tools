-- Add assigned_to column to seo_action_items
-- Run this in Supabase SQL Editor

ALTER TABLE seo_action_items
  ADD COLUMN IF NOT EXISTS assigned_to text;

-- Optional: index for filtering by assignee
CREATE INDEX IF NOT EXISTS idx_seo_action_items_assigned_to
  ON seo_action_items (assigned_to);
