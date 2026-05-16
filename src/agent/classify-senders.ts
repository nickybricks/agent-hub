import { readFileSync } from "fs";
import { join } from "path";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { traceable } from "langsmith/traceable";
import { z } from "zod";
import { createLLM, LLMConfig } from "./summarize";
import {
  getUnclassifiedSenders as getUnclassifiedSendersSqlite,
  setSenderCategory as setSenderCategorySqlite,
  SENDER_CATEGORIES,
  UnclassifiedSender,
} from "../lib/analyzer-db";
import { getUnclassifiedSendersPg, setSenderCategoryPg } from "../lib/analyzer-db-pg";
import { isMultiTenant } from "../lib/db";
import { withGuardrail, wrapEmail, sanitizeSubject } from "../lib/prompt-safety";

const MT = isMultiTenant();
const USER_ID = MT ? process.env.DEV_USER_ID : null;
if (MT && !USER_ID) {
  console.error("MULTI_TENANT=true requires DEV_USER_ID env var.");
  process.exit(1);
}

async function getUnclassifiedSenders(
  model: string,
  minMessages: number,
  limit?: number,
): Promise<UnclassifiedSender[]> {
  return MT
    ? getUnclassifiedSendersPg(USER_ID!, model, minMessages, limit)
    : getUnclassifiedSendersSqlite(model, minMessages, limit);
}
async function setSenderCategory(email: string, category: string, model: string): Promise<void> {
  if (MT) await setSenderCategoryPg(USER_ID!, email, category, model);
  else setSenderCategorySqlite(email, category, model);
}

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
  return { ...agent.settings.llm, systemPrompt: withGuardrail(SYSTEM_PROMPT) } as LLMConfig;
}

function renderSender(s: UnclassifiedSender): string {
  const cleanSubjects = s.sample_subjects.map(sanitizeSubject).filter(Boolean);
  const subjects = cleanSubjects.length
    ? cleanSubjects.map((x) => `    - "${x}"`).join("\n")
    : "    (no subjects available)";
  const body = `- email: ${s.email}
  domain: ${s.domain}
  name: ${s.display_name ?? "(none)"}
  recent subjects:
${subjects}`;
  return wrapEmail(body);
}

async function _classifyBatch(
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

export const classifyBatch = traceable(_classifyBatch, {
  name: "classify-sender-batch",
  run_type: "chain",
});

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

  const senders = await getUnclassifiedSenders(config.model, minMessages, limit);
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
          await setSenderCategory(s.email, cat, config.model);
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
  const tracedRun = traceable(
    async () => Promise.all(Array.from({ length: concurrency }, worker)),
    {
      name: "classify-senders",
      run_type: "chain",
      metadata: {
        provider: config.provider,
        model: config.model,
        sender_count: senders.length,
        batch_count: batches.length,
        concurrency,
      },
    }
  );
  await tracedRun();

  console.log(`\nDone. Classified ${done} senders (${errors} batch error(s)).`);
}

async function flushLangSmith() {
  try {
    const { RunTree } = await import("langsmith/run_trees");
    const client = RunTree.getSharedClient();
    await client.awaitPendingTraceBatches();
    await new Promise((r) => setTimeout(r, 500));
    await client.awaitPendingTraceBatches();
  } catch {
    // LangSmith not configured — no-op.
  }
}

if (require.main === module) {
  main()
    .then(async () => {
      await flushLangSmith();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(err);
      await flushLangSmith();
      process.exit(1);
    });
}
