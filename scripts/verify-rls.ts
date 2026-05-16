/**
 * RLS sanity check: confirms tenant tables are unreadable without a valid session.
 *
 * Uses the anon key with no auth context, so auth.uid() is null and the
 * `tenant_isolation` policy (user_id = auth.uid()) should evaluate false for
 * every row. Each tenant-scoped table should return 0 rows.
 *
 * This is a partial verify — confirms RLS is wired and policies block anon
 * reads. A two-user cross-tenant test still requires a second real Supabase
 * user logged in via magic link (manual).
 *
 * Usage: npx tsx --env-file=.env.local scripts/verify-rls.ts
 */

import { createClient } from "@supabase/supabase-js";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!URL || !ANON) { console.error("NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY required"); process.exit(1); }

const TABLES = [
  "mailboxes", "messages", "senders", "scan_runs", "audit_findings",
  "audit_runs", "audit_message_overrides", "proposed_folders",
  "folder_rules", "move_log", "agent_memory",
  "triage_runs", "review_queue",
  "chat_threads", "chat_messages", "tool_calls",
];

async function main() {
  const supabase = createClient(URL!, ANON!);
  let pass = 0;
  let fail = 0;
  for (const t of TABLES) {
    const { data, error } = await supabase.from(t).select("*", { count: "exact" }).limit(1);
    const rows = data?.length ?? 0;
    if (error) {
      console.log(`  ${t.padEnd(28)}  ERROR  ${error.message}`);
      fail++;
    } else if (rows === 0) {
      console.log(`  ${t.padEnd(28)}  PASS   0 rows visible to anon`);
      pass++;
    } else {
      console.log(`  ${t.padEnd(28)}  FAIL   ${rows} rows leaked to anon!`);
      fail++;
    }
  }
  console.log(`\n${pass}/${TABLES.length} tables block anon reads. ${fail} failure(s).`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
