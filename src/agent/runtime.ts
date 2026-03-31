import type {
  AgentCanonicalTaskPort,
  AgentLlmToolPort,
  BrokerEnvelope,
} from "../shared/types.ts";
import { DenoClawError } from "../shared/errors.ts";
import type { AgentConfig } from "./types.ts";
import type { MemoryPort } from "./memory_port.ts";
import type { Task } from "../messaging/a2a/types.ts";
import {
  extractContinuationTaskMessage,
  extractSubmitTaskMessage,
} from "./runtime_transport.ts";
import {
  createCanonicalTask,
  transitionTask,
} from "../messaging/a2a/internal_contract.ts";
import { mapTaskErrorToTerminalStatus } from "../messaging/a2a/task_mapping.ts";
import { KvdexMemory } from "./memory_kvdex.ts";
import { ContextBuilder } from "./context.ts";
import { SkillsLoader } from "./skills.ts";
import { CronManager } from "./cron.ts";
import { log } from "../shared/log.ts";
import {
  assertRuntimeTaskMessage,
  isRuntimeTaskMessage,
  type RuntimeTaskContinueMessage,
  type RuntimeTaskSubmitMessage,
} from "./runtime_transport.ts";
import { executeAgentConversation } from "./runtime_conversation.ts";
import {
  extractApprovedPrivilegeElevationGrant,
  extractRuntimeTaskText,
} from "./runtime_message_mapping.ts";
import type { AgentRuntimeCapabilities } from "./runtime_capabilities.ts";
import { AgentRuntimeGrantStore } from "./runtime_capabilities.ts";

/**
 * AgentRuntime — runs inside a deployed agent app or local worker.
 *
 * HTTP-reactive, task-oriented runtime:
 * - Receives work via handleIncomingMessage() (transport-agnostic)
 * - Calls LLM via AgentBrokerPort (never directly)
 * - Dispatches tool execution to Sandbox (via AgentBrokerPort)
 * - Persists state via MemoryPort (KvdexMemory by default)
 *
 * Transport is decided by the caller: HTTP handler in a deployed agent app,
 * KV Queue listener in local mode. The runtime does not assume any
 * specific transport mechanism.
 */

export class AgentRuntime {
  private agentId: string;
  private config: AgentConfig;
  private llmToolPort: AgentLlmToolPort;
  private canonicalTaskPort: AgentCanonicalTaskPort<Task>;
  private kv: Deno.Kv | null = null;
  private context: ContextBuilder;
  private skills: SkillsLoader;
  private cron!: CronManager;
  private maxIterations: number;
  private memories: Map<string, MemoryPort> = new Map();

  constructor(
    agentId: string,
    config: AgentConfig,
    llmToolPort: AgentLlmToolPort,
    canonicalTaskPort: AgentCanonicalTaskPort<Task>,
    maxIterations = 10,
    runtimeCapabilities?: AgentRuntimeCapabilities,
  ) {
    this.agentId = agentId;
    this.config = config;
    this.llmToolPort = llmToolPort;
    this.canonicalTaskPort = canonicalTaskPort;
    this.context = new ContextBuilder(config, runtimeCapabilities);
    this.skills = new SkillsLoader();
    this.maxIterations = maxIterations;
  }

  private async getKv(): Promise<Deno.Kv> {
    if (!this.kv) this.kv = await Deno.openKv();
    return this.kv;
  }

  private async getMemory(sessionId: string): Promise<MemoryPort> {
    let mem = this.memories.get(sessionId);
    if (!mem) {
      mem = new KvdexMemory(this.agentId, sessionId);
      await mem.load();
      this.memories.set(sessionId, mem);
    }
    return mem;
  }

  async start(): Promise<void> {
    log.info(`AgentRuntime started: ${this.agentId}`);

    await this.skills.loadSkills();
    await this.llmToolPort.startListening();

    const kv = await this.getKv();
    this.cron = new CronManager(kv);

    await this.cron.heartbeat(async () => {
      log.debug(`Heartbeat: ${this.agentId}`);
      const kv = await this.getKv();
      await kv.set(["agents", this.agentId, "status"], {
        status: "alive",
        lastHeartbeat: new Date().toISOString(),
      });
    }, 5);

    await kv.set(["agents", this.agentId, "status"], {
      status: "running",
      startedAt: new Date().toISOString(),
      model: this.config.model,
    });
  }

  /**
   * Start receiving work via KV Queue (local mode convenience).
   * In a deployed agent app, call handleIncomingMessage() from the HTTP
   * handler instead.
   */
  async startKvQueueIntake(): Promise<void> {
    const kv = await this.getKv();
    kv.listenQueue(async (raw: unknown) => {
      const msg = raw as BrokerEnvelope;
      if (msg.to !== this.agentId) return;
      if (!isRuntimeTaskMessage(msg)) return;
      await this.handleIncomingMessage(msg);
    });
    log.info(`AgentRuntime: KV Queue intake started (${this.agentId})`);
  }

