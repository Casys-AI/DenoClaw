import type { AuthManager } from "../auth.ts";
import type { BrokerMessage } from "../types.ts";
import { log } from "../../shared/log.ts";
import type { BrokerAgentRegistry } from "./agent_registry.ts";
import type { BrokerAgentSocketRegistry } from "./agent_socket_registry.ts";
import {
  DENOCLAW_AGENT_PROTOCOL,
  isAgentSocketRegisterMessage,
} from "../agent_socket_protocol.ts";
import { TUNNEL_IDLE_TIMEOUT_SECONDS } from "../tunnel_protocol.ts";

export interface BrokerAgentSocketUpgradeContext {
  connectedAgents: BrokerAgentSocketRegistry;
  agentRegistry: BrokerAgentRegistry;
  getAuth(): Promise<AuthManager>;
  handleIncomingMessage(msg: BrokerMessage): Promise<void>;
}

export async function handleBrokerAgentSocketUpgrade(
  ctx: BrokerAgentSocketUpgradeContext,
  req: Request,
): Promise<Response> {
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket", { status: 426 });
  }

  const requestedProtocols = (req.headers.get("sec-websocket-protocol") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!requestedProtocols.includes(DENOCLAW_AGENT_PROTOCOL)) {
    return new Response(
      `Expected WebSocket subprotocol: ${DENOCLAW_AGENT_PROTOCOL}`,
      { status: 426 },
    );
  }

  const auth = await ctx.getAuth();
  const authResult = await auth.checkRequest(req);
  if (!authResult.ok) {
    return Response.json(
      { error: { code: authResult.code, recovery: authResult.recovery } },
      { status: 401 },
    );
  }

  const { socket, response } = Deno.upgradeWebSocket(req, {
    protocol: DENOCLAW_AGENT_PROTOCOL,
    idleTimeout: TUNNEL_IDLE_TIMEOUT_SECONDS,
  });

  let registeredAgentId: string | null = null;

  socket.onmessage = (event) => {
    void (async () => {
      try {
        if (typeof event.data !== "string") {
          socket.close(1003, "Agent WebSocket frames must be text JSON");
          return;
        }

        const raw = JSON.parse(event.data);
        if (!registeredAgentId) {
          if (!isAgentSocketRegisterMessage(raw)) {
            socket.close(1002, "Expected register_agent as first message");
            return;
          }

          registeredAgentId = raw.agentId;
          ctx.connectedAgents.register(
            raw.agentId,
            socket,
            authResult.identity,
          );

          if (raw.config) {
            await ctx.agentRegistry.saveAgentConfig(raw.agentId, raw.config);
          }
          if (raw.endpoint) {
            await ctx.agentRegistry.saveAgentEndpoint(
              raw.agentId,
              raw.endpoint,
            );
          }

          socket.send(
            JSON.stringify({
              type: "registered_agent",
              agentId: raw.agentId,
            }),
          );
          log.info(`Agent socket registered: ${raw.agentId}`);
          return;
        }

        const msg = raw as BrokerMessage;
        msg.from = registeredAgentId;
        await ctx.handleIncomingMessage(msg);
      } catch (error) {
        log.error("Agent socket message handling failed", error);
        socket.close(1002, "Invalid agent socket message");
      }
    })();
  };

  socket.onclose = () => {
    if (registeredAgentId) {
      ctx.connectedAgents.unregisterIfCurrent(registeredAgentId, socket);
      log.info(`Agent socket disconnected: ${registeredAgentId}`);
    }
  };

  return response;
}
