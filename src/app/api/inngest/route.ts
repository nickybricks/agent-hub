import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import {
  mailScan,
  mailTriage,
  mailClassify,
  mailSpamRescan,
} from "@/inngest/functions";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [mailScan, mailTriage, mailClassify, mailSpamRescan],
});
