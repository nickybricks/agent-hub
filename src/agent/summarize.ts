import Anthropic from "@anthropic-ai/sdk";
import { Email, Summary } from "../lib/types";
import { randomUUID } from "crypto";

interface LLMConfig {
  provider: "anthropic" | "openai";
  apiKey: string;
  model: string;
  systemPrompt: string;
}

async function callLLM(
  config: LLMConfig,
  userMessage: string
): Promise<string> {
  if (config.provider === "openai") {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 4096,
        messages: [
          { role: "system", content: config.systemPrompt },
          { role: "user", content: userMessage },
        ],
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(
        `OpenAI API error: ${response.status} ${JSON.stringify(data)}`
      );
    }
    return data.choices[0].message.content;
  }

  // Default: Anthropic
  const client = new Anthropic({ apiKey: config.apiKey });
  const message = await client.messages.create({
    model: config.model,
    max_tokens: 4096,
    system: config.systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  return message.content[0].type === "text" ? message.content[0].text : "";
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
    .map(
      (e, i) =>
        `--- Newsletter ${i + 1} ---\nFrom: ${e.sender}\nSubject: ${e.subject}\nDate: ${e.date}\n\n${e.body}\n`
    )
    .join("\n\n");

  const userMessage = `${styleInstructions[style]}

Here are today's newsletters:

${emailContents}`;

  const content = await callLLM(llmConfig, userMessage);

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
