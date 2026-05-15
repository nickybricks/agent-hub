import { inngest } from "./client";

export const mailScanRun = inngest.createFunction(
  { id: "mail-scan-run", triggers: [{ event: "mail/scan.run" }] },
  async ({ event }) => {
    // TODO: replace analyze-mailbox.ts scan on the multi-tenant path
    return { status: "stub", eventId: event.id };
  },
);

export const mailMoveApply = inngest.createFunction(
  { id: "mail-move-apply", triggers: [{ event: "mail/move.apply" }] },
  async ({ event }) => {
    // TODO: replace in-process apply flow on the multi-tenant path
    return { status: "stub", eventId: event.id };
  },
);
