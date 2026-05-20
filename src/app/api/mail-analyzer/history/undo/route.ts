import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { createMailProvider } from "@/lib/mail-provider";
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

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as UndoBody;
  if (!body.batch_id && !body.move_id) {
    return NextResponse.json({ error: "batch_id or move_id required" }, { status: 400 });
  }

  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const userId = auth.userId;

  // Load the moves to undo.
  let moves: MoveLogRow[];
  if (body.batch_id) {
    moves = await getMovesByBatchPg(userId, body.batch_id);
  } else {
    const m = await getMoveByIdPg(userId, body.move_id!);
    moves = m ? [m] : [];
  }

  const applied = moves.filter((m) => m.status === "applied");
  if (applied.length === 0)
    return NextResponse.json({ ok: true, undone: 0, failed: 0, note: "nothing to undo" });

  const provider = await createMailProvider(userId);
  await provider.open();
  const undoneIds: number[] = [];
  let undone = 0;
  let failed = 0;
  try {
    // Group by (from, to) — undo means moving to_mailbox → from_mailbox.
    const byPair = new Map<string, MoveLogRow[]>();
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

      const dstMailboxId = await getMailboxIdByNamePg(userId, dst, account);

      for (const m of group) {
        if (okIds.has(m.message_id)) {
          undoneIds.push(m.id);
          if (dstMailboxId !== null) {
            await updateMessageMailboxPg(userId, m.message_id, dstMailboxId);
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
    await markMovesUndonePg(userId, undoneIds);
    await writeMemoryPg(userId, {
      kind: "apply_action",
      key: body.batch_id ?? `move:${body.move_id}`,
      source: "user_decision",
      content: `Undo ${body.batch_id ? `batch ${body.batch_id}` : `move ${body.move_id}`}: reverted ${undone}/${applied.length} move(s).`,
    });
  }

  return NextResponse.json({ ok: true, undone, failed });
}
