import { NextResponse } from "next/server";
import { runNewsletterAgent } from "@/agent/run";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (id !== "newsletter-summarizer") {
    return NextResponse.json({ error: "Unknown agent" }, { status: 404 });
  }

  try {
    const run = await runNewsletterAgent();
    return NextResponse.json(run);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
