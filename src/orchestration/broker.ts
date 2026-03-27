import type { BrokerMessage, LLMRequest, ToolRequest, TunnelCapabilities } from "./types.ts";
import type { AgentEntry, SandboxPermission } from "../shared/types.ts";
import type { Config } from "../config/types.ts";
import type { BuiltinToolName } from "../agent/tools/types.ts";
import { BUILTIN_TOOL_PERMISSIONS } from "../agent/tools/types.ts";
import { AuthManager } from "./auth.ts";
import { ProviderManager } from "../llm/manager.ts";
import { SandboxManager } from "./sandbox.ts";
import { MetricsCollector } from "../telemetry/metrics.ts";
import { ConfigError, DenoClawError } from "../shared/errors.ts";
import { generateId } from "../shared/helpers.ts";
import { log } from "../shared/log.ts";

/**
 * Broker server — runs on Deno Deploy.
 *
 * Responsibilities:
 * - LLM Proxy (API keys + CLI tunnel routing)
 * - Message routing between agents (KV Queues)
 * - Tunnel hub (WebSocket connections to local machines)
 * - Agent lifecycle (Subhosting + Sandbox CRUD)
 */
export interface BrokerServerDeps {
  providers?: ProviderManager;
  sandbox?: SandboxManager;
  metrics?: MetricsCollector;
}

export class BrokerServer {
  private config: Config;
  private auth!: AuthManager;
  private providers: ProviderManager;
  private sandbox: SandboxManager;
  private metrics: MetricsCollector;
  private kv: Deno.Kv | null = null;
  private tunnels = new Map<string, { ws: WebSocket; capabilities: TunnelCapabilities; sessionToken?: string }>();
  private httpServer?: Deno.HttpServer;

  constructor(config: Config, deps?: BrokerServerDeps) {
    this.config = config;
    this.providers = deps?.providers ?? new ProviderManager(config.providers);
    this.sandbox = deps?.sandbox ?? new SandboxManager();
    this.metrics = deps?.metrics ?? new MetricsCollector();
  }

  private async getKv(): Promise<Deno.Kv> {
    if (!this.kv) {
      try {
        this.kv = await Deno.openKv();
      } catch (e) {
        throw new ConfigError(
          "KV_UNAVAILABLE",
          { cause: (e instanceof Error ? e : new Error(String(e))).message },
          "Check Deno Deploy KV permissions or quota",
        );
      }
    }
    return this.kv;
  }

