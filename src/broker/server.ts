import type { BrokerMessage, LLMRequest, ToolRequest, TunnelCapabilities } from "./types.ts";
import type { Config } from "../types.ts";
import { ProviderManager } from "../providers/manager.ts";
import { generateId } from "../utils/helpers.ts";
import { log } from "../utils/log.ts";

/**
 * Broker server — runs on Deno Deploy.
 *
 * Responsibilities:
 * - LLM Proxy (API keys + CLI tunnel routing)
 * - Message routing between agents (KV Queues)
 * - Tunnel hub (WebSocket connections to local machines)
 * - Agent lifecycle (Subhosting + Sandbox CRUD)
 */
export class BrokerServer {
  private providers: ProviderManager;
  private kv: Deno.Kv | null = null;
  private tunnels = new Map<string, { ws: WebSocket; capabilities: TunnelCapabilities }>();
  private httpServer?: Deno.HttpServer;

  constructor(config: Config) {
    this.providers = new ProviderManager(config);
  }

  private async getKv(): Promise<Deno.Kv> {
    if (!this.kv) this.kv = await Deno.openKv();
    return this.kv;
  }

  async start(port = 3000): Promise<void> {
    const kv = await this.getKv();

    // Listen for agent requests via KV Queue
    kv.listenQueue(async (raw: unknown) => {
      const msg = raw as BrokerMessage;
      if (msg.to !== "broker") return;
      await this.handleMessage(msg);
    });

    // HTTP + WebSocket server
    this.httpServer = Deno.serve({ port }, (req) => this.handleHttp(req));

    log.info(`Broker démarré sur port ${port}`);
  }

  private async handleMessage(msg: BrokerMessage): Promise<void> {
    log.info(`Broker: ${msg.type} de ${msg.from}`);

    try {
      switch (msg.type) {
        case "llm_request":
          await this.handleLLMRequest(msg);
          break;
        case "tool_request":
          await this.handleToolRequest(msg);
          break;
        case "agent_message":
          await this.handleAgentMessage(msg);
          break;
        default:
          log.warn(`Type de message inconnu : ${msg.type}`);
      }
    } catch (e) {
      await this.sendError(msg.from, msg.id, (e as Error).message);
    }
  }

  // ── LLM Proxy ───────────────────────────────────────

  private async handleLLMRequest(msg: BrokerMessage): Promise<void> {
    const req = msg.payload as LLMRequest;
    const kv = await this.getKv();

    // Check if model is a CLI provider → route to tunnel
    const tunnel = this.findTunnelForProvider(req.model);
    if (tunnel) {
      await this.routeToTunnel(tunnel, msg);
      return;
    }

    // Otherwise: direct API call (broker has the keys)
    const response = await this.providers.complete(
      req.messages.map((m) => ({
        role: m.role as "system" | "user" | "assistant" | "tool",
        content: m.content,
        name: m.name,
        tool_call_id: m.tool_call_id,
        tool_calls: m.tool_calls as undefined,
      })),
      req.model,
      req.temperature,
      req.maxTokens,
      req.tools as undefined,
    );

    const reply: BrokerMessage = {
      id: msg.id,
      from: "broker",
      to: msg.from,
      type: "llm_response",
      payload: response,
      timestamp: new Date().toISOString(),
    };

    await kv.enqueue(reply);
  }

  // ── Tool routing ────────────────────────────────────

  private async handleToolRequest(msg: BrokerMessage): Promise<void> {
    const req = msg.payload as ToolRequest;

    const tunnel = this.findTunnelForTool(req.tool);
    if (tunnel) {
      await this.routeToTunnel(tunnel, msg);
      return;
    }

    await this.sendError(msg.from, msg.id, `No tunnel available for tool: ${req.tool}`);
  }

  // ── Inter-agent routing ─────────────────────────────

