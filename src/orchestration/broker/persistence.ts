import type { Task } from "../../messaging/a2a/types.ts";
import { DenoClawError } from "../../shared/errors.ts";
import type { AgentEntry } from "../../shared/types.ts";

export interface ApprovalGrant {
  kind: "approval";
  approved: true;
  command: string;
  binary: string;
  grantedAt: string;
}

export type PendingResumes = Record<string, ApprovalGrant>;

export interface BrokerTaskMetadata {
  submittedBy?: string;
  targetAgent?: string;
  request?: Record<string, unknown>;
  pendingResumes?: PendingResumes;
}

export interface BrokerTaskPersistenceDeps {
  getKv(): Promise<Deno.Kv>;
}

export class BrokerTaskPersistence {
  constructor(private readonly deps: BrokerTaskPersistenceDeps) {}

  async writeTask(task: Task): Promise<void> {
    const kv = await this.deps.getKv();
    await kv.set(["a2a_tasks", task.id], task);
  }

  async persistTaskMetadata(
    task: Task,
    brokerMetadata: BrokerTaskMetadata,
  ): Promise<Task> {
    const nextTask: Task = {
      ...task,
      metadata: {
        ...(task.metadata ?? {}),
        broker: brokerMetadata,
      },
    };
    await this.writeTask(nextTask);
    return nextTask;
  }

  getTaskBrokerMetadata(task: Task): BrokerTaskMetadata {
    const metadata = task.metadata?.broker;
    return typeof metadata === "object" && metadata !== null
      ? (metadata as BrokerTaskMetadata)
      : {};
  }

  getPendingResumes(brokerMetadata: BrokerTaskMetadata): PendingResumes {
    return brokerMetadata.pendingResumes ?? {};
  }

  async consumeApprovedTaskResume(
    taskId: string,
    command: string,
  ): Promise<boolean> {
    const kv = await this.deps.getKv();
    const entry = await kv.get<Task>(["a2a_tasks", taskId]);
    if (!entry.value) return false;

    const brokerMetadata = this.getTaskBrokerMetadata(entry.value);
    const pendingResumes = this.getPendingResumes(brokerMetadata);
    const grantKey = pendingResumes[command]?.approved === true
      ? command
      : pendingResumes["*"]?.approved === true
      ? "*"
      : null;
    if (!grantKey) return false;

    const nextResumes = { ...pendingResumes };
    delete nextResumes[grantKey];
    const nextTask: Task = {
      ...entry.value,
      metadata: {
        ...(entry.value.metadata ?? {}),
        broker: { ...brokerMetadata, pendingResumes: nextResumes },
      },
    };

    const result = await kv
      .atomic()
      .check(entry)
      .set(["a2a_tasks", taskId], nextTask)
      .commit();
    return result.ok;
  }

  async assertPeerAccess(
    fromAgentId: string,
    targetAgentId: string,
  ): Promise<void> {
    const kv = await this.deps.getKv();

    const senderConfig = await kv.get<AgentEntry>([
      "agents",
      fromAgentId,
      "config",
    ]);
    const targetConfig = await kv.get<AgentEntry>([
      "agents",
      targetAgentId,
      "config",
    ]);

    const senderPeers = senderConfig.value?.peers || [];
    if (!senderPeers.includes(targetAgentId) && !senderPeers.includes("*")) {
      throw new DenoClawError(
        "PEER_NOT_ALLOWED",
        { from: fromAgentId, to: targetAgentId, senderPeers },
        `Add "${targetAgentId}" to ${fromAgentId}.peers`,
      );
    }

    const targetAccept = targetConfig.value?.acceptFrom || [];
    if (!targetAccept.includes(fromAgentId) && !targetAccept.includes("*")) {
      throw new DenoClawError(
        "PEER_REJECTED",
        {
          from: fromAgentId,
          to: targetAgentId,
          targetAcceptFrom: targetAccept,
        },
        `Add "${fromAgentId}" to ${targetAgentId}.acceptFrom`,
      );
    }
  }
}
