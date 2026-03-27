/**
 * Agent domain types — phase 2 DDD migration.
 *
 * Types spécifiques au domaine agent (non partagés avec d'autres bounded contexts).
 * Les types cross-domain (AgentConfig, AgentEntry, SandboxConfig…) restent dans src/shared/types.ts.
 */

import type { AgentEntry, SandboxConfig } from "../shared/types.ts";

export interface Skill {
  name: string;
  description: string;
  content: string;
  path: string;
}

export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  task: string;
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
}

export interface AgentDefaults {
  model: string;
  temperature: number;
  maxTokens: number;
  systemPrompt?: string;
  sandbox?: SandboxConfig;
}

export interface AgentsConfig {
  defaults: AgentDefaults;
  registry?: Record<string, AgentEntry>;
}

export interface ToolsConfig {
  restrictToWorkspace?: boolean;
  allowedCommands?: string[];
  deniedCommands?: string[];
}
