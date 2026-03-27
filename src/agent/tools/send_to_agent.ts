import type { SandboxPermission, ToolDefinition, ToolResult } from "../../shared/types.ts";
import { BaseTool } from "./registry.ts";
import { DenoClawError } from "../../shared/errors.ts";

/** Callback pour envoyer un message à un autre agent — transport-agnostic */
export type SendToAgentFn = (toAgent: string, message: string) => Promise<string>;

/**
 * SendToAgentTool — permet au LLM d'envoyer un message à un autre agent.
 * Le transport (postMessage local, HTTP deploy) est abstrait par le callback injecté.
 */
export class SendToAgentTool extends BaseTool {
  name = "send_to_agent";
  description = "Send a message to another agent and get their response. The system handles routing and validation — just provide the agent_id and message.";
  permissions: SandboxPermission[] = [];
  private availablePeers: string[];

  private sendFn: SendToAgentFn;

  constructor(sendFn: SendToAgentFn, availablePeers: string[] = []) {
    super();
    this.sendFn = sendFn;
    this.availablePeers = availablePeers;
  }

  getDefinition(): ToolDefinition {
    const agentIdProp: Record<string, unknown> = {
      type: "string",
      description: "The ID of the target agent to send the message to",
    };
    if (this.availablePeers.length > 0) {
      agentIdProp.enum = this.availablePeers;
      agentIdProp.description = `The target agent ID. Must be one of: ${this.availablePeers.join(", ")}`;
    }

    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: "object",
          properties: {
            agent_id: agentIdProp,
            message: {
              type: "string",
              description: "The message/instruction to send to the target agent",
            },
          },
          required: ["agent_id", "message"],
        },
      },
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const agentId = args.agent_id as string;
    const message = args.message as string;

    if (!agentId || typeof agentId !== "string") {
      return this.fail("INVALID_ARGS", { field: "agent_id" }, "Provide a valid agent_id string");
    }
    if (!message || typeof message !== "string") {
      return this.fail("INVALID_ARGS", { field: "message" }, "Provide a non-empty message string");
    }

    try {
      const response = await this.sendFn(agentId, message);
      return this.ok(response);
    } catch (err) {
      if (err instanceof DenoClawError) {
        return this.fail(err.code, { toAgent: agentId, ...err.context }, err.recovery);
      }
      const msg = err instanceof Error ? err.message : String(err);
      return this.fail("AGENT_SEND_FAILED", { toAgent: agentId, error: msg }, "Check agent ID and peer permissions");
    }
  }
}
