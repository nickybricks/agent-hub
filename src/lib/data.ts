import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { AgentConfig, Summary, AgentRun } from "./types";

const DATA_DIR = join(process.cwd(), "data");
const CONFIG_FILE = join(DATA_DIR, "config.json");
const SUMMARIES_DIR = join(DATA_DIR, "summaries");
const RUNS_FILE = join(DATA_DIR, "runs.json");

export function getConfig(): { agents: AgentConfig[] } {
  return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
}

export function saveConfig(config: { agents: AgentConfig[] }) {
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export function getAgent(id: string): AgentConfig | undefined {
  const config = getConfig();
  return config.agents.find((a) => a.id === id);
}

export function updateAgent(id: string, updates: Partial<AgentConfig>) {
  const config = getConfig();
  const idx = config.agents.findIndex((a) => a.id === id);
  if (idx >= 0) {
    config.agents[idx] = { ...config.agents[idx], ...updates };
    saveConfig(config);
  }
}

export function getSummaries(limit = 30): Summary[] {
  if (!existsSync(SUMMARIES_DIR)) return [];

  const files = readdirSync(SUMMARIES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse();

  const summaries: Summary[] = [];
  for (const file of files) {
    if (summaries.length >= limit) break;
    const data = JSON.parse(
      readFileSync(join(SUMMARIES_DIR, file), "utf-8")
    );
    summaries.push(...(Array.isArray(data) ? data : [data]));
  }

  return summaries.slice(0, limit);
}

export function getSummary(id: string): Summary | undefined {
  const all = getSummaries(100);
  return all.find((s) => s.id === id);
}

export function getRuns(agentId?: string, limit = 20): AgentRun[] {
  if (!existsSync(RUNS_FILE)) return [];
  const runs: AgentRun[] = JSON.parse(readFileSync(RUNS_FILE, "utf-8"));
  const filtered = agentId ? runs.filter((r) => r.agentId === agentId) : runs;
  return filtered.slice(0, limit);
}
