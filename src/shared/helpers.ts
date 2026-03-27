import { join } from "@std/path";

export function getHomeDir(): string {
  const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || ".";
  return join(home, ".denoclaw");
}

export function getConfigPath(): string {
  return join(getHomeDir(), "config.json");
}

export function getMemoryDir(): string {
  return join(getHomeDir(), "memory");
}

export function getSkillsDir(): string {
  return join(getHomeDir(), "skills");
}

export function getCronJobsPath(): string {
  return join(getHomeDir(), "cron.json");
}

export function getAgentsDir(): string {
  return join(getHomeDir(), "agents");
}

export function validateAgentId(agentId: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(agentId)) {
    throw new Error(`Invalid agent ID "${agentId}" — must be alphanumeric with hyphens/underscores/dots`);
  }
}

export function getAgentDir(agentId: string): string {
  validateAgentId(agentId);
  return join(getAgentsDir(), agentId);
}

export function getAgentConfigPath(agentId: string): string {
  return join(getAgentDir(agentId), "agent.json");
}

export function getAgentSoulPath(agentId: string): string {
  return join(getAgentDir(agentId), "soul.md");
}

export function getAgentSkillsDir(agentId: string): string {
  return join(getAgentDir(agentId), "skills");
}

export function getAgentMemoryPath(agentId: string): string {
  return join(getAgentDir(agentId), "memory.db");
}

export function generateId(): string {
  return crypto.randomUUID();
}

export function formatDate(date: Date): string {
  return date.toISOString();
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

export async function ensureDir(path: string): Promise<void> {
  try {
    await Deno.mkdir(path, { recursive: true });
  } catch (e) {
    if (!(e instanceof Deno.errors.AlreadyExists)) throw e;
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}
