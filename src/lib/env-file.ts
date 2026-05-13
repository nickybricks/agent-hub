import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const ENV_PATH = join(process.cwd(), ".env.local");

export function upsertEnvVars(updates: Record<string, string>): void {
  let lines: string[] = [];
  if (existsSync(ENV_PATH)) {
    lines = readFileSync(ENV_PATH, "utf-8").split("\n");
  }
  for (const [key, value] of Object.entries(updates)) {
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
    const line = `${key}=${value}`;
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
  }
  // Ensure trailing newline
  const text = lines.join("\n").replace(/\n+$/, "") + "\n";
  writeFileSync(ENV_PATH, text, { mode: 0o600 });
  // Reflect into the current process for the rest of this request.
  for (const [k, v] of Object.entries(updates)) process.env[k] = v;
}
