import { NextResponse } from "next/server";
import { isMultiTenant } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";
import { createMailProvider } from "@/lib/mail-provider";
import {
  getDb,
  getMovesByBatch,
  markMovesUndone,
  updateMessageMailbox,
  writeMemory,
  type MoveLogEntry,
} from "@/lib/analyzer-db";
import {
  getMailboxIdByNamePg,
  getMoveByIdPg,
  getMovesByBatchPg,
  markMovesUndonePg,
  updateMessageMailboxPg,
  writeMemoryPg,
  type MoveLogRow,
} from "@/lib/analyzer-db-pg";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface UndoBody {
  batch_id?: string;
  move_id?: number;
}

type Move = MoveLogEntry | MoveLogRow;

function mailboxIdSqlite(name: string, account: string): number | null {
  const row = getDb().prepare(`SELECT id FROM mailboxes WHERE name = ? AND account = ? LIMIT 1`).get(name, account) as { id: number } | undefined;
  return row?.id ?? null;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as UndoBody;
  if (!body.batch_id && !body.move_id) {
    return NextResponse.json({ error: "batch_id or move_id required" }, { status: 400 });
  }

  // Resolve tenant.
  let userId: string | null = null;
  if (isMultiTenant()) {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    userId = user.id;
  }

  // Load the moves to undo.
  let moves: Move[];
  if (userId) {
    if (body.batch_id) {
      moves = await getMovesByBatchPg(userId, body.batch_id);
    } else {
      const m = await getMoveByIdPg(userId, body.move_id!);
      moves = m ? [m] : [];
    }
  } else {
    if (body.batch_id) {
      moves = getMovesByBatch(body.batch_id);
    } else {
      const m = getDb().prepare(`SELECT * FROM move_log WHERE id = ?`).get(body.move_id!) as MoveLogEntry | undefined;
      moves = m ? [m] : [];
    }
  }

  const applied = moves.filter((m) => m.status === "applied");
  if (applied.length === 0) return NextResponse.json({ ok: true, undone: 0, failed: 0, note: "nothing to undo" });

  const provider = await createMailProvider(userId ?? undefined);
  await provider.open();
  const undoneIds: number[] = [];
  let undone = 0;
  let failed = 0;
  try {
    // Group by (from, to) — undo means moving to_mailbox → from_mailbox.
    const byPair = new Map<string, Move[]>();
    for (const m of applied) {
      const key = `${m.to_mailbox}→${m.from_mailbox}`;
      const arr = byPair.get(key) ?? [];
      arr.push(m);
      byPair.set(key, arr);
    }

    for (const [, group] of byPair) {
      const src = group[0].to_mailbox;
      const dst = group[0].from_mailbox;
      const account = group[0].account;
      const ids = group.map((g) => g.message_id);
      const results = await provider.moveMessages(ids, src, dst);
      const okIds = new Set(results.filter((r) => r.ok).map((r) => r.messageId));

      // Resolve destination mailbox_id once (after the move it lives in dst).
      const dstMailboxId = userId
        ? await getMailboxIdByNamePg(userId, dst, account)
        : mailboxIdSqlite(dst, account);

      for (const m of group) {
        if (okIds.has(m.message_id)) {
          undoneIds.push(m.id);
          if (dstMailboxId !== null) {
            if (userId) await updateMessageMailboxPg(userId, m.message_id, dstMailboxId);
            else updateMessageMailbox(m.message_id, dstMailboxId);
          }
          undone++;
        } else {
          failed++;
        }
      }
    }
  } finally {
    await provider.close();
  }

  if (undoneIds.length > 0) {
    if (userId) await markMovesUndonePg(userId, undoneIds);
    else markMovesUndone(undoneIds);

    const memoInput = {
      kind: "apply_action" as const,
      key: body.batch_id ?? `move:${body.move_id}`,
      source: "user_decision" as const,
      content: `Undo ${body.batch_id ? `batch ${body.batch_id}` : `move ${body.move_id}`}: reverted ${undone}/${applied.length} move(s).`,
    };
    if (userId) await writeMemoryPg(userId, memoInput);
    else writeMemory(memoInput);
  }

  return NextResponse.json({ ok: true, undone, failed });
}
