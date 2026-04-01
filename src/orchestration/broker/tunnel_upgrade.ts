import type { AuthManager } from "../auth.ts";
import {
  type FederationService,
  mapInstanceTunnelToCatalog,
} from "../federation/mod.ts";
import type { TunnelCapabilities } from "../types.ts";
import type { TunnelRegistry } from "./tunnel_registry.ts";
import {
  assertTunnelRegisterMessage,
  DENOCLAW_TUNNEL_PROTOCOL,
  getAcceptedTunnelProtocol,
  TUNNEL_IDLE_TIMEOUT_SECONDS,
} from "../tunnel_protocol.ts";
import { log } from "../../shared/log.ts";

function extractBearerToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice(7);
}

export interface BrokerTunnelUpgradeContext {
  tunnelRegistry: TunnelRegistry;
  getAuth(): Promise<AuthManager>;
  getFederationService(): Promise<FederationService>;
  handleTunnelMessage(tunnelId: string, data: string): Promise<void>;
}

export async function handleBrokerTunnelUpgrade(
  ctx: BrokerTunnelUpgradeContext,
  req: Request,
): Promise<Response> {
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket", { status: 426 });
  }

  const bearerToken = extractBearerToken(req);
  const negotiatedProtocol = getAcceptedTunnelProtocol(
    req.headers.get("sec-websocket-protocol"),
  );
  if (!negotiatedProtocol) {
    return new Response(
      `Expected WebSocket subprotocol: ${DENOCLAW_TUNNEL_PROTOCOL}`,
      { status: 426 },
    );
  }

  const auth = await ctx.getAuth();

  if (!bearerToken) {
    return Response.json(
      {
        error: {
          code: "UNAUTHORIZED",
          recovery:
            "Add Authorization: Bearer <invite-or-session-token> header",
        },
      },
      { status: 401 },
    );
  }

  const inviteResult = await auth.verifyInviteToken(bearerToken);
  const sessionResult = inviteResult.ok
    ? inviteResult
    : await auth.verifySessionToken(bearerToken);
  if (!sessionResult.ok) {
    return Response.json(
      {
        error: {
          code: "AUTH_FAILED",
          recovery: "Reconnect with a valid tunnel invite or session token",
        },
      },
      { status: 401 },
    );
  }

  const { socket, response } = Deno.upgradeWebSocket(req, {
    protocol: negotiatedProtocol,
    idleTimeout: TUNNEL_IDLE_TIMEOUT_SECONDS,
  });
  const tunnelId = sessionResult.identity;

  ctx.tunnelRegistry.setPending(tunnelId, socket);

  socket.onopen = async () => {
    log.info(`Tunnel connected: ${tunnelId} (${negotiatedProtocol})`);

    try {
      const session = await auth.generateSessionToken(tunnelId);
      socket.send(
        JSON.stringify({
          type: "session_token",
          token: session.token,
          expiresAt: session.expiresAt,
        }),
      );
    } catch (e) {
      log.error(`Failed to generate session token for tunnel ${tunnelId}`, e);
      socket.send(
        JSON.stringify({
          type: "error",
          code: "SESSION_TOKEN_FAILED",
          recovery: "Reconnect",
        }),
      );
      socket.close(1011, "Session token generation failed");
    }
  };

  socket.onmessage = async (event) => {
    try {
      if (typeof event.data !== "string") {
        socket.close(1003, "Tunnel messages must be text JSON");
        return;
      }

      const data = JSON.parse(event.data);
      const entry = ctx.tunnelRegistry.get(tunnelId);
      if (!entry) {
        socket.close(1011, "Tunnel state missing");
        return;
      }

      if (!entry.registered) {
        const registration = assertTunnelRegisterMessage(data);
        const caps: TunnelCapabilities = {
          tunnelId,
          type: registration.tunnelType,
          tools: registration.tools,
          toolPermissions: registration.toolPermissions,
          agents: registration.agents,
          allowedAgents: registration.allowedAgents,
        };
        ctx.tunnelRegistry.register(tunnelId, socket, caps);
        if (caps.type === "instance") {
          const service = await ctx.getFederationService();
          const identity = await service.getIdentity(tunnelId);
          if (!identity || identity.status !== "trusted") {
            log.warn(
              `Tunnel ${tunnelId}: catalog sync rejected — broker identity not trusted (status: ${identity?.status ?? "unknown"})`,
            );
          } else {
            await service.syncCatalog(
              tunnelId,
              mapInstanceTunnelToCatalog(tunnelId, caps),
              {
                remoteBrokerId: tunnelId,
                traceId: crypto.randomUUID(),
              },
            );
          }
        }
        log.info(
          `Tunnel registered: ${tunnelId} (type: ${caps.type}, tools: ${caps.tools}, agents: ${
            caps.agents || []
          }, protocol: ${socket.protocol})`,
        );
        socket.send(JSON.stringify({ type: "registered", tunnelId }));
        return;
      }

      if (
        typeof data === "object" &&
        data !== null &&
        "type" in data &&
        data.type === "register"
      ) {
        socket.close(1002, "Tunnel is already registered");
        return;
      }

      await ctx.handleTunnelMessage(tunnelId, event.data as string);
    } catch (err) {
      log.error(`Tunnel error ${tunnelId}`, err);
      socket.close(1002, "Invalid tunnel control message");
    }
  };

  socket.onclose = () => {
    ctx.tunnelRegistry.delete(tunnelId);
    log.info(`Tunnel disconnected: ${tunnelId}`);
  };

  return response;
}
