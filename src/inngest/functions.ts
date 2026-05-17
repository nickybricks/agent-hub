import { inngest } from "./client";

export const mailScan = inngest.createFunction(
  { id: "mail-scan", retries: 2, triggers: [{ event: "mail/scan" }] },
  async ({ event, step }) => {
    const userId = event.data.userId as string | undefined;
    const { runScan } = await import("../agent/analyze-mailbox");
    const result = await step.run("scan", () => runScan(userId));
    // Onboarding pipeline: scan → classify automatically (durable, not bound to
    // any HTTP request). `chain: true` marks the follow-on so classify can chain
    // onward to propose.
    if (event.data.chain) {
      await step.sendEvent("chain-classify", {
        name: "mail/classify",
        data: { userId, chain: true },
      });
    }
    return result;
  },
);

export const mailTriage = inngest.createFunction(
  { id: "mail-triage", retries: 2, triggers: [{ event: "mail/triage" }] },
  async ({ event, step }) => {
    const userId = event.data.userId as string | undefined;
    const { runTriage } = await import("../agent/triage");
    return step.run("triage", () => runTriage(userId));
  },
);

export const mailClassify = inngest.createFunction(
  { id: "mail-classify", retries: 2, triggers: [{ event: "mail/classify" }] },
  async ({ event, step }) => {
    const userId = event.data.userId as string | undefined;
    const { runClassify } = await import("../agent/classify-senders");
    return step.run("classify", () => runClassify(userId));
  },
);

export const mailPropose = inngest.createFunction(
  { id: "mail-propose", retries: 2, triggers: [{ event: "mail/propose" }] },
  async ({ event, step }) => {
    const userId = event.data.userId as string | undefined;
    const { runProposeStructure } = await import("../agent/propose-structure");
    return step.run("propose", () => runProposeStructure(userId ?? null));
  },
);

export const mailSpamRescan = inngest.createFunction(
  { id: "mail-spam-rescan", retries: 2, triggers: [{ event: "mail/spam-rescan" }] },
  async ({ event, step }) => {
    const userId = event.data.userId as string | undefined;
    const { runSpamRescan } = await import("../agent/spam-rescan");
    return step.run("spam-rescan", () => runSpamRescan(userId));
  },
);
