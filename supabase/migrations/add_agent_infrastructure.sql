-- Agent definitions (one row per agent type per owner)
create table if not exists agents (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  agent_key text not null, -- 'pak-rt', 'mas-gacor', 'intel-bakso', 'anak-intern', 'kang-cilok'
  is_active boolean default true,
  last_run_at timestamptz,
  last_run_status text, -- 'success', 'error', 'running'
  last_run_summary text,
  created_at timestamptz default now(),
  unique(owner_user_id, agent_key)
);

-- Agent run logs
create table if not exists agent_runs (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  agent_key text not null,
  site_slug text default 'g2g',
  status text default 'running', -- 'running', 'success', 'error'
  summary text,
  findings_count int default 0,
  actions_queued int default 0,
  error_message text,
  started_at timestamptz default now(),
  finished_at timestamptz
);

-- Pending approval actions from agents
create table if not exists agent_actions (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  agent_key text not null,
  run_id uuid references agent_runs(id) on delete cascade,
  site_slug text default 'g2g',
  action_type text not null, -- 'create_brief', 'add_action_item', 'flag_competitor_move', 'suggest_trend_brief'
  title text not null,
  description text,
  priority text default 'medium', -- 'high', 'medium', 'low'
  data jsonb not null default '{}',
  status text default 'pending', -- 'pending', 'approved', 'rejected', 'executed'
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  executed_at timestamptz,
  created_at timestamptz default now()
);

-- Indexes
create index if not exists agent_runs_owner_key on agent_runs(owner_user_id, agent_key);
create index if not exists agent_actions_owner_status on agent_actions(owner_user_id, status);
create index if not exists agent_actions_owner_agent on agent_actions(owner_user_id, agent_key);
