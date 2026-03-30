import { log } from "../shared/log.ts";
import type {
  WorkerAskApprovalMessage,
  WorkerRequest,
} from "./worker_protocol.ts";
import type { AgentWorker, WorkerPoolCallbacks } from "./worker_pool_types.ts";

export interface WorkerPoolApprovalBridgeDeps {
  getAgent(agentId: string): AgentWorker | undefined;
  onAskApproval?: WorkerPoolCallbacks["onAskApproval"];
}

export class WorkerPoolApprovalBridge {
  constructor(private readonly deps: WorkerPoolApprovalBridgeDeps) {}

  async handleAskApproval(
    agentId: string,
    msg: WorkerAskApprovalMessage,
  ): Promise<void> {
    const entry = this.deps.getAgent(agentId);
    if (!entry) return;

    let approved = false;
    let allowAlways = false;

    if (this.deps.onAskApproval) {
      try {
        const result = await this.deps.onAskApproval(
          agentId,
          msg.requestId,
          msg.command,
          msg.binary,
          msg.reason,
        );
        approved = result.approved;
        allowAlways = result.allowAlways ?? false;
      } catch {
        log.debug(`Ask approval callback failed for ${agentId}, denying`);
      }
    } else {
      log.warn(
        `No onAskApproval callback — denying command '${msg.binary}' for agent ${agentId}`,
      );
    }

    const response: WorkerRequest = {
      type: "ask_response",
      requestId: msg.requestId,
      approved,
      allowAlways,
    };
    entry.worker.postMessage(response);
  }
}
