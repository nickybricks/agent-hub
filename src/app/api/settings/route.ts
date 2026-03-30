import { NextResponse } from "next/server";
import { getConfig, saveConfig } from "@/lib/data";

export async function GET() {
  const config = getConfig();
  return NextResponse.json(config);
}

export async function PUT(request: Request) {
  const body = await request.json();
  saveConfig(body);
  return NextResponse.json({ success: true });
}
