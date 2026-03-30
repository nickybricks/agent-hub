import { NextResponse } from "next/server";
import { getSummary } from "@/lib/data";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const summary = getSummary(id);
  if (!summary) {
    return NextResponse.json({ error: "Summary not found" }, { status: 404 });
  }
  return NextResponse.json(summary);
}
