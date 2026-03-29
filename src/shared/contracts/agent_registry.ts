import type { SandboxConfig } from "./sandbox.ts";

export type ChannelRouting =
  | "direct"
  | "round-robin"
  | "by-intent"
  | "broadcast";

export interface AgentEntry {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  description?: string;
  // Sandbox (ADR-005)
  sandbox?: SandboxConfig;
  // A2A peers (ADR-006) — closed by default
  peers?: string[]; // agents I can send Tasks to
  acceptFrom?: string[]; // agents I accept Tasks from ("*" = all)
  // Channels — where I receive user messages from
  channels?: string[]; // assigned channel names
  channelRouting?: ChannelRouting;
}
