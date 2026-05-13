import { readFileSync } from "fs";
import { join } from "path";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { createLLM, LLMConfig } from "./summarize";
import {
  getUnclassifiedSenders,
  setSenderCategory,
  SENDER_CATEGORIES,
  UnclassifiedSender,
} from "../lib/analyzer-db";

const BATCH_SIZE = 20;

const ResultSchema = z.object({
  results: z.array(
    z.object({
      email: z.string(),
      category: z.enum(SENDER_CATEGORIES),
    })
  ),
});

const SYSTEM_PROMPT = `You classify email senders into one of these categories:
- newsletter: editorial digests, blog updates, content subscriptions
- transactional: receipts, order confirmations, password resets, account notifications tied to an action the user took
- personal: real humans writing to the user
- promotional: marketing, deals, sales, advertising
- notification: automated alerts from services (GitHub, monitoring, calendar reminders) that aren't transactional
- social: social networks, dating apps, community platforms
- work: colleagues, work tools, internal company mail
- other: anything that doesn't clearly fit

Return exactly one category per sender. Use the domain, display name, and recent subject lines as evidence.`;

function loadLLMConfig(): LLMConfig {
  const cfg = JSON.parse(readFileSync(join(process.cwd(), "data", "config.json"), "utf-8"));
  const agent = cfg.agents.find((a: { id: string }) => a.id === "newsletter-summarizer");
  if (!agent?.settings?.llm) throw new Error("No LLM config found in data/config.json");
  return { ...agent.settings.llm, systemPrompt: SYSTEM_PROMPT } as LLMConfig;
}

function renderSender(s: UnclassifiedSender): string {
  const subjects = s.sample_subjects.length
    ? s.sample_subjects.map((x) => `    - "${x}"`).join("\n")
    : "    (no subjects available)";
  return `- email: ${s.email}
  domain: ${s.domain}
  name: ${s.display_name ?? "(none)"}
  recent subjects:
${subjects}`;
}

async function classifyBatch(
  llm: ReturnType<typeof createLLM>,
  systemPrompt: string,
  batch: UnclassifiedSender[],
): Promise<Map<string, string>> {
  const userMessage = `Classify each of the following ${batch.length} senders. Respond with one result per sender, using the exact email value provided.\n\n${batch.map(renderSender).join("\n\n")}`;
  const structured = llm.withStructuredOutput(ResultSchema, { name: "sender_categories" });
  const out = await structured.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(userMessage),
  ]);
  const map = new Map<string, string>();
  for (const r of out.results) map.set(r.email.toLowerCase(), r.category);
  return map;
}

async function main() {
  const args = process.argv.slice(2);
  const limitArg = args.find((a) => a.startsWith("--limit="));
  const minArg = args.find((a) => a.startsWith("--min-messages="));
  const providerArg = args.find((a) => a.startsWith("--provider="));
  const modelArg = args.find((a) => a.startsWith("--model="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : undefined;
  const minMessages = minArg ? Number(minArg.split("=")[1]) : 1;

  const config = loadLLMConfig();
  if (providerArg) config.provider = providerArg.split("=")[1] as LLMConfig["provider"];
  if (modelArg) config.model = modelArg.split("=")[1];
  console.log(`Classifying senders with ${config.provider}/${config.model}...`);

  const senders = getUnclassifiedSenders(config.model, minMessages, limit);
  if (senders.length === 0) {
    console.log("No unclassified senders. Nothing to do.");
    return;
  }
  console.log(`${senders.length} senders to classify in batches of ${BATCH_SIZE}.`);

  const concArg = args.find((a) => a.startsWith("--concurrency="));
  const concurrency = concArg ? Math.max(1, Number(concArg.split("=")[1])) : 6;

  const llm = createLLM(config);
  let done = 0;
  let errors = 0;

  const batches: UnclassifiedSender[][] = [];
  for (let i = 0; i < senders.length; i += BATCH_SIZE) {
    batches.push(senders.slice(i, i + BATCH_SIZE));
  }

  let nextBatch = 0;
  async function worker() {
    while (true) {
      const idx = nextBatch++;
      if (idx >= batches.length) return;
      const batch = batches[idx];
      try {
        const results = await classifyBatch(llm, config.systemPrompt, batch);
        for (const s of batch) {
          const cat = results.get(s.email) ?? "other";
          setSenderCategory(s.email, cat, config.model);
          done++;
        }
        console.log(`  batch ${idx + 1}/${batches.length} (${done} senders done)`);
      } catch (err) {
        errors++;
        console.error(`  Batch ${idx + 1} failed:`, err instanceof Error ? err.message : err);
      }
    }
  }

  console.log(`Running ${concurrency} concurrent workers over ${batches.length} batches.`);
  await Promise.all(Array.from({ length: concurrency }, worker));

  console.log(`\nDone. Classified ${done} senders (${errors} batch error(s)).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
