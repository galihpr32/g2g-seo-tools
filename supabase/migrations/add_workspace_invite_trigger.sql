-- ── Workspace invite auto-link trigger ────────────────────────────────────────
-- When an invited user completes signup via Supabase magic link, this trigger
-- automatically links their auth.users.id to the workspace_members row that was
-- created for their email address.

create or replace function public.link_workspace_member_on_signup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.workspace_members
  set
    member_user_id = new.id,
    status         = 'active'
  where member_email  = lower(new.email)
    and member_user_id is null
    and status in ('pending');
  return new;
end;
$$;

-- Drop existing trigger if any, then recreate
drop trigger if exists on_auth_user_created_link_workspace on auth.users;

create trigger on_auth_user_created_link_workspace
  after insert on auth.users
  for each row
  execute procedure public.link_workspace_member_on_signup();
