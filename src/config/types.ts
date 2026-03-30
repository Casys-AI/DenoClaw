/**
 * Config aggregate — assembles the sub-configs for each bounded context.
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
  deploy?: {
    org?: string;
    app?: string;
    region?: string;
    kvDatabase?: string;
    url?: string;
    oidcAudience?: string;
  };
}
