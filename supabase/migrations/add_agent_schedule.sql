-- Add schedule_next_run_at column to agents table
-- This lets the scheduler efficiently query "which agents are due right now"
alter table agents
  add column if not exists schedule_next_run_at timestamptz;

-- Index for fast scheduler queries: find all agents due to run
create index if not exists idx_agents_schedule_next_run
  on agents(schedule_next_run_at)
  where schedule_next_run_at is not null;
