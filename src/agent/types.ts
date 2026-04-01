/**
 * Agent domain types.
 * Cross-domain types (AgentEntry, SandboxConfig, etc.) remain in src/shared/types.ts.
 */

import type { AgentEntry, SandboxConfig, ToolCall } from "../shared/types.ts";

export interface AgentConfig {
  model: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

export interface AgentResponse {
  content: string;
  toolCalls?: ToolCall[];
  finishReason?: string;
}

export interface Skill {
  name: string;
  description: string;
  content: string;
  path: string;
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
}
