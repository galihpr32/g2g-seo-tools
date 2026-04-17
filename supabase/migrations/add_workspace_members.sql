-- ============================================================
-- Workspace / Team Model
-- Manager pre-registers member emails → members sign up →
-- manager approves → members see manager's data
-- ============================================================

CREATE TABLE IF NOT EXISTS workspace_members (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  member_email     text NOT NULL,
  member_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  role             text NOT NULL DEFAULT 'member'
                     CHECK (role IN ('member', 'manager')),
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'active', 'rejected')),
  created_at       timestamptz DEFAULT now() NOT NULL,
  approved_at      timestamptz,
  -- One entry per email per workspace
  UNIQUE (owner_user_id, member_email)
);

-- Index: find which workspace a member_user_id belongs to (used on every login)
CREATE INDEX IF NOT EXISTS idx_workspace_members_member_user_id
  ON workspace_members (member_user_id, status);

-- Index: owner looking up their own members
CREATE INDEX IF NOT EXISTS idx_workspace_members_owner
  ON workspace_members (owner_user_id, status);

-- Index: auto-link on signup (match by email)
CREATE INDEX IF NOT EXISTS idx_workspace_members_member_email
  ON workspace_members (member_email);

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;

-- Owner: full control over their workspace
CREATE POLICY "workspace_members: owner full access"
  ON workspace_members
  FOR ALL
  USING  (owner_user_id = auth.uid())
  WITH CHECK (owner_user_id = auth.uid());

-- Member: can see their own membership row (to know their status)
CREATE POLICY "workspace_members: member can see own row"
  ON workspace_members
  FOR SELECT
  USING (member_user_id = auth.uid());

-- ── Auto-link trigger ─────────────────────────────────────────────────────────
-- When a new user signs up, if their email is already pre-registered in
-- workspace_members (status = pending, member_user_id = null), fill in their user id.

CREATE OR REPLACE FUNCTION link_workspace_member_on_signup()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE workspace_members
  SET    member_user_id = NEW.id
  WHERE  member_email   = NEW.email
    AND  member_user_id IS NULL
    AND  status         = 'pending';
  RETURN NEW;
END;
$$;

-- Attach to auth.users (fires after INSERT on new signup)
DROP TRIGGER IF EXISTS on_auth_user_created_link_workspace ON auth.users;
CREATE TRIGGER on_auth_user_created_link_workspace
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION link_workspace_member_on_signup();
