import { NextResponse } from "next/server";
import { getSummaries } from "@/lib/data";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get("limit") || "30");
  const summaries = getSummaries(limit);
  return NextResponse.json(summaries);
}
