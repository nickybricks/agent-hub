-- FK references to auth.users and RLS policies.
-- Apply AFTER drizzle-kit migrations (0000_*.sql) with:
--   psql $DATABASE_URL -f db/migrations/0001_rls_policies.sql
-- or paste into Supabase SQL Editor.

-- Foreign keys to auth.users
DO $$
DECLARE
  tables TEXT[] := ARRAY[
    'mailboxes','messages','senders','scan_runs','audit_findings',
    'audit_runs','audit_message_overrides','proposed_folders',
    'folder_rules','move_log','agent_memory'
  ];
  t TEXT;
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I_user_id_fk
       FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE',
      t, t
    );
  END LOOP;
END $$;

-- RLS: enable + tenant isolation policy for every table
DO $$
DECLARE
  tables TEXT[] := ARRAY[
    'mailboxes','messages','senders','scan_runs','audit_findings',
    'audit_runs','audit_message_overrides','proposed_folders',
    'folder_rules','move_log','agent_memory'
  ];
  t TEXT;
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
       FOR ALL
       USING (user_id = auth.uid())
       WITH CHECK (user_id = auth.uid())',
      t
    );
  END LOOP;
END $$;

-- service_role bypass: Postgres grants already give service_role full access,
-- and service_role bypasses RLS by default in Supabase. No extra policy needed.
