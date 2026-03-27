/**
 * Config aggregate — assemble les sub-configs de chaque bounded context.
 */

import type { AgentsConfig, ToolsConfig } from "../agent/types.ts";
import type { ChannelsConfig } from "../messaging/types.ts";
import type { ProvidersConfig } from "../llm/types.ts";

export interface Config {
  providers: ProvidersConfig;
  agents: AgentsConfig;
  tools: ToolsConfig;
  channels: ChannelsConfig;
  gateway?: { port: number };
}
