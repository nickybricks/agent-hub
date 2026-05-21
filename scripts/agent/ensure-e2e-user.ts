/**
 * Idempotently creates / resets the Playwright e2e user in Supabase Auth.
 *
 * Usage: npx tsx --env-file=.env.local scripts/agent/ensure-e2e-user.ts
 *
 * Reads E2E_USER_EMAIL / E2E_USER_PASSWORD from env. Uses the service role
 * to either create the user (email confirmed) or update its password so the
 * sign-in golden path is deterministic.
 */
import { createClient } from "@supabase/supabase-js";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const email = process.env.E2E_USER_EMAIL;
  const password = process.env.E2E_USER_PASSWORD;

  if (!url || !serviceKey) throw new Error("Missing Supabase env vars.");
  if (!email || !password) throw new Error("Set E2E_USER_EMAIL and E2E_USER_PASSWORD.");

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: list, error: listErr } = await admin.auth.admin.listUsers({ perPage: 200 });
  if (listErr) throw listErr;

  const existing = list.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());

  if (existing) {
    const { error } = await admin.auth.admin.updateUserById(existing.id, {
      password,
      email_confirm: true,
    });
    if (error) throw error;
    console.log(`Updated e2e user ${email} (id=${existing.id}).`);
    return;
  }

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw error;
  console.log(`Created e2e user ${email} (id=${data.user?.id}).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
