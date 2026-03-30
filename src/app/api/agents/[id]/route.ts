import { NextResponse } from "next/server";
import { getAgent, updateAgent } from "@/lib/data";
import { syncScheduleToLaunchAgent } from "@/lib/schedule-sync";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const agent = getAgent(id);
  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }
  return NextResponse.json(agent);
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();
  updateAgent(id, body);

  // Sync schedule to macOS LaunchAgent when saving agent settings
  if (body.schedule) {
    const scheduleResult = syncScheduleToLaunchAgent({
      enabled: body.enabled !== false && body.schedule.enabled !== false,
      time: body.schedule.time,
      days: body.schedule.days,
    });
    return NextResponse.json({
      success: true,
      schedule: scheduleResult,
    });
  }

  return NextResponse.json({ success: true });
}
