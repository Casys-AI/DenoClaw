import { generateId } from "../shared/helpers.ts";
import type { BrokerRequestMessage } from "./types.ts";

export function createBrokerRequestMessage(
  agentId: string,
  message: Omit<BrokerRequestMessage, "id" | "from" | "timestamp">,
): BrokerRequestMessage {
  return {
    ...message,
    id: generateId(),
    from: agentId,
    timestamp: new Date().toISOString(),
  } as BrokerRequestMessage;
}
