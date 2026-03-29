import type { TunnelCapabilities } from "../../types.ts";
import type { RemoteAgentCatalogEntry } from "../types.ts";

export function mapInstanceTunnelToCatalog(
  tunnelId: string,
  capabilities: TunnelCapabilities,
): RemoteAgentCatalogEntry[] {
  if (capabilities.type !== "instance") return [];

  return (capabilities.agents ?? []).map((agentId) => ({
    remoteBrokerId: tunnelId,
    agentId,
    card: {},
    capabilities: capabilities.tools,
    visibility: capabilities.allowedAgents.includes(agentId)
      ? "public"
      : "restricted",
  }));
}
