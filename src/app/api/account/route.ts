import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth";
import { getDrizzleDb } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";
import { getServiceClient } from "@/lib/supabase/service";
import { describeError } from "@/lib/errcause";

export const dynamic = "force-dynamic";

// Every user-scoped table. Deleting these + the Supabase auth user is a
// permanent, irreversible account wipe.
const TENANT_TABLES = [
  "messages",
  "senders",
  "mailboxes",
  "scan_runs",
  "audit_findings",
  "audit_runs",
  "audit_message_overrides",
  "proposed_folders",
  "folder_rules",
  "move_log",
  "triage_runs",
  "review_queue",
  "agent_memory",
  "chat_messages",
  "tool_calls",
  "chat_threads",
  "user_settings",
];

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ email: user.email });
}

export async function POST(req: Request) {
  let action: unknown;
  try {
    action = (await req.json())?.action;
  } catch {
    action = undefined;
  }
  if (action !== "signout") {
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }
  const supabase = await createClient();
  await supabase.auth.signOut();
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const db = getDrizzleDb();
    for (const t of TENANT_TABLES) {
      await db.execute(
        sql`DELETE FROM ${sql.identifier(t)} WHERE user_id = ${user.userId}`,
      );
    }
    const { error } = await getServiceClient().auth.admin.deleteUser(user.userId);
    if (error) {
      return NextResponse.json(
        { error: `Data deleted, but removing the login failed: ${error.message}` },
        { status: 500 },
      );
    }
    const supabase = await createClient();
    await supabase.auth.signOut();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: describeError(e) }, { status: 500 });
  }
}
