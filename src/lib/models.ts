export interface ModelOption {
  id: string;
  label: string;
}

export const PROVIDER_MODELS: Record<string, ModelOption[]> = {
  anthropic: [
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
    { id: "claude-sonnet-4-6",         label: "Claude Sonnet 4.6" },
    { id: "claude-opus-4-6",           label: "Claude Opus 4.6" },
    { id: "custom",                    label: "Custom…" },
  ],
  openai: [
    { id: "gpt-4o",      label: "GPT-4o" },
    { id: "gpt-4o-mini", label: "GPT-4o mini" },
    { id: "gpt-4-turbo", label: "GPT-4 Turbo" },
    { id: "custom",      label: "Custom…" },
  ],
  google: [
    { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
    { id: "gemini-1.5-pro",   label: "Gemini 1.5 Pro" },
    { id: "gemini-1.5-flash", label: "Gemini 1.5 Flash" },
    { id: "custom",           label: "Custom…" },
  ],
  ollama: [
    { id: "llama3.2", label: "Llama 3.2" },
    { id: "gemma3",   label: "Gemma 3" },
    { id: "gemma4",   label: "Gemma 4" },
    { id: "mistral",  label: "Mistral" },
    { id: "custom",   label: "Custom…" },
  ],
};

export const PROVIDER_DEFAULTS: Record<string, string> = {
  anthropic: "claude-sonnet-4-6",
  openai:    "gpt-4o",
  google:    "gemini-2.0-flash",
  ollama:    "llama3.2",
};
