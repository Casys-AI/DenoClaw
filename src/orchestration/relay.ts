import { parseBrokerMessage, type BrokerMessage } from "./types.ts";
import type {
  SandboxPermission,
  ShellConfig,
  ToolResult,
} from "../shared/types.ts";
import { log } from "../shared/log.ts";
import {
  createTunnelRegisterMessage,
  DENOCLAW_TUNNEL_PROTOCOL,
  parseTunnelControlMessage,
  WS_BUFFERED_AMOUNT_HIGH_WATERMARK,
} from "./tunnel_protocol.ts";
import type { ToolExecutionPort } from "./tool_execution_port.ts";
import { LocalToolExecutionAdapter } from "./adapters/tool_execution_local.ts";

interface LocalRelayConfig {
  brokerUrl: string;
  inviteToken: string;
  capabilities: {
    tools: string[];
  };
  allowedAgents?: string[];
  autoApprove?: boolean;
}

interface LocalRelayDeps {
  toolExecution?: ToolExecutionPort;
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

export function describeRelayExecutionMode(
  autoApprove = true,
): string {
  return autoApprove
    ? "Relay: local execution (auto-approve)"
    : "Relay: approval is broker-controlled; executing broker-approved request";
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
 * Exposes local tools (shell, fs, CLI providers) to agents running in deployed
 * agent apps.
 * Each tool call comes through the broker → relay executes locally → sends result back.
 */
export class LocalRelay {
  private config: LocalRelayConfig;
  private ws: WebSocket | null = null;
  private toolExecution: ToolExecutionPort;
  private sessionToken: string | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;

  constructor(config: LocalRelayConfig, deps?: LocalRelayDeps) {
    this.config = config;
    this.toolExecution = deps?.toolExecution ??
      LocalToolExecutionAdapter.forRelay(config.capabilities.tools);
  }

  async connect(): Promise<void> {
    const url = this.config.brokerUrl;
    const authToken = resolveRelayAuthToken(
      this.config.inviteToken,
      this.sessionToken,
    );
    log.info(`Relay: connecting to ${this.config.brokerUrl}...`);

    this.ws = createRelaySocket(url, authToken);

    this.ws.onopen = () => {
      if (this.ws?.protocol !== DENOCLAW_TUNNEL_PROTOCOL) {
        log.error(
          `Relay: invalid subprotocol (expected ${DENOCLAW_TUNNEL_PROTOCOL}, received ${
            this.ws?.protocol || "none"
          })`,
        );
        this.ws?.close(1002, "Expected denoclaw tunnel subprotocol");
        return;
      }

      this.reconnectAttempts = 0;
      log.info(`Relay: connected to broker (${this.ws.protocol})`);

      const registration = buildRelayRegistrationMessage({
        tools: this.config.capabilities.tools,
        toolPermissions: this.toolExecution.getToolPermissions(),
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
              `Relay: session token received (expires: ${control.expiresAt})`,
            );
            return;
          }

          log.info(
            `Relay: registered (id: ${control.tunnelId}, protocol: ${
              this.ws?.protocol || "unknown"
            })`,
          );
          return;
        }

        await this.handleBrokerMessage(parseBrokerMessage(raw));
      } catch (err) {
        log.error("Relay: message handling error", err);
      }
    };

    this.ws.onclose = (e) => {
      log.warn(
        `Relay: disconnected from broker (code=${e.code}, reason=${
          e.reason || "none"
        })`,
      );
      this.attemptReconnect();
    };

    this.ws.onerror = (e) => {
      log.error("Relay: WebSocket error", e);
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
    log.info(`Relay: ${msg.type} from ${msg.from}`);

    let response: BrokerMessage;

    switch (msg.type) {
      case "tool_request": {
        const req = msg.payload as {
          tool: string;
          args: Record<string, unknown>;
          execution?: { shell?: ShellConfig };
        };
        const result = await this.executeTool(
          req.tool,
          req.args,
          req.execution,
        );
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
        log.warn(`Relay: unhandled type — ${msg.type}`);
        return;
    }

    this.sendJson(response);
  }

  private async executeTool(
    tool: string,
    args: Record<string, unknown>,
    execution?: { shell?: ShellConfig },
  ): Promise<ToolResult> {
    log.info(
      `${describeRelayExecutionMode(this.config.autoApprove)} — ${tool}`,
    );

    return await this.toolExecution.executeTool({
      tool,
      args,
      shell: execution?.shell,
    });
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      log.error("Relay: maximum reconnect attempts reached");
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30_000);
    log.info(
      `Relay: reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`,
    );

    setTimeout(() => {
      this.connect().catch((e) => log.error("Relay: reconnect failed", e));
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
