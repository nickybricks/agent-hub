import { NextResponse } from "next/server";
import { getRuns } from "@/lib/data";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get("agentId") || undefined;
  const limit = parseInt(searchParams.get("limit") || "20");
  const runs = getRuns(agentId, limit);
  return NextResponse.json(runs);
}
