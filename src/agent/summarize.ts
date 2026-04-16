import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOllama } from "@langchain/ollama";
import { Email, Summary } from "../lib/types";
import { randomUUID } from "crypto";

interface LLMConfig {
  provider: "anthropic" | "openai" | "google" | "ollama";
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
  const key = envKey || config.apiKey;
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

function createLLM(config: LLMConfig): BaseChatModel {
  const apiKey = resolveApiKey(config);
  switch (config.provider) {
    case "anthropic":
      return new ChatAnthropic({ apiKey, model: config.model });
    case "openai":
      return new ChatOpenAI({ apiKey, model: config.model });
    case "google":
      return new ChatGoogleGenerativeAI({ apiKey, model: config.model });
    case "ollama":
      return new ChatOllama({
        baseUrl: config.baseUrl ?? "http://localhost:11434",
        model: config.model,
      });
  }
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c): c is { type: "text"; text: string } => c?.type === "text")
      .map((c) => c.text)
      .join("");
  }
  return "";
}

export async function summarizeNewsletters(
  emails: Email[],
  style: "brief" | "detailed" | "bullet-points",
  llmConfig: LLMConfig
): Promise<Summary> {
  if (emails.length === 0) {
    return {
      id: randomUUID(),
      agentId: "newsletter-summarizer",
      date: new Date().toISOString().split("T")[0],
      title: "No newsletters found",
      content: "No newsletter emails were found in the configured time window.",
      emailCount: 0,
      sources: [],
      createdAt: new Date().toISOString(),
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
          ? `\nLinks found in this email:\n${e.links.map((l, j) => `  [${j + 1}] ${l}`).join("\n")}\n`
          : "";
      return `--- Newsletter ${i + 1} ---\nFrom: ${e.sender}\nSubject: ${e.subject}\nDate: ${e.date}\n\n${e.body}${linksSection}`;
    })
    .join("\n\n");

  const userMessage = `${styleInstructions[style]}\n\nHere are today's newsletters:\n\n${emailContents}`;

  const llm = createLLM(llmConfig);
  const response = await llm.invoke([
    new SystemMessage(llmConfig.systemPrompt),
    new HumanMessage(userMessage),
  ]);

  const content = extractText(response.content);

  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = titleMatch
    ? titleMatch[1]
    : `AI News Digest - ${new Date().toLocaleDateString()}`;

  return {
    id: randomUUID(),
    agentId: "newsletter-summarizer",
    date: new Date().toISOString().split("T")[0],
    title,
    content,
    emailCount: emails.length,
    sources: emails.map((e) => ({ sender: e.sender, subject: e.subject })),
    createdAt: new Date().toISOString(),
  };
}
