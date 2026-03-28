import type { AgentEntry } from "../shared/types.ts";
import {
  ensureDir,
  fileExists,
  getAgentConfigPath,
  getAgentDefDir,
  getAgentMemoriesDir,
  getAgentMemoryPath,
  getAgentSkillsDir,
  getAgentSoulPath,
  getProjectAgentsDir,
} from "../shared/helpers.ts";
import { DenoClawError } from "../shared/errors.ts";
import { log } from "../shared/log.ts";

export interface AgentWorkspace {
  agentId: string;
  entry: AgentEntry;
  systemPrompt?: string;
  skillsDir?: string;
  memoryPath: string;
}

export class WorkspaceLoader {
  static async load(agentId: string): Promise<AgentWorkspace | null> {
    const configPath = getAgentConfigPath(agentId);
    if (!(await fileExists(configPath))) return null;

    try {
      const raw = await Deno.readTextFile(configPath);
      const parsed = JSON.parse(raw);
      const entry = WorkspaceLoader.validateEntry(agentId, parsed);

      let systemPrompt: string | undefined;
      const soulPath = getAgentSoulPath(agentId);
      if (await fileExists(soulPath)) {
        systemPrompt = await Deno.readTextFile(soulPath);
      }

      const skillsDir = getAgentSkillsDir(agentId);
      const hasSkills = await fileExists(skillsDir);

      return {
        agentId,
        entry,
        systemPrompt,
        skillsDir: hasSkills ? skillsDir : undefined,
        memoryPath: getAgentMemoryPath(agentId),
      };
    } catch (e) {
      log.error(`Échec chargement workspace ${agentId}`, e);
      return null;
    }
  }

  static async exists(agentId: string): Promise<boolean> {
    return await fileExists(getAgentConfigPath(agentId));
  }

  static async create(
    agentId: string,
    entry: AgentEntry,
    systemPrompt?: string,
  ): Promise<void> {
    const dir = getAgentDefDir(agentId);
    await ensureDir(dir);

    await Deno.writeTextFile(
      getAgentConfigPath(agentId),
      JSON.stringify(entry, null, 2),
    );

    if (systemPrompt) {
      await Deno.writeTextFile(getAgentSoulPath(agentId), systemPrompt);
    }

    await ensureDir(getAgentSkillsDir(agentId));
    await ensureDir(getAgentMemoriesDir(agentId));
    log.info(`Workspace créé : ${agentId}`);
  }

  static async delete(agentId: string): Promise<void> {
    const dir = getAgentDefDir(agentId);
    if (await fileExists(dir)) {
      await Deno.remove(dir, { recursive: true });
      log.info(`Workspace supprimé : ${agentId}`);
    }
  }

  static async listAll(): Promise<string[]> {
    const dir = getProjectAgentsDir();
    if (!(await fileExists(dir))) return [];

    const agents: string[] = [];
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isDirectory) {
        if (await fileExists(getAgentConfigPath(entry.name))) {
          agents.push(entry.name);
        }
      }
    }
    return agents.sort();
  }

  static async buildRegistry(): Promise<Record<string, AgentEntry>> {
    const ids = await WorkspaceLoader.listAll();
    const registry: Record<string, AgentEntry> = {};

    for (const id of ids) {
      const ws = await WorkspaceLoader.load(id);
      if (ws) {
        const entry = { ...ws.entry };
        if (ws.systemPrompt) entry.systemPrompt = ws.systemPrompt;
        registry[id] = entry;
      }
    }
    return registry;
  }

  private static validateEntry(
    agentId: string,
    parsed: unknown,
  ): AgentEntry {
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new DenoClawError(
        "INVALID_AGENT_CONFIG",
        { agentId },
        "agent.json must be a JSON object",
      );
    }
    const obj = parsed as Record<string, unknown>;
    const sandbox = obj.sandbox;
    if (
      !sandbox || typeof sandbox !== "object" || Array.isArray(sandbox) ||
      !Array.isArray((sandbox as Record<string, unknown>).allowedPermissions)
    ) {
      throw new DenoClawError(
        "INVALID_AGENT_CONFIG",
        { agentId, field: "sandbox.allowedPermissions" },
        "agent.json requires sandbox.allowedPermissions array",
      );
    }
    return obj as unknown as AgentEntry;
  }
}
