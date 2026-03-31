import type { Task } from "../../messaging/a2a/types.ts";
import type { TaskState } from "../../messaging/a2a/types.ts";
import type { ChannelAddress } from "../../messaging/types.ts";
import { DenoClawError } from "../../shared/errors.ts";
import {
  filterActivePrivilegeElevationGrants,
  getPrivilegeElevationGrantSignature,
  type PrivilegeElevationGrant,
} from "../../shared/privilege_elevation.ts";
import type { AgentEntry } from "../../shared/types.ts";
import type { ChannelDeliveryMode } from "../channel_routing/types.ts";

export interface BrokerTaskMetadata {
  submittedBy?: string;
  delivery?: ChannelDeliveryMode;
  targetAgent?: string;
  // Delegation lineage between broker/A2A tasks.
  parentTaskId?: string;
  // Shared human-ingress grouping for explicit broadcast routes.
  targetAgentIds?: string[];
  sharedTaskId?: string;
  request?: Record<string, unknown>;
  privilegeElevationGrants?: PrivilegeElevationGrant[];
  channel?: BrokerTaskChannelMetadata;
  shared?: BrokerSharedTaskMetadata;
}

export interface BrokerTaskChannelMetadata {
  channelType: string;
  sessionId: string;
  userId: string;
  address: ChannelAddress;
}

export interface BrokerSharedTaskMetadata {
  agentTasks: BrokerAgentTaskRef[];
}

export interface BrokerAgentTaskRef {
  agentId: string;
  taskId: string;
  state: TaskState;
}

export interface BrokerTaskPersistenceDeps {
  getKv(): Promise<Deno.Kv>;
}

export class BrokerTaskPersistence {
  constructor(private readonly deps: BrokerTaskPersistenceDeps) {}

  private static readonly MAX_CONTEXT_GRANT_APPEND_RETRIES = 64;

  private contextPrivilegeElevationGrantKey(
    agentId: string,
    contextId: string,
  ): Deno.KvKey {
    return ["a2a_contexts", agentId, contextId, "privilege_elevation_grants"];
  }

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

  getPrivilegeElevationGrants(
    brokerMetadata: BrokerTaskMetadata,
  ): PrivilegeElevationGrant[] {
    return filterActivePrivilegeElevationGrants(
      brokerMetadata.privilegeElevationGrants ?? [],
    );
  }

  async getTaskPrivilegeElevationGrants(
    taskId: string,
  ): Promise<PrivilegeElevationGrant[]> {
    const kv = await this.deps.getKv();
    const entry = await kv.get<Task>(["a2a_tasks", taskId]);
    if (!entry.value) return [];

    const brokerMetadata = this.getTaskBrokerMetadata(entry.value);
    return this.getPrivilegeElevationGrants(brokerMetadata);
  }

  async getTaskContextId(taskId: string): Promise<string | undefined> {
    const kv = await this.deps.getKv();
    const entry = await kv.get<Task>(["a2a_tasks", taskId]);
    return entry.value?.contextId;
  }

  async getTaskBrokerMetadataById(taskId: string): Promise<BrokerTaskMetadata> {
    const kv = await this.deps.getKv();
    const entry = await kv.get<Task>(["a2a_tasks", taskId]);
    if (!entry.value) return {};
    return this.getTaskBrokerMetadata(entry.value);
  }

  async getContextPrivilegeElevationGrants(
    agentId: string,
    contextId: string,
  ): Promise<PrivilegeElevationGrant[]> {
    const kv = await this.deps.getKv();
    const entry = await kv.get<PrivilegeElevationGrant[]>(
      this.contextPrivilegeElevationGrantKey(agentId, contextId),
    );
    return filterActivePrivilegeElevationGrants(entry.value ?? []);
  }

  async appendContextPrivilegeElevationGrant(
    agentId: string,
    contextId: string,
    grant: PrivilegeElevationGrant,
  ): Promise<void> {
    const kv = await this.deps.getKv();
    const key = this.contextPrivilegeElevationGrantKey(agentId, contextId);

    for (
      let attempt = 0;
      attempt < BrokerTaskPersistence.MAX_CONTEXT_GRANT_APPEND_RETRIES;
      attempt++
    ) {
      const entry = await kv.get<PrivilegeElevationGrant[]>(key);
      const grants = filterActivePrivilegeElevationGrants(entry.value ?? []);
      const result = await kv.atomic().check(entry).set(key, [
        ...grants,
        grant,
      ]).commit();
      if (result.ok) {
        return;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(32, 2 ** Math.min(attempt, 5)))
      );
    }

    throw new DenoClawError(
      "PRIVILEGE_ELEVATION_GRANT_APPEND_CONFLICT",
      { agentId, contextId },
      "Retry the privilege elevation resume; the broker could not persist the session grant atomically",
    );
  }

  async consumeOnceTaskPrivilegeElevationGrants(
    taskId: string,
    usedGrantSignatures: string[],
  ): Promise<boolean> {
    if (usedGrantSignatures.length === 0) return true;

    const kv = await this.deps.getKv();
    const entry = await kv.get<Task>(["a2a_tasks", taskId]);
    if (!entry.value) return false;

    const brokerMetadata = this.getTaskBrokerMetadata(entry.value);
    const grants = this.getPrivilegeElevationGrants(brokerMetadata);
    if (grants.length === 0) return true;

    const signatures = new Set(usedGrantSignatures);
    const keep = grants.filter((grant) =>
      grant.scope !== "once" ||
      !signatures.has(getPrivilegeElevationGrantSignature(grant))
    );
    if (keep.length === grants.length) {
      return true;
    }

    const nextTask: Task = {
      ...entry.value,
      metadata: {
        ...(entry.value.metadata ?? {}),
        broker: { ...brokerMetadata, privilegeElevationGrants: keep },
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
