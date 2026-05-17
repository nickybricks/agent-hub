-- user_settings: non-secret per-user mail config (provider, host, port, user).
-- Vault wrapper RPCs: upsert_vault_secret / get_vault_secret for server-side secret access.
-- Apply in Supabase SQL Editor or: psql $DATABASE_URL -f db/migrations/0004_user_settings.sql

CREATE TABLE IF NOT EXISTS "user_settings" (
  "user_id"    uuid    PRIMARY KEY NOT NULL,
  "provider"   text    NOT NULL DEFAULT 'imap',
  "imap_host"  text,
  "imap_port"  integer,
  "imap_user"  text,
  "created_at" text    NOT NULL,
  "updated_at" text    NOT NULL,
  CONSTRAINT "user_settings_user_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE
);

ALTER TABLE "user_settings" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "user_settings"
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Vault wrapper: upsert (create or update) a named secret.
CREATE OR REPLACE FUNCTION public.upsert_vault_secret(p_name text, p_value text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = vault, public
AS $$
DECLARE
  existing_id uuid;
BEGIN
  SELECT id INTO existing_id FROM vault.secrets WHERE name = p_name;
  IF existing_id IS NOT NULL THEN
    PERFORM vault.update_secret(existing_id, p_value);
  ELSE
    PERFORM vault.create_secret(p_value, p_name);
  END IF;
END;
$$;

-- Vault wrapper: read a named secret, returns NULL if not found.
CREATE OR REPLACE FUNCTION public.get_vault_secret(p_name text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = vault, public
AS $$
DECLARE
  secret_value text;
BEGIN
  SELECT decrypted_secret INTO secret_value
  FROM vault.decrypted_secrets
  WHERE name = p_name;
  RETURN secret_value;
END;
$$;

-- Restrict to service_role only (anon/authenticated users must never call these directly).
REVOKE EXECUTE ON FUNCTION public.upsert_vault_secret(text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_vault_secret(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_vault_secret(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_vault_secret(text) TO service_role;
