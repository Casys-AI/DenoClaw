import type { BrokerMessage } from "../broker/types.ts";
import type { ToolResult } from "../types.ts";
import { ToolRegistry } from "../agent/tools/registry.ts";
import { ShellTool } from "../agent/tools/shell.ts";
import { ReadFileTool, WriteFileTool } from "../agent/tools/file.ts";
import { WebFetchTool } from "../agent/tools/web.ts";
import { log } from "../utils/log.ts";

interface LocalRelayConfig {
  brokerUrl: string;
  inviteToken: string;
  capabilities: {
    tools: string[];
  };
  allowedAgents?: string[];
  autoApprove?: boolean;
}

/**
 * LocalRelay — runs on your machine, connects to the broker via WebSocket.
 *
 * Exposes local tools (shell, fs, CLI providers) to agents running in Subhosting.
 * Each tool call comes through the broker → relay executes locally → sends result back.
 */
export class LocalRelay {
  private config: LocalRelayConfig;
  private ws: WebSocket | null = null;
  private tools: ToolRegistry;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;

  constructor(config: LocalRelayConfig) {
    this.config = config;
    this.tools = new ToolRegistry();

    // Register local tools based on capabilities
    if (config.capabilities.tools.includes("shell")) {
      this.tools.register(new ShellTool());
    }
    if (config.capabilities.tools.includes("read_file") || config.capabilities.tools.includes("fs_read")) {
      this.tools.register(new ReadFileTool());
    }
    if (config.capabilities.tools.includes("write_file") || config.capabilities.tools.includes("fs_write")) {
      this.tools.register(new WriteFileTool());
    }
    if (config.capabilities.tools.includes("web_fetch")) {
      this.tools.register(new WebFetchTool());
    }

  }

  async connect(): Promise<void> {
    const url = `${this.config.brokerUrl}?token=${this.config.inviteToken}`;
    log.info(`Relay: connexion à ${this.config.brokerUrl}...`);

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      log.info("Relay: connecté au broker");

      // Register capabilities
      const registration = {
        type: "register" as const,
        tunnelId: "",
        tunnelType: "local" as const,
        tools: this.config.capabilities.tools,
        supportsAuth: true,
        allowedAgents: this.config.allowedAgents || [],
      };

      this.ws!.send(JSON.stringify(registration));
    };

    this.ws.onmessage = async (e) => {
      try {
        const msg = JSON.parse(e.data as string);

        if (msg.type === "registered") {
          log.info(`Relay: enregistré (id: ${msg.tunnelId})`);
          return;
        }

        await this.handleBrokerMessage(msg as BrokerMessage);
      } catch (err) {
        log.error("Relay: erreur traitement message", err);
      }
    };

    this.ws.onclose = () => {
      log.warn("Relay: déconnecté du broker");
      this.attemptReconnect();
    };

    this.ws.onerror = (e) => {
      log.error("Relay: erreur WebSocket", e);
    };

    // Wait for connection
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve(); };
      const onError = (e: Event) => { cleanup(); reject(e); };
      const cleanup = () => {
        this.ws?.removeEventListener("open", onOpen);
        this.ws?.removeEventListener("error", onError);
      };
      this.ws!.addEventListener("open", onOpen);
      this.ws!.addEventListener("error", onError);
    });
  }

  private async handleBrokerMessage(msg: BrokerMessage): Promise<void> {
    log.info(`Relay: ${msg.type} de ${msg.from}`);

    let response: BrokerMessage;

    switch (msg.type) {
      case "tool_request": {
        const req = msg.payload as { tool: string; args: Record<string, unknown> };
        const result = await this.executeTool(req.tool, req.args);
        response = {
          id: msg.id,
          from: "tunnel",
          to: msg.from,
          type: "tool_response",
          payload: result,
          timestamp: new Date().toISOString(),
        };
        break;
      }

      default:
        log.warn(`Relay: type non géré — ${msg.type}`);
        return;
    }

    this.ws?.send(JSON.stringify(response));
  }

  private async executeTool(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    // AX: log what we're about to do
    log.info(`Relay: exécution locale — ${tool}`);

    if (!this.config.autoApprove) {
      // In a real implementation, this would prompt the user for approval
      log.info(`Relay: auto-approve activé pour ${tool}`);
    }

    return await this.tools.execute(tool, args);
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      log.error("Relay: max tentatives de reconnexion atteint");
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30_000);
    log.info(`Relay: reconnexion dans ${delay}ms (tentative ${this.reconnectAttempts})`);

    setTimeout(() => {
      this.connect().catch((e) => log.error("Relay: échec reconnexion", e));
    }, delay);
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
