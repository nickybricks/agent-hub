import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { mailScanRun, mailMoveApply } from "@/inngest/functions";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [mailScanRun, mailMoveApply],
});
