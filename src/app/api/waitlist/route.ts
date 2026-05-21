import { NextResponse } from "next/server";
import { z } from "zod";
import { getServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

const schema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  // Honeypot — bots fill it in, humans don't.
  company: z.string().max(0).optional(),
  referrer: z.string().max(2048).optional(),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid" }, { status: 400 });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, reason: "invalid" }, { status: 400 });
  }
  if (parsed.data.company) {
    // Honeypot triggered. Pretend success so the bot moves on.
    return NextResponse.json({ ok: true });
  }

  const { email, referrer } = parsed.data;

  const client = getServiceClient() as unknown as {
    from: (t: string) => {
      insert: (
        row: Record<string, unknown>,
      ) => Promise<{ error: { code?: string; message: string } | null }>;
    };
  };
  const { error } = await client
    .from("waitlist")
    .insert({ email, referrer: referrer ?? null, locale: "en" });

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ ok: false, reason: "duplicate" }, { status: 409 });
    }
    return NextResponse.json({ ok: false, reason: "server" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