  async start(port = 3000): Promise<void> {
    // Warning si pas de token configuré (ADR-003)
    if (!Deno.env.get("DENOCLAW_API_TOKEN")) {
      log.warn("DENOCLAW_API_TOKEN not set — broker running in unauthenticated mode. Do not use in production.");
    }

    const kv = await this.getKv();

    // Initialiser AuthManager avec le KV partagé (une seule connexion)
    this.auth = new AuthManager(kv);

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
      const err = e instanceof Error ? e : new Error(String(e));
      log.error(`Message handler failed for ${msg.type} from ${msg.from}`, err);
      try {
        await this.sendStructuredError(msg.from, msg.id, {
          code: "BROKER_ERROR",
          context: { messageType: msg.type, from: msg.from, cause: err.message },
          recovery: "Check broker logs for details",
        });
      } catch (sendErr) {
        log.error("Failed to send error reply to agent (KV unavailable?)", sendErr);
      }
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
    const start = performance.now();
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
    const latency = performance.now() - start;

    // Record metrics
    const provider = req.model.split("/")[0] || req.model;
    await this.metrics.recordLLMCall(msg.from, provider, {
      prompt: response.usage?.promptTokens || 0,
      completion: response.usage?.completionTokens || 0,
    }, latency);

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

  /** AX-8: permission check extracted as composable primitive */
  private async checkToolPermissions(
    agentId: string,
    tool: string,
  ): Promise<{ granted: SandboxPermission[]; denied: SandboxPermission[]; agentConfig: Deno.KvEntryMaybe<AgentEntry> }> {
    const kv = await this.getKv();
    const toolPerms = this.resolveToolPermissions(tool);
    const agentConfig = await kv.get<AgentEntry>(["agents", agentId, "config"]);
    const agentAllowed = agentConfig.value?.sandbox?.allowedPermissions || [];

    return {
      granted: toolPerms.filter((p) => agentAllowed.includes(p)),
      denied: toolPerms.filter((p) => !agentAllowed.includes(p)),
      agentConfig,
    };
  }

  private async handleToolRequest(msg: BrokerMessage): Promise<void> {
    const req = msg.payload as ToolRequest;

    // 1. Check permissions (intersection tool × agent) — deny by default (ADR-005)
    const { granted, denied, agentConfig } = await this.checkToolPermissions(msg.from, req.tool);

    if (denied.length > 0) {
      const toolPerms = this.resolveToolPermissions(req.tool);
      const agentAllowed = agentConfig.value?.sandbox?.allowedPermissions || [];
      await this.sendStructuredError(msg.from, msg.id, {
        code: "SANDBOX_PERMISSION_DENIED",
        context: { tool: req.tool, required: toolPerms, agentAllowed, denied },
        recovery: `Add ${JSON.stringify(denied)} to agent sandbox.allowedPermissions`,
      });
      return;
    }

    // 3. Try tunnel first (local tools)
    const toolStart = performance.now();
    const tunnel = this.findTunnelForTool(req.tool);
    if (tunnel) {
      await this.routeToTunnel(tunnel, msg);
      await this.metrics.recordToolCall(msg.from, req.tool, true, performance.now() - toolStart);
      return;
    }

    // 4. Execute in Sandbox (éphémère)
    try {
      const code = this.buildSandboxCode(req.tool, req.args);

      // networkAllow : agent-specific > defaults > [] (ADR-005)
      const agentNetwork = agentConfig.value?.sandbox?.networkAllow;
      const defaultNetwork = this.config.agents?.defaults?.sandbox?.networkAllow;
      const networkAllow = agentNetwork || defaultNetwork || [];

      const maxDuration = agentConfig.value?.sandbox?.maxDurationSec || this.config.agents?.defaults?.sandbox?.maxDurationSec || 30;

      log.info(`Sandbox: ${req.tool} avec permissions ${JSON.stringify(granted)}, network: ${JSON.stringify(networkAllow)}`);

      const result = await this.sandbox.run(code, {
        memoryMb: 256,
        timeoutSec: maxDuration,
        networkAllow,
      });

      const toolSuccess = result.exitCode === 0;
      await this.metrics.recordToolCall(msg.from, req.tool, toolSuccess, performance.now() - toolStart);

      const reply: BrokerMessage = {
        id: msg.id,
        from: "broker",
        to: msg.from,
        type: "tool_response",
        payload: {
          success: toolSuccess,
          output: result.stdout,
          error: !toolSuccess
            ? { code: "SANDBOX_EXEC_FAILED", context: { stderr: result.stderr, exitCode: result.exitCode }, recovery: "Check tool arguments" }
            : undefined,
        },
        timestamp: new Date().toISOString(),
      };

      const kv = await this.getKv();
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
   * Résout les permissions d'un outil (ADR-005).
   * Built-in map = source de vérité pour les outils connus.
   * Tunnel-advertised = pour les outils custom pas dans la map.
   */
  private isBuiltinTool(tool: string): tool is BuiltinToolName {
    return tool in BUILTIN_TOOL_PERMISSIONS;
  }

  private resolveToolPermissions(tool: string): SandboxPermission[] {
    // 1. Built-in map (source de vérité, non-overridable par un tunnel)
    if (this.isBuiltinTool(tool)) return [...BUILTIN_TOOL_PERMISSIONS[tool]];

    // 2. Tunnel-advertised (outils custom uniquement)
    for (const [_, t] of this.tunnels) {
      if (t.capabilities.toolPermissions?.[tool]) {
        return [...t.capabilities.toolPermissions[tool]];
      }
    }

    // 3. Deny by default — outil inconnu = aucune permission
    return [];
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
console.log("Written: " + ${JSON.stringify(String(args.path || ""))});`;
      case "web_fetch": {
        const method = (args.method as string) || "GET";
        return `const r = await fetch(${JSON.stringify(args.url || "")}, { method: ${JSON.stringify(method)} });
console.log("HTTP " + r.status);
console.log(await r.text());`;
      }
      default:
        return `console.error("Unknown tool: " + ${JSON.stringify(tool)}); Deno.exit(1);`;
    }
  }

  // ── Inter-agent routing (ADR-006: A2A + peers check) ─

  private async handleAgentMessage(msg: BrokerMessage): Promise<void> {
    const payload = msg.payload as { targetAgent: string; instruction: string; data?: unknown };
    const kv = await this.getKv();

    // Vérifier les peers (fermé par défaut)
    const senderConfig = await kv.get<AgentEntry>(["agents", msg.from, "config"]);
    const targetConfig = await kv.get<AgentEntry>(["agents", payload.targetAgent, "config"]);

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

    // Record A2A metrics
    await this.metrics.recordA2AMessage(msg.from, payload.targetAgent);

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

  private routeToTunnel(ws: WebSocket, msg: BrokerMessage): void {
    if (ws.readyState !== WebSocket.OPEN) {
      throw new DenoClawError("TUNNEL_NOT_OPEN", { readyState: ws.readyState, msgId: msg.id }, "Tunnel disconnected. Reconnect and retry.");
    }
    ws.send(JSON.stringify(msg));
  }

  private async handleTunnelMessage(tunnelId: string, data: string): Promise<void> {
    let msg: BrokerMessage;
    try {
      msg = JSON.parse(data) as BrokerMessage;
    } catch {
      log.error(`Malformed JSON from tunnel ${tunnelId}, message dropped`, { preview: data.slice(0, 200) });
      return;
    }
    try {
      const kv = await this.getKv();
      await kv.enqueue(msg);
    } catch (e) {
      log.error(`Failed to enqueue tunnel message from ${tunnelId}`, e);
    }
  }

  // ── HTTP + WebSocket (ADR-003: auth intégré) ───────

  private async handleHttp(req: Request): Promise<Response> {
    try {
      return await this.handleHttpInner(req);
    } catch (e) {
      log.error("Unhandled HTTP error", e);
      return Response.json(
        { error: { code: "INTERNAL_ERROR", recovery: "Check broker logs" } },
        { status: 500 },
      );
    }
  }

  private async handleHttpInner(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Root — public, pas d'auth
    if (url.pathname === "/") {
      return new Response("DenoClaw Broker");
    }

    // Health — public (monitoring)
    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        tunnels: [...this.tunnels.keys()],
        tunnelCount: this.tunnels.size,
      });
    }

    // Tunnel WebSocket — auth par invite token (ADR-003)
    if (url.pathname === "/tunnel") {
      return await this.handleTunnelUpgrade(req);
    }

    // Invite token generation — admin endpoint
    if (req.method === "POST" && url.pathname === "/auth/invite") {
      const authResult = await this.auth.checkRequest(req);
      if (!authResult.ok) {
        return Response.json({ error: { code: authResult.code, recovery: authResult.recovery } }, { status: 401 });
      }
      const body = await req.json().catch(() => ({})) as { tunnelId?: string };
      const invite = await this.auth.generateInviteToken(body.tunnelId);
      return Response.json({ token: invite.token, expiresAt: invite.expiresAt });
    }

    // Tous les autres endpoints nécessitent auth (ADR-003)
    const authResult = await this.auth.checkRequest(req);
    if (!authResult.ok) {
      return Response.json(
        { error: { code: authResult.code, recovery: authResult.recovery } },
        { status: 401 },
      );
    }

    // Stats endpoint — per-agent metrics
    if (url.pathname === "/stats") {
      const agentId = url.searchParams.get("agent");
      if (agentId) {
        return Response.json(await this.metrics.getAgentMetrics(agentId));
      }
      return Response.json(await this.metrics.getSummary());
    }

    // Detailed per-agent stats
    if (url.pathname === "/stats/agents") {
      return Response.json(await this.metrics.getAllMetrics());
    }

    return new Response("Not Found", { status: 404 });
  }

  private async handleTunnelUpgrade(req: Request): Promise<Response> {
    const upgrade = req.headers.get("upgrade") || "";
    if (upgrade.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const url = new URL(req.url);
    const inviteTokenParam = url.searchParams.get("token");

    // Vérifier le token d'invitation (ADR-003)
    if (inviteTokenParam) {
      const inviteResult = await this.auth.verifyInviteToken(inviteTokenParam);
      if (!inviteResult.ok) {
        return Response.json(
          { error: { code: inviteResult.code, recovery: inviteResult.recovery } },
          { status: 401 },
        );
      }
    } else {
      const authResult = await this.auth.checkRequest(req);
      if (!authResult.ok) {
        return Response.json(
          { error: { code: authResult.code, recovery: authResult.recovery } },
          { status: 401 },
        );
      }
    }

    const { socket, response } = Deno.upgradeWebSocket(req);
    const tunnelId = url.searchParams.get("id") || generateId();

    // Pré-créer l'entrée tunnel pour que onopen puisse y attacher le session token
    const placeholderCaps: TunnelCapabilities = {
      tunnelId,
      type: "local",
      tools: [],
      allowedAgents: [],
    };
    this.tunnels.set(tunnelId, { ws: socket, capabilities: placeholderCaps });

    socket.onopen = async () => {
      log.info(`Tunnel connecté : ${tunnelId}`);

      try {
        // Émettre un session token éphémère pour ce tunnel (ADR-003)
        const session = await this.auth.generateSessionToken(tunnelId);
        // Stocker le token pour révocation à la déconnexion
        const entry = this.tunnels.get(tunnelId);
        if (entry) {
          this.tunnels.set(tunnelId, { ...entry, sessionToken: session.token });
        }
        socket.send(JSON.stringify({ type: "session_token", token: session.token, expiresAt: session.expiresAt }));
      } catch (e) {
        log.error(`Failed to generate session token for tunnel ${tunnelId}`, e);
        socket.send(JSON.stringify({ type: "error", code: "SESSION_TOKEN_FAILED", recovery: "Reconnect" }));
        socket.close(1011, "Session token generation failed");
      }
    };

    socket.onmessage = async (e) => {
      try {
        const data = JSON.parse(e.data as string);

        // First message = capabilities registration (met à jour l'entrée placeholder)
        if (data.type === "register") {
          const caps: TunnelCapabilities = {
            tunnelId,
            type: data.tunnelType || "local",
            tools: data.tools || [],
            toolPermissions: data.toolPermissions,
            supportsAuth: data.supportsAuth || false,
            agents: data.agents || [],
            allowedAgents: data.allowedAgents || [],
          };
          const existing = this.tunnels.get(tunnelId);
          this.tunnels.set(tunnelId, { ws: socket, capabilities: caps, sessionToken: existing?.sessionToken });
          log.info(`Tunnel enregistré : ${tunnelId} (type: ${caps.type}, tools: ${caps.tools}, agents: ${caps.agents || []})`);
          socket.send(JSON.stringify({ type: "registered", tunnelId }));
          return;
        }

        // Otherwise = response to a routed request
        await this.handleTunnelMessage(tunnelId, e.data as string);
      } catch (err) {
        log.error(`Erreur tunnel ${tunnelId}`, err);
      }
    };

    socket.onclose = async () => {
      // Révoquer le session token (ADR-003)
      const tunnel = this.tunnels.get(tunnelId);
      if (tunnel?.sessionToken) {
        await this.auth.revokeSessionToken(tunnel.sessionToken);
      }
      this.tunnels.delete(tunnelId);
      log.info(`Tunnel déconnecté : ${tunnelId}`);
    };

    return response;
  }

  // ── Helpers ─────────────────────────────────────────

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
    for (const [tunnelId, t] of this.tunnels) {
      try {
        t.ws.close(1001, "Broker shutting down");
      } catch (e) {
        log.warn(`Failed to close tunnel ${tunnelId} cleanly`, e);
      }
    }
    this.tunnels.clear();
    if (this.kv) { this.kv.close(); this.kv = null; }
    log.info("Broker arrêté");
  }
}