  /**
   * Handle an incoming broker message (transport-agnostic).
   * Called by KV Queue listener locally, or HTTP handler in a deployed agent
   * app.
   */
  async handleIncomingMessage(msg: BrokerEnvelope): Promise<void> {
    assertRuntimeTaskMessage(msg);

    try {
      switch (msg.type) {
        case "task_submit":
          await this.handleTaskSubmitMessage(msg);
          break;
        case "task_continue":
          await this.handleTaskContinueMessage(msg);
          break;
      }
    } catch (e) {
      log.error("handleIncomingMessage failed", e);
      const payload = msg.payload as { taskId?: string } | undefined;
      const taskId = payload?.taskId;
      if (taskId) {
        try {
          const existing = await this.canonicalTaskPort.getTask(taskId);
          if (existing) {
            const failed = mapTaskErrorToTerminalStatus(existing, e);
            await this.canonicalTaskPort.reportTaskResult(failed);
          }
        } catch (reportErr) {
          log.error(
            "Failed to report terminal FAILED state for task",
            reportErr,
          );
        }
      }
    }
  }

  private async handleTaskSubmitMessage(
    msg: RuntimeTaskSubmitMessage,
  ): Promise<void> {
    const payload = msg.payload;
    const taskMessage = extractSubmitTaskMessage(payload);
    const inputText = extractRuntimeTaskText(taskMessage);
    log.info(
      `Canonical task received from ${msg.from}: ${inputText.slice(0, 100)}`,
    );

    await executeAgentConversation({
      config: this.config,
      llmToolPort: this.llmToolPort,
      context: this.context,
      skills: this.skills,
      memory: await this.getMemory(`agent:${msg.from}:${this.agentId}`),
      fromAgentId: msg.from,
      inputText,
      canonicalTask: createCanonicalTask({
        id: payload.taskId,
        contextId: payload.contextId,
        initialMessage: taskMessage,
      }),
      getRuntimeGrants: undefined,
      reportWorkingTransition: true,
      maxIterations: this.maxIterations,
      reportTaskResult: (task) => this.reportCanonicalTaskResult(task),
    });
  }

  private async handleTaskContinueMessage(
    msg: RuntimeTaskContinueMessage,
  ): Promise<void> {
    const payload = msg.payload;
    const continuationMessage = extractContinuationTaskMessage(payload);
    const existing = await this.canonicalTaskPort.getTask(payload.taskId);
    if (!existing) {
      throw new DenoClawError(
        "TASK_NOT_FOUND",
        { taskId: payload.taskId },
        "Broker-backed continuation received unknown task",
      );
    }

    const resumed = transitionTask(existing, "WORKING", {
      statusMessage: continuationMessage,
    });
    resumed.history = [...existing.history, continuationMessage];
    await this.reportCanonicalTaskResult(resumed);

    const inputText = extractRuntimeTaskText(continuationMessage);
    const runtimeGrantStore = new AgentRuntimeGrantStore();
    const approvedPrivilegeGrant = extractApprovedPrivilegeElevationGrant(
      existing,
      payload,
    );
    if (approvedPrivilegeGrant) {
      runtimeGrantStore.grantPrivilegeElevation({
        scope: approvedPrivilegeGrant.scope,
        grants: approvedPrivilegeGrant.grants,
        source: approvedPrivilegeGrant.source,
        grantedAt: approvedPrivilegeGrant.grantedAt,
      });
    }
    log.info(
      `Canonical continuation received from ${msg.from}: ${
        inputText.slice(0, 100)
      }`,
    );

    await executeAgentConversation({
      config: this.config,
      llmToolPort: this.llmToolPort,
      context: this.context,
      skills: this.skills,
      memory: await this.getMemory(`agent:${msg.from}:${this.agentId}`),
      fromAgentId: msg.from,
      inputText,
      canonicalTask: resumed,
      getRuntimeGrants: () => runtimeGrantStore.list(),
      reportWorkingTransition: false,
      maxIterations: this.maxIterations,
      reportTaskResult: (task) => this.reportCanonicalTaskResult(task),
    });
  }

  private async reportCanonicalTaskResult(task: Task): Promise<void> {
    await this.canonicalTaskPort.reportTaskResult(task);
  }

  async stop(): Promise<void> {
    this.cron.close();
    this.llmToolPort.close();
    for (const mem of this.memories.values()) {
      mem.close();
    }
    this.memories.clear();
    if (this.kv) {
      await this.kv.set(["agents", this.agentId, "status"], {
        status: "stopped",
        stoppedAt: new Date().toISOString(),
      });
      this.kv.close();
      this.kv = null;
    }
    log.info(`AgentRuntime stopped: ${this.agentId}`);
  }
}
