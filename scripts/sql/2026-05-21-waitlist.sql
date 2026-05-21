-- Landing page waitlist. Run in Supabase SQL editor (prod).
-- Anonymous users can insert via the public anon role; nobody can read
-- except service-role (server-side admin views).

CREATE TABLE IF NOT EXISTS waitlist (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text UNIQUE NOT NULL,
  referrer    text,
  locale      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE waitlist ENABLE ROW LEVEL SECURITY;

-- The API route writes via service-role (bypasses RLS), so no anon insert
-- policy is required. Service-role bypass means we don't expose the table to
-- the public anon key at all.
