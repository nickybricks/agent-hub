import { inngest } from "./client";

function requireUserId(event: { data: { userId?: unknown } }): string {
  const u = event.data.userId;
  if (typeof u !== "string" || !u) throw new Error("event.data.userId is required");
  return u;
}

export const mailScan = inngest.createFunction(
  { id: "mail-scan", retries: 2, triggers: [{ event: "mail/scan" }] },
  async ({ event, step }) => {
    const userId = requireUserId(event);
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
    const userId = requireUserId(event);
    const { runTriage } = await import("../agent/triage");
    return step.run("triage", () => runTriage(userId));
  },
);

export const mailClassify = inngest.createFunction(
  { id: "mail-classify", retries: 2, triggers: [{ event: "mail/classify" }] },
  async ({ event, step }) => {
    const userId = requireUserId(event);
    const { runClassify } = await import("../agent/classify-senders");
    return step.run("classify", () => runClassify(userId));
  },
);

export const mailPropose = inngest.createFunction(
  { id: "mail-propose", retries: 2, triggers: [{ event: "mail/propose" }] },
  async ({ event, step }) => {
    const userId = requireUserId(event);
    const { runProposeStructure } = await import("../agent/propose-structure");
    return step.run("propose", () => runProposeStructure(userId));
  },
);

export const mailSpamRescan = inngest.createFunction(
  { id: "mail-spam-rescan", retries: 2, triggers: [{ event: "mail/spam-rescan" }] },
  async ({ event, step }) => {
    const userId = requireUserId(event);
    const { runSpamRescan } = await import("../agent/spam-rescan");
    return step.run("spam-rescan", () => runSpamRescan(userId));
  },
);
