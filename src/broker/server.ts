import type { BrokerMessage, LLMRequest, ToolRequest, TunnelCapabilities } from "./types.ts";
import type { Config, SandboxPermission } from "../types.ts";
import { ProviderManager } from "../providers/manager.ts";
import { SandboxManager } from "../sandbox/mod.ts";
import { generateId } from "../utils/helpers.ts";
import { log } from "../utils/log.ts";

interface AgentPeerConfig {
  peers?: string[];
  acceptFrom?: string[];
  sandbox?: { allowedPermissions?: string[] };
}

/** Known tool → permissions mapping (ADR-005) */
const TOOL_PERMISSIONS: Record<string, SandboxPermission[]> = {
  shell: ["run"],
  read_file: ["read"],
  write_file: ["write"],
  web_fetch: ["net"],
};

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
  private config: Config;
  private providers: ProviderManager;
  private sandbox: SandboxManager;
  private kv: Deno.Kv | null = null;
  private tunnels = new Map<string, { ws: WebSocket; capabilities: TunnelCapabilities }>();
  private httpServer?: Deno.HttpServer;

  constructor(config: Config) {
    this.config = config;
    this.providers = new ProviderManager(config);
    this.sandbox = new SandboxManager();
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

  // ── Tool routing (ADR-005: permissions par intersection) ─

  private async handleToolRequest(msg: BrokerMessage): Promise<void> {
    const req = msg.payload as ToolRequest;
    const kv = await this.getKv();

    // 1. Check permissions (intersection tool × agent)
    const toolPerms = TOOL_PERMISSIONS[req.tool] || [];
    const agentConfig = await kv.get<{ sandbox?: { allowedPermissions?: string[] } }>(
      ["agents", msg.from, "config"],
    );
    const agentAllowed = (agentConfig.value?.sandbox?.allowedPermissions ||
      ["read", "write", "run", "net"]) as SandboxPermission[];

    const granted = toolPerms.filter((p) => agentAllowed.includes(p));
    const denied = toolPerms.filter((p) => !agentAllowed.includes(p));

    if (denied.length > 0) {
      await this.sendStructuredError(msg.from, msg.id, {
        code: "SANDBOX_PERMISSION_DENIED",
        context: { tool: req.tool, required: toolPerms, agentAllowed, denied },
        recovery: `Add ${JSON.stringify(denied)} to agent sandbox.allowedPermissions`,
      });
      return;
    }

    // 2. Try tunnel first (local tools)
    const tunnel = this.findTunnelForTool(req.tool);
    if (tunnel) {
      await this.routeToTunnel(tunnel, msg);
      return;
    }

    // 3. Execute in Sandbox (éphémère)
    try {
      const code = this.buildSandboxCode(req.tool, req.args);
      const networkAllow = this.config.agents?.defaults?.sandbox?.networkAllow || [];
      const maxDuration = this.config.agents?.defaults?.sandbox?.maxDurationSec || 30;

      log.info(`Sandbox: ${req.tool} avec permissions ${JSON.stringify(granted)}`);

      const result = await this.sandbox.run(code, {
        memoryMb: 256,
        timeoutSec: maxDuration,
        networkAllow,
      });

      const reply: BrokerMessage = {
        id: msg.id,
        from: "broker",
        to: msg.from,
        type: "tool_response",
        payload: {
          success: result.exitCode === 0,
          output: result.stdout,
          error: result.exitCode !== 0
            ? { code: "SANDBOX_EXEC_FAILED", context: { stderr: result.stderr, exitCode: result.exitCode }, recovery: "Check tool arguments" }
            : undefined,
        },
        timestamp: new Date().toISOString(),
      };

      await kv.enqueue(reply);
    } catch (e) {
      await this.sendStructuredError(msg.from, msg.id, {
        code: "SANDBOX_CREATE_FAILED",
        context: { tool: req.tool, message: (e as Error).message },
        recovery: "Check DENO_SANDBOX_API_TOKEN and Sandbox API availability",
      });
    }
  }

  /**
   * Build Deno code to execute a tool inside a Sandbox.
   */
  private buildSandboxCode(tool: string, args: Record<string, unknown>): string {
    switch (tool) {
      case "shell":
        return `
const cmd = new Deno.Command("sh", {
  args: ["-c", ${JSON.stringify(args.command || "")}],
  stdout: "piped", stderr: "piped",
});
const { stdout, stderr } = await cmd.output();
console.log(new TextDecoder().decode(stdout));
if (stderr.length > 0) console.error(new TextDecoder().decode(stderr));
`;
      case "read_file":
        return `console.log(await Deno.readTextFile(${JSON.stringify(args.path || "")}));`;
      case "write_file":
        return `await Deno.writeTextFile(${JSON.stringify(args.path || "")}, ${JSON.stringify(args.content || "")});
console.log("Written: ${args.path}");`;
      case "web_fetch": {
        const method = (args.method as string) || "GET";
        return `const r = await fetch(${JSON.stringify(args.url || "")}, { method: ${JSON.stringify(method)} });
console.log("HTTP " + r.status);
console.log(await r.text());`;
      }
      default:
        return `console.error("Unknown tool: ${tool}");`;
    }
  }

  // ── Inter-agent routing (ADR-006: A2A + peers check) ─

  private async handleAgentMessage(msg: BrokerMessage): Promise<void> {
    const payload = msg.payload as { targetAgent: string; instruction: string; data?: unknown };
    const kv = await this.getKv();

    // Vérifier les peers (fermé par défaut)
    const senderConfig = await kv.get<AgentPeerConfig>(["agents", msg.from, "config"]);
    const targetConfig = await kv.get<AgentPeerConfig>(["agents", payload.targetAgent, "config"]);

    // Sender doit avoir target dans ses peers
    const senderPeers = senderConfig.value?.peers || [];
    if (!senderPeers.includes(payload.targetAgent) && !senderPeers.includes("*")) {
      await this.sendStructuredError(msg.from, msg.id, {
        code: "PEER_NOT_ALLOWED",
        context: { from: msg.from, to: payload.targetAgent, senderPeers },
        recovery: `Add "${payload.targetAgent}" to ${msg.from}.peers`,
      });
      return;
    }

    // Target doit accepter de sender
    const targetAccept = targetConfig.value?.acceptFrom || [];
    if (!targetAccept.includes(msg.from) && !targetAccept.includes("*")) {
      await this.sendStructuredError(msg.from, msg.id, {
        code: "PEER_REJECTED",
        context: { from: msg.from, to: payload.targetAgent, targetAcceptFrom: targetAccept },
        recovery: `Add "${msg.from}" to ${payload.targetAgent}.acceptFrom`,
      });
      return;
    }

    const forwarded: BrokerMessage = {
      id: generateId(),
      from: msg.from,
      to: payload.targetAgent,
      type: "agent_message",
      payload: { instruction: payload.instruction, data: payload.data },
      timestamp: new Date().toISOString(),
    };

    // Check if target agent is on a remote instance (via instance tunnel)
    const remoteTunnel = this.findTunnelForAgent(payload.targetAgent);
    if (remoteTunnel) {
      remoteTunnel.send(JSON.stringify(forwarded));
      log.info(`A2A routé via tunnel instance : ${msg.from} → ${payload.targetAgent}`);
      return;
    }

    // Local agent — route via KV Queue
    await kv.enqueue(forwarded);
    log.info(`A2A routé local : ${msg.from} → ${payload.targetAgent}`);
  }

  // ── Tunnel management ───────────────────────────────

  private findTunnelForProvider(_model: string): WebSocket | null {
    // CLI providers now run on the agent's VPS, not via tunnel.
    // Tunnels are for tools and instance-to-instance routing.
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

  private findTunnelForAgent(agentId: string): WebSocket | null {
    for (const [_, t] of this.tunnels) {
      if (t.capabilities.type === "instance" && t.capabilities.agents?.includes(agentId)) {
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
            const caps: TunnelCapabilities = {
              tunnelId,
              type: data.tunnelType || "local",
              tools: data.tools || [],
              supportsAuth: data.supportsAuth || false,
              agents: data.agents || [],
              allowedAgents: data.allowedAgents || [],
            };
            this.tunnels.set(tunnelId, { ws: socket, capabilities: caps });
            log.info(`Tunnel enregistré : ${tunnelId} (type: ${caps.type}, tools: ${caps.tools}, agents: ${caps.agents || []})`);
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
    await this.sendStructuredError(to, requestId, {
      code: "BROKER_ERROR",
      context: { message },
      recovery: "Check broker logs",
    });
  }

  private async sendStructuredError(
    to: string,
    requestId: string,
    error: { code: string; context?: Record<string, unknown>; recovery?: string },
  ): Promise<void> {
    const kv = await this.getKv();
    const reply: BrokerMessage = {
      id: requestId,
      from: "broker",
      to,
      type: "error",
      payload: error,
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
