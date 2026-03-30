export interface ConnectedAgentSocket {
  ws: WebSocket;
  connectedAt: string;
  authIdentity: string;
}

export class BrokerAgentSocketRegistry {
  private connectedAgents = new Map<string, ConnectedAgentSocket>();

  register(agentId: string, socket: WebSocket, authIdentity: string): void {
    const previous = this.connectedAgents.get(agentId);
    if (previous && previous.ws !== socket) {
      try {
        previous.ws.close(1000, "Replaced by a newer agent socket");
      } catch {
        // ignore close errors
      }
    }

    this.connectedAgents.set(agentId, {
      ws: socket,
      connectedAt: new Date().toISOString(),
      authIdentity,
    });
  }

  get(agentId: string): ConnectedAgentSocket | null {
    return this.connectedAgents.get(agentId) ?? null;
  }

  getSocket(agentId: string): WebSocket | null {
    return this.connectedAgents.get(agentId)?.ws ?? null;
  }

  unregisterIfCurrent(agentId: string, socket: WebSocket): boolean {
    const current = this.connectedAgents.get(agentId);
    if (current?.ws !== socket) return false;
    this.connectedAgents.delete(agentId);
    return true;
  }

  entries(): IterableIterator<[string, ConnectedAgentSocket]> {
    return this.connectedAgents.entries();
  }

  closeAll(
    code: number,
    reason: string,
    onError?: (agentId: string, error: unknown) => void,
  ): void {
    for (const [agentId, entry] of this.connectedAgents) {
      try {
        entry.ws.close(code, reason);
      } catch (error) {
        onError?.(agentId, error);
      }
    }
    this.connectedAgents.clear();
  }
}