  private async handleAgentMessage(msg: BrokerMessage): Promise<void> {
    const payload = msg.payload as { targetAgent: string; instruction: string; data?: unknown };
    const kv = await this.getKv();

    const forwarded: BrokerMessage = {
      id: generateId(),
      from: msg.from,
      to: payload.targetAgent,
      type: "agent_message",
      payload: { instruction: payload.instruction, data: payload.data },
      timestamp: new Date().toISOString(),
    };

    await kv.enqueue(forwarded);
    log.info(`Message routé : ${msg.from} → ${payload.targetAgent}`);
  }

  // ── Tunnel management ───────────────────────────────

  private findTunnelForProvider(model: string): WebSocket | null {
    for (const [_, t] of this.tunnels) {
      if (t.capabilities.providers.some((p) => model.startsWith(p))) {
        return t.ws;
      }
    }
    return null;
  }

  private findTunnelForTool(tool: string): WebSocket | null {
    for (const [_, t] of this.tunnels) {
      if (t.capabilities.tools.includes(tool)) {
        return t.ws;
      }
    }
    return null;
  }

  private async routeToTunnel(ws: WebSocket, msg: BrokerMessage): Promise<void> {
    // Send to tunnel via WebSocket, tunnel will respond, we relay back via KV Queue
    ws.send(JSON.stringify(msg));
    // Response comes back via ws.onmessage → relayed in handleTunnelMessage
    await Promise.resolve();
  }

  private async handleTunnelMessage(data: string): Promise<void> {
    const msg = JSON.parse(data) as BrokerMessage;
    const kv = await this.getKv();
    await kv.enqueue(msg);
  }

  // ── HTTP + WebSocket ────────────────────────────────

  private handleHttp(req: Request): Response {
    const url = new URL(req.url);

    // Health check
    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        tunnels: [...this.tunnels.keys()],
        tunnelCount: this.tunnels.size,
      });
    }

    // Tunnel WebSocket upgrade
    if (url.pathname === "/tunnel") {
      const upgrade = req.headers.get("upgrade") || "";
      if (upgrade.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }

      const { socket, response } = Deno.upgradeWebSocket(req);
      const tunnelId = url.searchParams.get("id") || generateId();

      socket.onopen = () => {
        log.info(`Tunnel connecté : ${tunnelId}`);
      };

      socket.onmessage = async (e) => {
        try {
          const data = JSON.parse(e.data as string);

          // First message = capabilities registration
          if (data.type === "register") {
            const caps = data as TunnelCapabilities;
            caps.tunnelId = tunnelId;
            this.tunnels.set(tunnelId, { ws: socket, capabilities: caps });
            log.info(`Tunnel enregistré : ${tunnelId} (providers: ${caps.providers}, tools: ${caps.tools})`);
            socket.send(JSON.stringify({ type: "registered", tunnelId }));
            return;
          }

          // Otherwise = response to a routed request
          await this.handleTunnelMessage(e.data as string);
        } catch (err) {
          log.error(`Erreur tunnel ${tunnelId}`, err);
        }
      };

      socket.onclose = () => {
        this.tunnels.delete(tunnelId);
        log.info(`Tunnel déconnecté : ${tunnelId}`);
      };

      return response;
    }

    return new Response("DenoClaw Broker", { status: 200 });
  }

  // ── Helpers ─────────────────────────────────────────

  private async sendError(to: string, requestId: string, message: string): Promise<void> {
    const kv = await this.getKv();
    const reply: BrokerMessage = {
      id: requestId,
      from: "broker",
      to,
      type: "error",
      payload: { code: "BROKER_ERROR", context: { message }, recovery: "Check broker logs" },
      timestamp: new Date().toISOString(),
    };
    await kv.enqueue(reply);
  }

  async stop(): Promise<void> {
    if (this.httpServer) await this.httpServer.shutdown();
    for (const [_, t] of this.tunnels) {
      try { t.ws.close(); } catch { /* */ }
    }
    this.tunnels.clear();
    if (this.kv) { this.kv.close(); this.kv = null; }
    log.info("Broker arrêté");
  }
}
