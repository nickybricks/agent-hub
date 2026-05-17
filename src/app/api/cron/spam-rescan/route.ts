import { fanOut } from "@/lib/cron";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return fanOut(req, "mail/spam-rescan");
}
