import { join } from "@std/path";
import { DenoClawError } from "./errors.ts";

export function getHomeDir(): string {
  const override = Deno.env.get("DENOCLAW_HOME_DIR");
  if (override) return override;
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

export function isDeployEnvironment(): boolean {
  return !!Deno.env.get("DENO_DEPLOYMENT_ID");
}

export function getCronJobsPath(): string {
  return join(getHomeDir(), "cron.json");
}

// ── Agent paths: definition (project-level, versionable) ──

export function getProjectAgentsDir(): string {
  const override = Deno.env.get("DENOCLAW_AGENTS_DIR");
  if (override) return override;
  return join(Deno.cwd(), "data", "agents");
}

export function validateAgentId(agentId: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(agentId)) {
    throw new DenoClawError(
      "INVALID_AGENT_ID",
      { agentId },
      "Agent ID must be alphanumeric with hyphens/underscores/dots",
    );
  }
}

export function getAgentDefDir(agentId: string): string {
  validateAgentId(agentId);
  return join(getProjectAgentsDir(), agentId);
}

export function getAgentConfigPath(agentId: string): string {
  return join(getAgentDefDir(agentId), "agent.json");
}

export function getAgentSoulPath(agentId: string): string {
  return join(getAgentDefDir(agentId), "soul.md");
}

export function getAgentSkillsDir(agentId: string): string {
  return join(getAgentDefDir(agentId), "skills");
}

export function getAgentMemoriesDir(agentId: string): string {
  return join(getAgentDefDir(agentId), "memories");
}

// ── Agent paths: runtime (machine-level, not versioned) ──

export function getAgentRuntimeDir(agentId: string): string {
  validateAgentId(agentId);
  return join(getHomeDir(), "agents", agentId);
}

export function getAgentMemoryPath(agentId: string): string {
  return join(getAgentRuntimeDir(agentId), "memory.db");
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
