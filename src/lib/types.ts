export interface AgentConfig {
  id: string;
  name: string;
  description: string;
  icon: string;
  enabled: boolean;
  schedule: {
    enabled: boolean;
    time: string; // HH:mm format
    days: number[]; // 0=Sun, 1=Mon, ..., 6=Sat
  };
  settings: Record<string, unknown>;
}

export interface NewsletterAgent extends AgentConfig {
  settings: {
    senders: string[];
    lookbackHours: number;
    maxEmailsPerRun: number;
    summaryStyle: "brief" | "detailed" | "bullet-points";
    language: string;
    deliverEmail: boolean;
    deliverEmailTo: string;
    llm: {
      provider: "anthropic" | "openai" | "google" | "ollama";
      apiKeys?: { anthropic?: string; openai?: string; google?: string };
      apiKey?: string;   // legacy single-key field; superseded by apiKeys
      baseUrl?: string;  // ollama only; default: http://localhost:11434
      model: string;
      systemPrompt: string;
    };
  };
}

export interface Email {
  id: string;
  subject: string;
  sender: string;
  senderEmail: string;
  date: string;
  body: string;
  links: { text: string; url: string }[];
  images: { id: string; url: string; alt: string }[];
  isRead: boolean;
}

export interface Summary {
  id: string;
  agentId: string;
  date: string;
  title: string;
  content: string;
  emailCount: number;
  sources: { sender: string; subject: string }[];
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  error?: string;
  summary?: Summary;
}
