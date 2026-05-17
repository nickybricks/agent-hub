import { NextResponse } from "next/server";
import { inngest } from "@/inngest/client";
import { listActiveUserIds } from "@/lib/active-users";

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. */
export function authorizeCron(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

/** Fan out one Inngest event per active user. */
export async function fanOut(req: Request, event: string) {
  if (!authorizeCron(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const userIds = await listActiveUserIds();
  if (userIds.length > 0) {
    await inngest.send(
      userIds.map((userId) => ({ name: event, data: { userId } })),
    );
  }
  return NextResponse.json({ ok: true, event, dispatched: userIds.length });
}
