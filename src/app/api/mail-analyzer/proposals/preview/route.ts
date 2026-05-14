import { NextResponse } from "next/server";
import { getFolderRule, getMessagesMatchingRule } from "@/lib/analyzer-db";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const ruleId = Number(url.searchParams.get("ruleId"));
  if (!ruleId) return NextResponse.json({ error: "ruleId required" }, { status: 400 });
  const rule = getFolderRule(ruleId);
  if (!rule) return NextResponse.json({ error: "rule not found" }, { status: 404 });

  const matches = getMessagesMatchingRule(rule);
  // Group by source mailbox so the user sees what's actually moving.
  const byMailbox = new Map<string, typeof matches>();
  for (const m of matches) {
    const arr = byMailbox.get(m.mailbox_name) ?? [];
    arr.push(m);
    byMailbox.set(m.mailbox_name, arr);
  }
  const groups = [...byMailbox.entries()].map(([mailbox, msgs]) => ({
    from_mailbox: mailbox,
    count: msgs.length,
    samples: msgs.slice(0, 5).map((m) => ({
      id: m.id,
      subject: m.subject,
      sender_email: m.sender_email,
      date_received: m.date_received,
    })),
  }));

  return NextResponse.json({
    rule,
    total: matches.length,
    groups,
  });
}
