import type { SandboxPermission } from "../../shared/types.ts";
import { DenoClawError } from "../../shared/errors.ts";
import type { BrokerMessage, TunnelCapabilities } from "../types.ts";
import { WS_BUFFERED_AMOUNT_HIGH_WATERMARK } from "../tunnel_protocol.ts";

export interface TunnelConnection {
  ws: WebSocket;
  capabilities: TunnelCapabilities;
  registered: boolean;
}

export function createPendingTunnelCapabilities(
  tunnelId: string,
): TunnelCapabilities {
  return {
    tunnelId,
    type: "local",
    tools: [],
    allowedAgents: [],
  };
}

export function sendBrokerMessageOverTunnel(
  ws: WebSocket,
  msg: BrokerMessage,
): void {
  if (ws.readyState !== WebSocket.OPEN) {
    throw new DenoClawError(
      "TUNNEL_NOT_OPEN",
      {
        readyState: ws.readyState,
        msgId: msg.id,
      },
      "Tunnel disconnected. Reconnect and retry.",
    );
  }
  if (ws.bufferedAmount > WS_BUFFERED_AMOUNT_HIGH_WATERMARK) {
    throw new DenoClawError(
      "TUNNEL_BACKPRESSURE",
      {
        bufferedAmount: ws.bufferedAmount,
        maxBufferedAmount: WS_BUFFERED_AMOUNT_HIGH_WATERMARK,
        msgId: msg.id,
      },
      "Tunnel is saturated. Retry after the relay drains pending messages.",
    );
  }
  ws.send(JSON.stringify(msg));
}

export class TunnelRegistry {
  private readonly tunnels = new Map<string, TunnelConnection>();

  get size(): number {
    return this.tunnels.size;
  }

  ids(): string[] {
    return [...this.tunnels.keys()];
  }

  entries(): IterableIterator<[string, TunnelConnection]> {
    return this.tunnels.entries();
  }

  values(): IterableIterator<TunnelConnection> {
    return this.tunnels.values();
  }

  get(tunnelId: string): TunnelConnection | undefined {
    return this.tunnels.get(tunnelId);
  }

  setPending(tunnelId: string, ws: WebSocket): void {
    this.tunnels.set(tunnelId, {
      ws,
      capabilities: createPendingTunnelCapabilities(tunnelId),
      registered: false,
    });
  }

  register(
    tunnelId: string,
    ws: WebSocket,
    capabilities: TunnelCapabilities,
  ): TunnelConnection {
    const entry: TunnelConnection = {
      ws,
      capabilities,
      registered: true,
    };
    this.tunnels.set(tunnelId, entry);
    return entry;
  }

  delete(tunnelId: string): void {
    this.tunnels.delete(tunnelId);
  }

  clear(): void {
    this.tunnels.clear();
  }

  findToolSocket(tool: string): WebSocket | null {
    for (const tunnel of this.tunnels.values()) {
      if (tunnel.registered && tunnel.capabilities.tools.includes(tool)) {
        return tunnel.ws;
      }
    }
    return null;
  }

  findInstanceSocketForAgent(agentId: string): WebSocket | null {
    for (const tunnel of this.tunnels.values()) {
      if (
        tunnel.registered &&
        tunnel.capabilities.type === "instance" &&
        tunnel.capabilities.agents?.includes(agentId)
      ) {
        return tunnel.ws;
      }
    }
    return null;
  }

  findRemoteBrokerConnection(remoteBrokerId: string): TunnelConnection | null {
    const entry = this.tunnels.get(remoteBrokerId);
    if (entry?.registered && entry.capabilities.type === "instance") {
      return entry;
    }
    return null;
  }

  findReplySocket(agentId: string): WebSocket | null {
    const instanceSocket = this.findInstanceSocketForAgent(agentId);
    if (instanceSocket) return instanceSocket;

    for (const tunnel of this.tunnels.values()) {
      if (
        tunnel.registered &&
        tunnel.capabilities.type === "local" &&
        tunnel.capabilities.allowedAgents.includes(agentId)
      ) {
        return tunnel.ws;
      }
    }
    return null;
  }

  collectAdvertisedAgentIds(): string[] {
    return [...this.tunnels.values()]
      .filter((tunnel) => tunnel.registered && tunnel.capabilities.agents)
      .flatMap((tunnel) => tunnel.capabilities.agents ?? []);
  }

  getDeclaredToolPermissions(): Record<string, SandboxPermission[]> {
    const tunnelPermissions: Record<string, SandboxPermission[]> = {};
    for (const tunnel of this.tunnels.values()) {
      for (
        const [toolName, permissions] of Object.entries(
          tunnel.capabilities.toolPermissions ?? {},
        )
      ) {
        if (!tunnelPermissions[toolName]) {
          tunnelPermissions[toolName] = [...permissions];
        }
      }
    }
    return tunnelPermissions;
  }
}
