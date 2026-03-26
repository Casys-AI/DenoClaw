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
