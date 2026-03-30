import type { BrokerFederationMessage, BrokerMessage } from "../types.ts";
import type { StructuredError } from "../../shared/types.ts";
import { log } from "../../shared/log.ts";
import type { BrokerFederationRuntime } from "./federation_runtime.ts";
import type { BrokerLlmProxy } from "./llm_proxy.ts";
import type { BrokerReplyDispatcher } from "./reply_dispatch.ts";
import type { BrokerTaskDispatcher } from "./task_dispatch.ts";
import type { BrokerToolDispatcher } from "./tool_dispatch.ts";

export interface BrokerMessageRuntimeDeps {
  llmProxy: BrokerLlmProxy;
  toolDispatcher: BrokerToolDispatcher;
  replyDispatcher: BrokerReplyDispatcher;
  taskDispatcher: BrokerTaskDispatcher;
  federationRuntime: BrokerFederationRuntime;
  sendStructuredError: (
    to: string,
    requestId: string,
    error: StructuredError,
  ) => Promise<void>;
}

export class BrokerMessageRuntime {
  constructor(private readonly deps: BrokerMessageRuntimeDeps) {}

  async handleIncomingMessage(msg: BrokerMessage): Promise<void> {
    if (msg.to !== "broker") return;
    await this.handleMessage(msg);
  }

  async handleMessage(msg: BrokerMessage): Promise<void> {
    log.info(`Broker: ${msg.type} from ${msg.from}`);

    try {
      switch (msg.type) {
        case "llm_request":
          await this.deps.llmProxy.handleRequest(msg);
          break;
        case "tool_request":
          await this.deps.toolDispatcher.handleToolRequest(msg);
          break;
        case "task_submit":
          await this.deps.replyDispatcher.sendTaskResult(
            msg.from,
            msg.id,
            await this.deps.taskDispatcher.submitAgentTask(
              msg.from,
              msg.payload,
            ),
          );
          break;
        case "task_get":
          await this.deps.replyDispatcher.sendTaskResult(
            msg.from,
            msg.id,
            await this.deps.taskDispatcher.getTask(msg.payload),
          );
          break;
        case "task_continue":
          await this.deps.replyDispatcher.sendTaskResult(
            msg.from,
            msg.id,
            await this.deps.taskDispatcher.continueAgentTask(
              msg.from,
              msg.payload,
            ),
          );
          break;
        case "task_cancel":
          await this.deps.replyDispatcher.sendTaskResult(
            msg.from,
            msg.id,
            await this.deps.taskDispatcher.cancelTask(msg.payload),
          );
          break;
        case "task_result":
          await this.deps.replyDispatcher.sendTaskResult(
            msg.from,
            msg.id,
            await this.deps.taskDispatcher.recordTaskResult(
              msg.from,
              msg.payload,
            ),
          );
          break;
        case "federation_link_open":
        case "federation_link_ack":
        case "federation_catalog_sync":
        case "federation_route_probe":
        case "federation_link_close":
          await this.deps.federationRuntime.handleControlMessage(
            msg as BrokerFederationMessage,
          );
          break;
        default:
          log.warn(`Unknown message type: ${msg.type}`);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error(`Message handler failed for ${msg.type} from ${msg.from}`, err);
      try {
        await this.deps.sendStructuredError(msg.from, msg.id, {
          code: "BROKER_ERROR",
          context: {
            messageType: msg.type,
            from: msg.from,
            cause: err.message,
          },
          recovery: "Check broker logs for details",
        });
      } catch (sendErr) {
        log.error(
          "Failed to send error reply to agent (KV unavailable?)",
          sendErr,
        );
      }
    }
  }
}
