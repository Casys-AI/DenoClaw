import type { Task } from "../../messaging/a2a/types.ts";
import { log } from "../../shared/log.ts";
import type { StructuredError } from "../../shared/types.ts";
import type { BrokerMessage } from "../types.ts";

export interface BrokerReplyDispatcherDeps {
  getKv(): Promise<Deno.Kv>;
  findReplySocket(agentId: string): WebSocket | null;
  routeToTunnel(ws: WebSocket, msg: BrokerMessage): void;
}

export class BrokerReplyDispatcher {
  constructor(private readonly deps: BrokerReplyDispatcherDeps) {}

  async sendReply(reply: BrokerMessage): Promise<void> {
    const tunnel = this.deps.findReplySocket(reply.to);
    if (tunnel) {
      this.deps.routeToTunnel(tunnel, reply);
      return;
    }

    const kv = await this.deps.getKv();
    await kv.enqueue(reply);
    log.info(
      `Reponse routee via KV Queue : broker -> ${reply.to} (${reply.type})`,
    );
  }

  async sendTaskResult(
    to: string,
    requestId: string,
    task: Task | null,
  ): Promise<void> {
    await this.sendReply({
      id: requestId,
      from: "broker",
      to,
      type: "task_result",
      payload: { task },
      timestamp: new Date().toISOString(),
    });
  }

  async sendStructuredError(
    to: string,
    requestId: string,
    error: StructuredError,
  ): Promise<void> {
    await this.sendReply({
      id: requestId,
      from: "broker",
      to,
      type: "error",
      payload: error,
      timestamp: new Date().toISOString(),
    });
  }
}
