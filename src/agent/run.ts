import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { traceable } from "langsmith/traceable";
import { fetchNewsletterEmails } from "./fetch-emails";
import { summarizeNewsletters } from "./summarize";
import { sendDigestEmail } from "./send-digest";
import { NewsletterAgent, Summary, AgentRun } from "../lib/types";
import { randomUUID } from "crypto";

const DATA_DIR = join(process.cwd(), "data");
const SUMMARIES_DIR = join(DATA_DIR, "summaries");
const DEBUG_DIR = join(DATA_DIR, "debug");
const RUNS_FILE = join(DATA_DIR, "runs.json");
const CONFIG_FILE = join(DATA_DIR, "config.json");

function ensureDirs() {
  if (!existsSync(SUMMARIES_DIR)) mkdirSync(SUMMARIES_DIR, { recursive: true });
  if (!existsSync(DEBUG_DIR)) mkdirSync(DEBUG_DIR, { recursive: true });
}

function loadConfig(): NewsletterAgent {
  const config = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  return config.agents.find(
    (a: NewsletterAgent) => a.id === "newsletter-summarizer"
  );
}

function loadRuns(): AgentRun[] {
  if (!existsSync(RUNS_FILE)) return [];
  return JSON.parse(readFileSync(RUNS_FILE, "utf-8"));
}

function saveRun(run: AgentRun) {
  const runs = loadRuns();
  const idx = runs.findIndex((r) => r.id === run.id);
  if (idx >= 0) {
    runs[idx] = run;
  } else {
    runs.unshift(run);
  }
  // Keep only last 50 runs
  writeFileSync(RUNS_FILE, JSON.stringify(runs.slice(0, 50), null, 2));
}

function saveSummary(summary: Summary) {
  const filePath = join(SUMMARIES_DIR, `${summary.date}.json`);

  let summaries: Summary[] = [];
  if (existsSync(filePath)) {
    summaries = JSON.parse(readFileSync(filePath, "utf-8"));
  }
  summaries.unshift(summary);
  writeFileSync(filePath, JSON.stringify(summaries, null, 2));
}

export async function runNewsletterAgent(): Promise<AgentRun> {
  ensureDirs();

  const config = loadConfig();

  // Respect the enabled flag — skip if agent is disabled
  if (!config.enabled) {
    console.log("⏸️  Agent is disabled in settings. Skipping run.");
    return {
      id: randomUUID(),
      agentId: "newsletter-summarizer",
      status: "completed" as const,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
  }

  const run: AgentRun = {
    id: randomUUID(),
    agentId: "newsletter-summarizer",
    status: "running",
    startedAt: new Date().toISOString(),
  };
  saveRun(run);

  const tracedWork = traceable(
    async (input: {
      runId: string;
      senders: string[];
      lookbackHours: number;
      maxEmailsPerRun: number;
      summaryStyle: "brief" | "detailed" | "bullet-points";
      provider: string;
      model: string;
      deliverEmail: boolean;
      deliverEmailTo: string;
    }): Promise<Summary> => {
      console.log("🔍 Fetching newsletters from Apple Mail...");
      const emails = await fetchNewsletterEmails(
        input.senders,
        input.lookbackHours,
        input.maxEmailsPerRun
      );
      console.log(`📧 Found ${emails.length} newsletter(s)`);

      const providerName = input.provider === "openai" ? "OpenAI" : "Claude";
      console.log(`🤖 Summarizing with ${providerName}...`);
      const language = config.settings.language || "English";
      const result = await summarizeNewsletters(
        emails,
        input.summaryStyle,
        {
          ...config.settings.llm,
          systemPrompt: `Write in ${language}.\n\n${config.settings.llm.systemPrompt}`,
        }
      );
      const { summary, systemPrompt, userMessage, rawResponse } = result;
      console.log(`✅ Summary created: ${summary.title}`);

      writeFileSync(
        join(DEBUG_DIR, `${input.runId}.json`),
        JSON.stringify(
          { runId: input.runId, emails, systemPrompt, userMessage, rawResponse, summary },
          null,
          2
        )
      );

      saveSummary(summary);

      if (input.deliverEmail && input.deliverEmailTo) {
        console.log("📤 Sending digest email...");
        await sendDigestEmail(summary, input.deliverEmailTo);
      }

      return summary;
    },
    {
      name: "newsletter-agent-run",
      run_type: "chain",
      tags: [
        config.settings.llm?.provider,
        config.settings.llm?.model,
        `style:${config.settings.summaryStyle}`,
      ].filter((t): t is string => Boolean(t)),
      metadata: {
        runId: run.id,
        provider: config.settings.llm?.provider,
        model: config.settings.llm?.model,
        style: config.settings.summaryStyle,
      },
    }
  );

  try {
    const summary = await tracedWork({
      runId: run.id,
      senders: config.settings.senders,
      lookbackHours: config.settings.lookbackHours,
      maxEmailsPerRun: config.settings.maxEmailsPerRun,
      summaryStyle: config.settings.summaryStyle,
      provider: config.settings.llm?.provider,
      model: config.settings.llm?.model,
      deliverEmail: config.settings.deliverEmail,
      deliverEmailTo: config.settings.deliverEmailTo ?? "",
    });

    run.status = "completed";
    run.completedAt = new Date().toISOString();
    run.summary = summary;
    saveRun(run);

    console.log("🎉 Newsletter agent run complete!");
    return run;
  } catch (error) {
    run.status = "failed";
    run.completedAt = new Date().toISOString();
    run.error = error instanceof Error ? error.message : String(error);
    saveRun(run);

    console.error("❌ Newsletter agent failed:", run.error);
    return run;
  }
}

// CLI entry point
if (require.main === module) {
  runNewsletterAgent().then(async (run) => {
    // Flush LangSmith traces before the process exits.
    const { awaitAllCallbacks } = await import("@langchain/core/callbacks/promises");
    await awaitAllCallbacks();
    process.exit(run.status === "completed" ? 0 : 1);
  });
}
