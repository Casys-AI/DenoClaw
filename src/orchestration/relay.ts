import type { BrokerMessage } from "./types.ts";
import type { SandboxPermission, ToolResult } from "../shared/types.ts";
import { ToolRegistry } from "../agent/tools/registry.ts";
import { ShellTool } from "../agent/tools/shell.ts";
import { ReadFileTool, WriteFileTool } from "../agent/tools/file.ts";
import { WebFetchTool } from "../agent/tools/web.ts";
import { log } from "../shared/log.ts";
import {
  createTunnelRegisterMessage,
  DENOCLAW_TUNNEL_PROTOCOL,
  parseTunnelControlMessage,
  WS_BUFFERED_AMOUNT_HIGH_WATERMARK,
} from "./tunnel_protocol.ts";

interface LocalRelayConfig {
  brokerUrl: string;
  inviteToken: string;
  capabilities: {
    tools: string[];
  };
  allowedAgents?: string[];
  autoApprove?: boolean;
}

type DenoWebSocketWithHeaders = {
  new (
    url: string,
    options: {
      headers: Record<string, string>;
      protocols: string[];
    },
  ): WebSocket;
};

export function buildRelaySocketOptions(authToken: string): {
  headers: Record<string, string>;
  protocols: string[];
} {
  return {
    headers: {
      authorization: `Bearer ${authToken}`,
    },
    protocols: [DENOCLAW_TUNNEL_PROTOCOL],
  };
}

export function resolveRelayAuthToken(
  inviteToken: string,
  sessionToken?: string | null,
): string {
  return sessionToken ?? inviteToken;
}

export function assertRelaySocketWritable(
  socket: Pick<WebSocket, "readyState" | "bufferedAmount">,
): void {
  if (socket.readyState !== WebSocket.OPEN) {
    throw new Error("Relay WebSocket is not open");
  }
  if (socket.bufferedAmount > WS_BUFFERED_AMOUNT_HIGH_WATERMARK) {
    throw new Error("Relay WebSocket send buffer is saturated");
  }
}

export function buildRelayRegistrationMessage(input: {
  tools: string[];
  toolPermissions?: Record<string, SandboxPermission[]>;
  allowedAgents?: string[];
}) {
  return createTunnelRegisterMessage({
    tunnelType: "local",
    tools: input.tools,
    toolPermissions: input.toolPermissions,
    allowedAgents: input.allowedAgents,
  });
}

function createRelaySocket(
  url: string,
  authToken: string,
): WebSocket {
  const DenoWebSocket = WebSocket as unknown as DenoWebSocketWithHeaders;
  return new DenoWebSocket(url, buildRelaySocketOptions(authToken));
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
  private sessionToken: string | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;

  constructor(config: LocalRelayConfig) {
    this.config = config;
    this.tools = new ToolRegistry();

    // Register local tools based on capabilities
    if (config.capabilities.tools.includes("shell")) {
      this.tools.register(new ShellTool());
    }
    if (
      config.capabilities.tools.includes("read_file") ||
      config.capabilities.tools.includes("fs_read")
    ) {
      this.tools.register(new ReadFileTool());
    }
    if (
      config.capabilities.tools.includes("write_file") ||
      config.capabilities.tools.includes("fs_write")
    ) {
      this.tools.register(new WriteFileTool());
    }
    if (config.capabilities.tools.includes("web_fetch")) {
      this.tools.register(new WebFetchTool());
    }
  }

  async connect(): Promise<void> {
    const url = this.config.brokerUrl;
    const authToken = resolveRelayAuthToken(
      this.config.inviteToken,
      this.sessionToken,
    );
    log.info(`Relay: connexion à ${this.config.brokerUrl}...`);

    this.ws = createRelaySocket(url, authToken);

    this.ws.onopen = () => {
      if (this.ws?.protocol !== DENOCLAW_TUNNEL_PROTOCOL) {
        log.error(
          `Relay: subprotocol invalide (attendu ${DENOCLAW_TUNNEL_PROTOCOL}, reçu ${
            this.ws?.protocol || "aucun"
          })`,
        );
        this.ws?.close(1002, "Expected denoclaw tunnel subprotocol");
        return;
      }

      this.reconnectAttempts = 0;
      log.info(`Relay: connecté au broker (${this.ws.protocol})`);

      const registration = buildRelayRegistrationMessage({
        tools: this.config.capabilities.tools,
        toolPermissions: this.tools.getToolPermissions(),
        allowedAgents: this.config.allowedAgents || [],
      });
      this.sendJson(registration);
    };

    this.ws.onmessage = async (e) => {
      try {
        if (typeof e.data !== "string") {
          this.ws?.close(1003, "Tunnel control frames must be text JSON");
          throw new Error("Relay: broker sent a non-text tunnel frame");
        }

        const raw = JSON.parse(e.data);
        const control = parseTunnelControlMessage(raw);
        if (control) {
          if (control.type === "session_token") {
            this.sessionToken = control.token;
            log.info(
              `Relay: session token reçu (expire: ${control.expiresAt})`,
            );
            return;
          }

          log.info(
            `Relay: enregistré (id: ${control.tunnelId}, protocol: ${
              this.ws?.protocol || "unknown"
            })`,
          );
          return;
        }

        await this.handleBrokerMessage(raw as BrokerMessage);
      } catch (err) {
        log.error("Relay: erreur traitement message", err);
      }
    };

    this.ws.onclose = (e) => {
      log.warn(
        `Relay: déconnecté du broker (code=${e.code}, reason=${
          e.reason || "none"
        })`,
      );
      this.attemptReconnect();
    };

    this.ws.onerror = (e) => {
      log.error("Relay: erreur WebSocket", e);
    };

    // Wait for connection
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (e: Event) => {
        cleanup();
        reject(e);
      };
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
        const req = msg.payload as {
          tool: string;
          args: Record<string, unknown>;
        };
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

    this.sendJson(response);
  }

  private async executeTool(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    if (this.config.autoApprove) {
      log.info(`Relay: exécution locale (auto-approve) — ${tool}`);
    } else {
      // TODO: implémenter le prompt interactif d'approbation
      log.warn(`Relay: manual approval not implemented, executing — ${tool}`);
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
    log.info(
      `Relay: reconnexion dans ${delay}ms (tentative ${this.reconnectAttempts})`,
    );

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

  private sendJson(payload: unknown): void {
    if (!this.ws) {
      throw new Error("Relay WebSocket is not initialized");
    }
    assertRelaySocketWritable(this.ws);
    this.ws.send(JSON.stringify(payload));
  }
}
