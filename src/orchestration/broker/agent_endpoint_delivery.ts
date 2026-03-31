import { ConfigError, DenoClawError } from "../../shared/errors.ts";
import type {
  BrokerMessage,
  BrokerTaskContinueMessage,
  BrokerTaskSubmitMessage,
} from "../types.ts";

type BrokerAgentHttpMessage =
  | BrokerMessage
  | BrokerTaskSubmitMessage
  | BrokerTaskContinueMessage;

export async function postBrokerMessageToAgentEndpoint(
  endpoint: string,
  message: BrokerAgentHttpMessage,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const token = Deno.env.get("DENOCLAW_API_TOKEN");
  const response = await fetchFn(new URL("/tasks", endpoint), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(message),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ConfigError(
      "AGENT_ENDPOINT_DELIVERY_FAILED",
      {
        endpoint,
        status: response.status,
        body: body.slice(0, 300),
        target: message.to,
        messageType: message.type,
      },
      "Check agent deployment health and broker registration",
    );
  }
}

export function createAgentRouteUnavailableError(
  fromId: string,
  targetId: string,
  messageType: BrokerMessage["type"],
): DenoClawError {
  return new DenoClawError(
    "AGENT_ROUTE_UNAVAILABLE",
    {
      fromAgentId: fromId,
      targetAgentId: targetId,
      messageType,
    },
    "Ensure the target agent has an active socket, tunnel, or registered HTTP endpoint",
  );
}
