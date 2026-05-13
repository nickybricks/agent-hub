import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOllama } from "@langchain/ollama";
import { traceable } from "langsmith/traceable";
import { z } from "zod";
import { Email, Summary } from "../lib/types";
import { randomUUID } from "crypto";

const DigestSchema = z.object({
  title: z.string().describe("Short headline summarizing today's digest (no leading '#')"),
  highlights: z
    .array(z.string())
    .min(3)
    .describe("Top takeaways across all newsletters, one sentence each. At least 3."),
  topics: z
    .array(
      z.object({
        heading: z.string().describe("Short topic heading (no leading '#')"),
        summary: z
          .string()
          .describe(
            "Summary of this topic. May be multiple paragraphs and may include markdown bullet points (lines starting with '- '). Go into as much depth as the source material warrants."
          ),
        links: z
          .array(
            z.object({
              label: z.string().describe("Short human-readable label for the link."),
              url: z.string().describe("URL exactly as it appeared in the source newsletter."),
            })
          )
          .describe("Links relevant to this topic. Empty array if none. Never invent URLs."),
      })
    )
    .describe("One entry per distinct topic covered in today's newsletters."),
});

type Digest = z.infer<typeof DigestSchema>;

function renderDigestMarkdown(digest: Digest): string {
  const parts: string[] = [];
  parts.push("## Highlights", "", ...digest.highlights.map((h) => `- ${h}`), "");
  for (const topic of digest.topics) {
    parts.push(`## ${topic.heading}`, "", topic.summary, "");
    if (topic.links.length > 0) {
      parts.push(...topic.links.map((l) => `- [${l.label}](${l.url})`), "");
    }
  }
  return parts.join("\n").trimEnd();
}

export interface LLMConfig {
  provider: "anthropic" | "openai" | "google" | "ollama";
  apiKeys?: { anthropic?: string; openai?: string; google?: string };
  apiKey?: string;
  baseUrl?: string;
  model: string;
  systemPrompt: string;
}

function resolveApiKey(config: LLMConfig): string {
  if (config.provider === "ollama") return "";
  const envKey =
    config.provider === "openai"
      ? process.env.OPENAI_API_KEY
      : config.provider === "google"
        ? process.env.GOOGLE_API_KEY
        : process.env.ANTHROPIC_API_KEY;
  const perProviderKey = config.apiKeys?.[config.provider as "anthropic" | "openai" | "google"];
  const key = envKey || perProviderKey || config.apiKey;
  if (!key) {
    const envVarName =
      config.provider === "openai"
        ? "OPENAI_API_KEY"
        : config.provider === "google"
          ? "GOOGLE_API_KEY"
          : "ANTHROPIC_API_KEY";
    throw new Error(
      `No API key found for provider "${config.provider}". Set ${envVarName} in your environment or add apiKey to config.`
    );
  }
  return key;
}

export function createLLM(config: LLMConfig): BaseChatModel {
  const apiKey = resolveApiKey(config);
  switch (config.provider) {
    case "anthropic":
      return new ChatAnthropic({ apiKey, model: config.model, temperature: 0 });
    case "openai":
      return new ChatOpenAI({ apiKey, model: config.model, temperature: 0 });
    case "google":
      return new ChatGoogleGenerativeAI({ apiKey, model: config.model, temperature: 0 });
    case "ollama":
      return new ChatOllama({
        baseUrl: config.baseUrl ?? "http://localhost:11434",
        model: config.model,
        temperature: 0,
      });
  }
}

export interface SummarizeResult {
  summary: Summary;
  systemPrompt: string;
  userMessage: string;
  rawResponse: Digest | string;
}

async function _summarizeNewsletters(
  emails: Email[],
  style: "brief" | "detailed" | "bullet-points",
  llmConfig: LLMConfig
): Promise<SummarizeResult> {
  if (emails.length === 0) {
    return {
      summary: {
        id: randomUUID(),
        agentId: "newsletter-summarizer",
        date: new Date().toISOString().split("T")[0],
        title: "No newsletters found",
        content: "No newsletter emails were found in the configured time window.",
        emailCount: 0,
        sources: [],
        createdAt: new Date().toISOString(),
      },
      systemPrompt: llmConfig.systemPrompt,
      userMessage: "",
      rawResponse: "",
    };
  }

  const styleInstructions = {
    brief:
      "Create a brief, concise summary (2-3 paragraphs max). Focus only on the most important highlights.",
    detailed:
      "Create a detailed summary with sections for each major topic. Include context and analysis where relevant.",
    "bullet-points":
      "Create a well-organized bullet-point summary. Group related items under topic headings.",
  };

  const emailContents = emails
    .map((e, i) => {
      const linksSection =
        e.links.length > 0
          ? `\nLinked anchor texts (use these to inline links as [text](url) in the matching topic; never invent URLs):\n${e.links.map((l) => `  - "${l.text}" -> ${l.url}`).join("\n")}\n`
          : "";
      const imagesSection =
        e.images.length > 0
          ? `\nImages (the body contains [IMAGE_N] markers showing where each appeared; include them as ![alt](url) in the topic where they fit):\n${e.images.map((img) => `  - ${img.id}${img.alt ? ` (alt: "${img.alt}")` : ""} -> ${img.url}`).join("\n")}\n`
          : "";
      return `--- Newsletter ${i + 1} ---\nFrom: ${e.sender}\nSubject: ${e.subject}\nDate: ${e.date}\n\n${e.body}${linksSection}${imagesSection}`;
    })
    .join("\n\n");

  const userMessage = `${styleInstructions[style]}\n\nWhen the body text contains a phrase listed under "Linked anchor texts", inline it as a markdown link [text](url) inside the topic summary. When a [IMAGE_N] marker appears in body text and the image is relevant (not a logo/decoration), include it as ![alt](url) in the topic summary at a sensible spot. Drop irrelevant images. Never invent URLs.\n\nHere are today's newsletters:\n\n${emailContents}`;

  const llm = createLLM(llmConfig);
  const structuredLLM = llm.withStructuredOutput(DigestSchema, {
    name: "newsletter_digest",
  });
  const structured = await structuredLLM.invoke(
    [new SystemMessage(llmConfig.systemPrompt), new HumanMessage(userMessage)],
    {
      runName: "llm-invoke",
      tags: [llmConfig.provider, llmConfig.model, `style:${style}`],
      metadata: {
        provider: llmConfig.provider,
        model: llmConfig.model,
        style,
        emailCount: emails.length,
        subjects: emails.map((e) => e.subject),
      },
    }
  );

  return {
    summary: {
      id: randomUUID(),
      agentId: "newsletter-summarizer",
      date: new Date().toISOString().split("T")[0],
      title: structured.title,
      content: renderDigestMarkdown(structured),
      emailCount: emails.length,
      sources: emails.map((e) => ({ sender: e.sender, subject: e.subject })),
      createdAt: new Date().toISOString(),
    },
    systemPrompt: llmConfig.systemPrompt,
    userMessage,
    rawResponse: structured,
  };
}

export const summarizeNewsletters = traceable(_summarizeNewsletters, {
  name: "summarize-newsletters",
  run_type: "chain",
});
