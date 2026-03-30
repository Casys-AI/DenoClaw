import { log } from "../../shared/log.ts";
import type { AuthManager } from "../auth.ts";
import type { BrokerAgentSocketRegistry } from "./agent_socket_registry.ts";
import type { TunnelRegistry } from "./tunnel_registry.ts";
import type { TaskStore } from "../../messaging/a2a/tasks.ts";

export interface BrokerLifecycleRuntimeDeps {
  connectedAgents: BrokerAgentSocketRegistry;
  tunnelRegistry: TunnelRegistry;
  taskStore: TaskStore;
  getAuth(): Promise<AuthManager>;
  handleHttp(req: Request): Promise<Response>;
  closeOwnedKv(): void;
}

export class BrokerLifecycleRuntime {
  private httpServer?: Deno.HttpServer;

  constructor(private readonly deps: BrokerLifecycleRuntimeDeps) {}

  async start(port: number): Promise<void> {
    if (!Deno.env.get("DENOCLAW_API_TOKEN")) {
      log.warn(
        "DENOCLAW_API_TOKEN not set — broker running in unauthenticated mode. Do not use in production.",
      );
    }

    await this.deps.getAuth();
    this.httpServer = Deno.serve({ port }, (req) => this.deps.handleHttp(req));
    log.info(`Broker started on port ${port}`);
  }

  async stop(): Promise<void> {
    if (this.httpServer) await this.httpServer.shutdown();
    this.deps.connectedAgents.closeAll(
      1001,
      "Broker shutting down",
      (agentId, error) =>
        log.warn(`Failed to close agent socket ${agentId} cleanly`, error),
    );
    for (const [tunnelId, entry] of this.deps.tunnelRegistry.entries()) {
      try {
        entry.ws.close(1001, "Broker shutting down");
      } catch (error) {
        log.warn(`Failed to close tunnel ${tunnelId} cleanly`, error);
      }
    }
    this.deps.tunnelRegistry.clear();
    this.deps.taskStore.close();
    this.deps.closeOwnedKv();
    log.info("Broker stopped");
  }
}
