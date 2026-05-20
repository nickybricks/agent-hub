import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { traceable } from "langsmith/traceable";
import { z } from "zod";
import { createLLM, LLMConfig } from "./summarize";
import { SENDER_CATEGORIES, type UnclassifiedSender } from "../lib/analyzer-db";
import { getUnclassifiedSendersPg, setSenderCategoryPg } from "../lib/analyzer-db-pg";
import { withGuardrail, wrapEmail, sanitizeSubject } from "../lib/prompt-safety";

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

// Classification is a cheap structured task — derive a sensible model from
// whichever API key is set.
function envLLMConfig(): LLMConfig {
  const provider = process.env.OPENAI_API_KEY ? "openai" : "anthropic";
  const model = provider === "openai" ? "gpt-4o-mini" : "claude-haiku-4-5-20251001";
  return { provider, model, systemPrompt: withGuardrail(SYSTEM_PROMPT) };
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

export interface ClassifyOptions {
  limit?: number;
  minMessages?: number;
  provider?: string;
  model?: string;
  concurrency?: number;
}

export interface ClassifyResult {
  classified: number;
  batchErrors: number;
}

/** Classify unclassified senders for a tenant. */
export async function runClassify(
  userId: string,
  opts: ClassifyOptions = {},
): Promise<ClassifyResult> {
  const limit = opts.limit;
  const minMessages = opts.minMessages ?? 1;

  const config = envLLMConfig();
  if (opts.provider) config.provider = opts.provider as LLMConfig["provider"];
  if (opts.model) config.model = opts.model;
  console.log(`Classifying senders with ${config.provider}/${config.model}...`);

  const senders = await getUnclassifiedSendersPg(userId, config.model, minMessages, limit);
  if (senders.length === 0) {
    console.log("No unclassified senders. Nothing to do.");
    return { classified: 0, batchErrors: 0 };
  }
  console.log(`${senders.length} senders to classify in batches of ${BATCH_SIZE}.`);

  const concurrency = opts.concurrency ? Math.max(1, opts.concurrency) : 6;

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
          await setSenderCategoryPg(userId, s.email, cat, config.model);
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
  return { classified: done, batchErrors: errors };
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
  const args = process.argv.slice(2);
  const argVal = (p: string) => args.find((a) => a.startsWith(p))?.split("=")[1];
  const limitArg = argVal("--limit=");
  const minArg = argVal("--min-messages=");
  const concArg = argVal("--concurrency=");
  const userId = process.env.DEV_USER_ID;
  if (!userId) {
    console.error("DEV_USER_ID env var required.");
    process.exit(1);
  }
  runClassify(userId, {
    limit: limitArg ? Number(limitArg) : undefined,
    minMessages: minArg ? Number(minArg) : undefined,
    provider: argVal("--provider="),
    model: argVal("--model="),
    concurrency: concArg ? Number(concArg) : undefined,
  })
    .then(async () => {
      await flushLangSmith();
      process.exit(0);
    })
    .catch(async (err: unknown) => {
      console.error(err);
      await flushLangSmith();
      process.exit(1);
    });
}
