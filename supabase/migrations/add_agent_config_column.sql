-- Add config column to agents table for per-agent settings
alter table agents add column if not exists config jsonb default '{}';
