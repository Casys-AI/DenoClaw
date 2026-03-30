import { getIdToken, supportsIssuingIdTokens } from "@deno/oidc";
import type { AgentEntry, BrokerEnvelope } from "../shared/types.ts";
import type { AgentConfig } from "./types.ts";
import { AgentRuntime } from "./runtime.ts";
import { BrokerClient } from "../orchestration/client.ts";
import { WebSocketBrokerTransport } from "../orchestration/transport.ts";
import { DenoClawError } from "../shared/errors.ts";
import { log } from "../shared/log.ts";

export interface DeployedAgentRuntimeOptions {
  agentId: string;
  entry: AgentEntry;
}

export async function startDeployedAgentRuntime(
  options: DeployedAgentRuntimeOptions,
): Promise<void> {
  const agentId = Deno.env.get("DENOCLAW_AGENT_ID") || options.agentId;
  const brokerUrl = getRequiredBrokerUrl();
  const oidcAudience = Deno.env.get("DENOCLAW_BROKER_OIDC_AUDIENCE") ||
    brokerUrl;
  const runtimeConfig = resolveRuntimeConfig(agentId, options.entry);

  let runtime: AgentRuntime | null = null;

  const brokerTransport = new WebSocketBrokerTransport(agentId, {
    brokerUrl,
    config: options.entry,
    getAuthToken: async () =>
      await resolveBrokerAuthToken({ brokerUrl, oidcAudience }),
    onBrokerMessage: async (message) => {
      if (!runtime) {
        throw new DenoClawError(
          "AGENT_RUNTIME_NOT_READY",
          { agentId, messageType: message.type },
          "Retry after the deployed agent runtime finishes booting",
        );
      }
      await runtime.handleIncomingMessage(message as BrokerEnvelope);
    },
  });

  const broker = new BrokerClient(agentId, { transport: brokerTransport });
  runtime = new AgentRuntime(agentId, runtimeConfig, broker, broker);
  await runtime.start();

  Deno.serve((req) => handleDeployedAgentRequest(req, agentId, runtime));
  log.info(`Deployed agent runtime started: ${agentId}`);
}

function resolveRuntimeConfig(agentId: string, entry: AgentEntry): AgentConfig {
  if (!entry.model) {
    throw new DenoClawError(
      "AGENT_MODEL_MISSING",
      { agentId },
      "Published agent entry is missing a model",
    );
  }

  return {
    model: entry.model,
    ...(entry.temperature !== undefined
      ? { temperature: entry.temperature }
      : {}),
    ...(entry.maxTokens !== undefined ? { maxTokens: entry.maxTokens } : {}),
    ...(entry.systemPrompt ? { systemPrompt: entry.systemPrompt } : {}),
  };
}

async function handleDeployedAgentRequest(
  req: Request,
  agentId: string,
  runtime: AgentRuntime,
): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname === "/health") {
    return Response.json({
      ok: true,
      agentId,
      transport: "http-wake-up + websocket",
    });
  }

  if (req.method === "POST" && url.pathname === "/tasks") {
    if (!isAuthorizedBrokerWakeUp(req)) {
      return Response.json(
        {
          error: {
            code: "UNAUTHORIZED",
            recovery:
              "Add Authorization: Bearer <token> matching the agent token",
          },
        },
        { status: 401 },
      );
    }

    let msg: BrokerEnvelope;
    try {
      msg = await req.json() as BrokerEnvelope;
    } catch {
      return Response.json(
        {
          error: {
            code: "INVALID_TASK_PAYLOAD",
            recovery: "POST a canonical broker task JSON payload",
          },
        },
        { status: 400 },
      );
    }

    void runtime.handleIncomingMessage(msg).catch((error) => {
      log.error("Deployed agent task handling failed", error);
    });

    return Response.json({ ok: true, accepted: true }, { status: 202 });
  }

  if (req.method === "GET" && url.pathname === "/") {
    return new Response(`DenoClaw Agent: ${agentId}`);
  }

  return new Response("Not Found", { status: 404 });
}

async function resolveBrokerAuthToken(input: {
  brokerUrl: string;
  oidcAudience: string;
}): Promise<string> {
  if (supportsIssuingIdTokens()) {
    try {
      return await getIdToken(input.oidcAudience);
    } catch (error) {
      log.warn("OIDC token issuance failed, falling back to static token", {
        brokerUrl: input.brokerUrl,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const staticToken = Deno.env.get("DENOCLAW_BROKER_TOKEN") ||
    Deno.env.get("DENOCLAW_API_TOKEN");
  if (staticToken) {
    return staticToken;
  }

  throw new DenoClawError(
    "BROKER_AUTH_MISSING",
    { brokerUrl: input.brokerUrl },
    "Set DENOCLAW_BROKER_TOKEN or DENOCLAW_API_TOKEN, or enable OIDC",
  );
}

function getRequiredBrokerUrl(): string {
  const brokerUrl = Deno.env.get("DENOCLAW_BROKER_URL");
  if (!brokerUrl) {
    throw new DenoClawError(
      "BROKER_URL_MISSING",
      {},
      "Set DENOCLAW_BROKER_URL in the deployed agent environment",
    );
  }
  return brokerUrl;
}

function isAuthorizedBrokerWakeUp(req: Request): boolean {
  const configuredToken = Deno.env.get("DENOCLAW_API_TOKEN");
  if (!configuredToken) {
    return true;
  }

  const auth = req.headers.get("authorization");
  return auth === `Bearer ${configuredToken}`;
}
